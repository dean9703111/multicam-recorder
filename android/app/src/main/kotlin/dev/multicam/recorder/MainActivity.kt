package dev.multicam.recorder

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.drawable.Drawable
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.Settings
import android.util.Size
import android.view.PixelCopy
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.concurrent.thread
import kotlin.math.roundToInt

// 唯一的畫面：相機預覽加上狀態。錄影的開始和停止都由電腦控制。
// App 必須留在前景、螢幕不能關（Android 不讓背景 App 用相機），切到背景時會先把錄影正常收尾。
// 畫面跟著手機怎麼拿轉向，直拿錄直的、橫拿錄橫的。
class MainActivity : Activity(), ServerLink.Listener, CameraRecorder.Listener {
    private class Recording(
        val fileId: String,
        val file: File,
        val maxDurationSec: Int,
        val warnBeforeSec: Int,
        val orientation: String, // 開始時鎖住的方向
    ) {
        var startedAt = 0L // 手機時間；0 表示還沒到開始時間
        var stopping = false
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: Store
    private lateinit var link: ServerLink
    private lateinit var uploader: Uploader
    private lateinit var camera: CameraRecorder
    private lateinit var moviesDir: File

    private lateinit var nameView: TextView
    private lateinit var connectionView: TextView
    private lateinit var timerView: TextView
    private lateinit var micView: TextView
    private lateinit var uploadView: TextView
    private lateinit var guideView: GuideOverlay
    private lateinit var scanButton: Button
    private var scanBackground: Drawable? = null // 按鈕原本的樣子
    private var scanHighlight: Drawable? = null // 還沒配對時用的紅色版本（另外複製一份，原本的才不會被染色）
    private lateinit var dimButton: Button
    private lateinit var cleanButton: Button

    private var surface: Surface? = null
    private var cameraReady = false
    private var videoSize = Size(3840, 2160) // 預設 4K，收到電腦的設定後更新
    private var overlayPortrait = false // 目前的狀態列是不是直拿的版面

    // 錄影的方向在開始時就決定了，錄影中鎖住畫面方向，預覽和即時畫面才會跟錄的一樣。
    // 錄影中也攔下返回鍵和返回手勢：離開這個畫面，這一台的錄影就會中斷。
    private var recording: Recording? = null
        set(value) {
            field = value
            requestedOrientation =
                if (value != null) ActivityInfo.SCREEN_ORIENTATION_LOCKED else ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
            blockBack(value != null)
        }
    private val backWhileRecording = OnBackInvokedCallback { toast(getString(R.string.back_while_recording)) }
    private var backBlocked = false
    private val thermalListener = PowerManager.OnThermalStatusChangedListener { sendStatus() }
    private var recordingMic: AudioDeviceInfo? = null // 錄影中實際用的麥克風
    private var dimmed = false
    private var wifiLock: WifiManager.WifiLock? = null
    private var tick = 0
    private var disconnectedSince = SystemClock.elapsedRealtime() // 連不上太久就提示檢查網路
    private lateinit var previewView: SurfaceView

    // 即時畫面：電腦上有人在看時，大約每秒 5 張把預覽畫面縮成長邊 640 的 JPEG 送過去。
    // 用 PixelCopy 從預覽複製，不必在相機多開一路影像，錄影的設定不受影響。
    // PixelCopy 拿到的一律是手機在自然方向（一般手機是直拿）時正的畫面，所以照這個寬高複製，再依螢幕方向轉正。
    private val previewThread = HandlerThread("preview").apply { start() }
    private val previewHandler = Handler(previewThread.looper)
    private lateinit var previewBitmap: Bitmap
    private var previewOn = false

    // 接上或拔掉麥克風時，App 和電腦上顯示的收音來源跟著改
    private val audioDevices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            sendStatus()
            render()
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            sendStatus()
            render()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // 沒有後鏡頭的裝置（例如部分平板）沒辦法當攝影機：說明清楚再關掉，不要直接當掉
        if (!CameraRecorder.hasBackCamera(this)) {
            AlertDialog.Builder(this)
                .setMessage(R.string.no_camera)
                .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
                .setOnCancelListener { finish() }
                .show()
            return
        }

        store = Store(this)
        moviesDir = getExternalFilesDir(Environment.DIRECTORY_MOVIES)!!
        camera = CameraRecorder(this, this)
        videoSize = camera.videoSize(videoSize.width, videoSize.height)
        val natural = camera.naturalPreviewSize
        val scale = 640f / maxOf(natural.width, natural.height)
        previewBitmap = Bitmap.createBitmap(
            (natural.width * scale).roundToInt(),
            (natural.height * scale).roundToInt(),
            Bitmap.Config.ARGB_8888,
        )
        uploader = Uploader(store, ::languageTag) { main.post { render() } }
        val capabilities = JSONObject()
            .put("facePriority", camera.facePrioritySupported)
            .put("lockExposure", camera.lockSupported)
        link = ServerLink(store, this, capabilities, ::languageTag)

        guideView = findViewById(R.id.guide)
        bindOverlay()

        val preview = findViewById<SurfaceView>(R.id.preview)
        previewView = preview
        preview.holder.setFixedSize(camera.previewSize.width, camera.previewSize.height)
        preview.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                surface = holder.surface
                openCamera()
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                surface = null
                recording?.let { stopRecording(it.fileId, "error") } // 切到背景前先把檔案收尾
                camera.close()
            }
        })

        getSystemService(AudioManager::class.java).registerAudioDeviceCallback(audioDevices, main)
        getSystemService(PowerManager::class.java).addThermalStatusListener(thermalListener) // 手機太熱時電腦會提醒

        for (job in uploader.interrupted) {
            reportFailed(job.fileId, "appClosed", toast = false)
        }
        uploader.start()
        if (!hasPermissions()) requestPermissions(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO), 1)
        handleIntent(intent)
        link.connect()
        main.post(loop)
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        // 低延遲 Wi-Fi：開始錄影的指令比較準時送到
        wifiLock = applicationContext.getSystemService(WifiManager::class.java)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "recorder")
            .apply { acquire() }
    }

    override fun onPause() {
        super.onPause()
        wifiLock?.release()
        wifiLock = null
    }

    override fun onDestroy() {
        super.onDestroy()
        previewThread.quitSafely()
        if (!usable) return
        main.removeCallbacks(loop)
        main.removeCallbacks(capture)
        // 按返回鍵離開、或被系統重建（換語言、字體大小、深色模式）時，下次開啟的畫面會重新連線、接著上傳，
        // 這裡的要關掉：留著的話兩條連線會互相踢掉，兩個上傳也會同時傳同一支影片
        link.close()
        uploader.stop()
        getSystemService(AudioManager::class.java).unregisterAudioDeviceCallback(audioDevices)
        getSystemService(PowerManager::class.java).removeThermalStatusListener(thermalListener)
        camera.release()
    }

    // 沒有後鏡頭時，onCreate 只顯示說明，其他東西都沒有建立
    private val usable get() = ::camera.isInitialized

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // Android 13 起用 OnBackInvokedCallback；之前的版本（和沒有改用新做法的系統）走 onBackPressed
    private fun blockBack(on: Boolean) {
        if (on == backBlocked) return
        backBlocked = on
        if (Build.VERSION.SDK_INT < 33) return
        if (on) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backWhileRecording)
        else onBackInvokedDispatcher.unregisterOnBackInvokedCallback(backWhileRecording)
    }

    @Deprecated("Android 12 和舊的返回鍵還是走這裡")
    override fun onBackPressed() {
        if (recording != null) toast(getString(R.string.back_while_recording)) else super.onBackPressed()
    }

    // 轉向時只換狀態列的版面，相機預覽、錄影和連線都不受影響
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (!usable) return
        if ((newConfig.orientation == Configuration.ORIENTATION_PORTRAIT) != overlayPortrait) {
            val root = findViewById<FrameLayout>(R.id.root)
            root.removeView(findViewById(R.id.overlay))
            layoutInflater.inflate(R.layout.overlay, root, true)
            bindOverlay()
        }
        sendStatus() // 電腦上的監看區跟著換方向
        render()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (usable) handleIntent(intent)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (!usable) return
        if (hasPermissions()) openCamera() else toast(getString(R.string.need_permission))
    }

    // ---------- 電腦的指令 ----------

    override fun onConnectionChanged(connected: Boolean) {
        if (connected) {
            sendStatus()
        } else {
            disconnectedSince = SystemClock.elapsedRealtime()
            setPreview(false) // 連回來時電腦會再說要不要
        }
        render()
    }

    // 電腦斷線前會先送 error 訊息說明原因（已經被移除，或不認得這支手機），這裡不再另外提示
    override fun onUnpaired() {
        store.token = null
        render()
    }

    override fun onMessage(msg: JSONObject) {
        when (msg.optString("type")) {
            "welcome" -> {
                store.name = msg.optString("name")
                msg.optJSONObject("spec")?.let(::applySpec)
                if (msg.has("zoom")) setZoom(msg.getDouble("zoom"))
            }
            "config" -> applySpec(msg)
            "rename" -> store.name = msg.optString("name")
            "zoom" -> setZoom(msg.getDouble("ratio"))
            "preview" -> setPreview(msg.optBoolean("on"))
            "start" -> startRecording(msg)
            "stop" -> stopRecording(msg.getString("fileId"), "user")
            "error" -> toast(msg.optString("message"))
        }
        render()
    }

    // 超出範圍時相機會取最接近的值，回報實際的倍率
    private fun setZoom(ratio: Double) {
        camera.setZoom(ratio.toFloat())
        sendStatus()
        render()
    }

    // ---------- 即時畫面 ----------

    private fun setPreview(on: Boolean) {
        if (on == previewOn) return
        previewOn = on
        main.removeCallbacks(capture)
        if (on) main.post(capture)
    }

    // 一次只複製一張，送出後才排下一張
    private val capture = object : Runnable {
        override fun run() {
            if (!previewOn) return
            if (!cameraReady || surface == null) {
                main.postDelayed(this, PREVIEW_INTERVAL_MS)
                return
            }
            // 螢幕轉了幾度，複製出來的畫面就反方向轉回去，變成螢幕上看到的樣子
            val rotation = (360 - displayRotationDegrees()) % 360
            PixelCopy.request(previewView, previewBitmap, { result ->
                // 在 preview 執行緒轉正、壓縮，不卡畫面
                val jpeg = if (result == PixelCopy.SUCCESS) jpegOf(previewBitmap, rotation) else null
                main.post {
                    if (jpeg != null && previewOn) link.sendFrame(jpeg)
                    if (previewOn) main.postDelayed(this, PREVIEW_INTERVAL_MS)
                }
            }, previewHandler)
        }
    }

    private fun jpegOf(bitmap: Bitmap, rotation: Int): ByteArray {
        val upright = if (rotation == 0) {
            bitmap
        } else {
            val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, false)
        }
        val jpeg = ByteArrayOutputStream().also { upright.compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
        if (upright !== bitmap) upright.recycle()
        return jpeg
    }

    private fun applySpec(spec: JSONObject) {
        guideView.setGuide(spec.optString("guide", "none"))
        val requested = sizeOf(spec.optString("resolution")) ?: return
        videoSize = camera.videoSize(requested.width, requested.height)
        // 人像設定；舊版的電腦沒有送，就跟以前一樣不開
        if (recording == null) camera.configure(videoSize, spec.optBoolean("facePriority"))
    }

    private fun startRecording(msg: JSONObject) {
        val fileId = msg.getString("fileId")
        guideView.setGuide(msg.optString("guide", "none"))
        if (recording != null) return reportFailed(fileId, "busy")
        if (!cameraReady) return reportFailed(fileId, "cameraNotReady")
        val requested = sizeOf(msg.getString("resolution")) ?: return reportFailed(fileId, "unsupportedResolution")
        videoSize = camera.videoSize(requested.width, requested.height)
        if (videoSize != requested) {
            toast(getString(R.string.resolution_fallback, requested.width, requested.height, videoSize.width, videoSize.height))
        }

        val spec = CameraRecorder.Spec(
            videoSize, msg.getInt("fps"), msg.getInt("bitrate"), msg.getInt("maxDurationSec"), msg.optBoolean("lockExposure"),
        )
        val file = File(moviesDir, msg.getString("fileName"))
        val rec = Recording(fileId, file, spec.maxDurationSec, msg.optInt("warnBeforeSec", 180), orientationName())
        recording = rec // 從這裡開始鎖住方向，下面算的錄影方向才不會變
        val delay = (link.toLocalTime(msg.getLong("startAt")) - System.currentTimeMillis()).coerceAtLeast(0)
        val hint = camera.orientationHint(displayRotationDegrees())
        camera.start(file, spec, msg.optBoolean("facePriority"), hint, SystemClock.uptimeMillis() + delay) { result ->
            if (recording !== rec) {
                // 剛好在開始的那一刻取消了（已經回報取消）：錄起來的也不要，馬上停掉，不會留下沒人管的錄影
                if (result.isSuccess) camera.stop { file.delete() }
                return@start
            }
            result.onSuccess { started ->
                rec.startedAt = started.wallClockMs
                recordingMic = started.mic
                uploader.add(UploadJob(fileId, file.path)) // 開始邊錄邊傳
                link.send(
                    JSONObject().put("type", "recordingStarted").put("fileId", fileId)
                        .put("startedAt", link.toServerTime(started.wallClockMs))
                        .put("width", spec.size.width).put("height", spec.size.height) // 不支援時已經降級過
                        .put("orientation", rec.orientation)
                        .put("audioChannels", started.channels),
                    queueIfOffline = true,
                )
            }.onFailure { e ->
                if (recording === rec) recording = null
                file.delete()
                if (e is CameraRecorder.StartFailure) reportFailed(fileId, e.code) else reportFailed(fileId, "startFailed", e.message)
            }
            sendStatus()
            render()
        }
        sendStatus()
        render()
    }

    private fun stopRecording(fileId: String, reason: String) {
        val rec = recording ?: return
        if (rec.fileId != fileId || rec.stopping) return
        if (rec.startedAt == 0L) {
            camera.cancelPending()
            recording = null
            reportFailed(fileId, "cancelled", toast = false)
            render()
            return
        }
        rec.stopping = true
        camera.stop { result ->
            recording = null
            recordingMic = null
            val size = rec.file.length()
            if (result.isFailure || size == 0L) {
                uploader.drop(fileId)
                reportFailed(fileId, "notFinalized", result.exceptionOrNull()?.message)
            } else {
                val durationMs = durationOf(rec.file) ?: (System.currentTimeMillis() - rec.startedAt)
                // 先送停止訊息再讓上傳收尾，電腦才會記到停止原因
                link.send(
                    JSONObject().put("type", "recordingStopped").put("fileId", fileId).put("reason", reason)
                        .put("durationMs", durationMs).put("size", size),
                    queueIfOffline = true,
                )
                uploader.recordingFinished(fileId, size, durationMs)
            }
            sendStatus()
            render()
        }
    }

    // 用代碼回報（protocol.ts 的 FailureCode），電腦用自己的語言顯示；error 是給舊版電腦端看的
    private fun reportFailed(fileId: String, code: String, detail: String? = null, toast: Boolean = true) {
        val message = failureText(code, detail ?: "")
        link.send(
            JSONObject().put("type", "recordingFailed").put("fileId", fileId).put("error", message)
                .put("code", code).put("detail", detail ?: ""),
            queueIfOffline = true,
        )
        if (toast) toast(message)
    }

    private fun failureText(code: String, detail: String) = when (code) {
        "busy" -> getString(R.string.fail_busy)
        "cameraNotReady" -> getString(R.string.fail_camera_not_ready)
        "unsupportedResolution" -> getString(R.string.fail_unsupported_resolution)
        "cancelled" -> getString(R.string.fail_cancelled)
        "notFinalized" -> getString(R.string.fail_not_finalized, detail)
        "appClosed" -> getString(R.string.fail_app_closed)
        else -> getString(R.string.fail_start, detail)
    }

    // ---------- 相機的事件 ----------

    override fun onReadyChanged(ready: Boolean) {
        cameraReady = ready
        sendStatus()
        render()
    }

    override fun onMaxDurationReached() {
        recording?.let { stopRecording(it.fileId, "maxDuration") }
    }

    // 空間還很夠卻碰到上限，就是這支手機單一影片的大小上限（不少手機的 MediaRecorder 是 4 GB），不是空間滿了
    override fun onMaxFileSizeReached() {
        val rec = recording ?: return
        val free = runCatching { StatFs(moviesDir.path).availableBytes }.getOrDefault(0L)
        stopRecording(rec.fileId, if (free > CameraRecorder.FREE_SPACE_MARGIN + 500_000_000L) "fileSizeLimit" else "storageFull")
    }

    // 錄影中的音量，電腦用來顯示音量表、提醒沒有聲音或爆音
    override fun onAudioLevel(db: Double) {
        val rec = recording ?: return
        if (rec.startedAt == 0L) return
        link.send(JSONObject().put("type", "audio").put("level", (db * 10).roundToInt() / 10.0), queueIfOffline = false)
    }

    override fun onCameraError(message: String) {
        toast(message)
        recording?.let { stopRecording(it.fileId, "error") }
    }

    override fun onRecordingMic(mic: AudioDeviceInfo) {
        recordingMic = mic
        sendStatus()
        render()
    }

    // ---------- 配對 ----------

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode -> barcode.rawValue?.let(::pairFromQr) }
            .addOnFailureListener { e -> toast(getString(R.string.scan_failed, e.message)) }
    }

    // 用手機相機掃 QR Code 時，網頁上的按鈕會用 multicam://pair?server=…&code=… 打開 App。
    // 開發時也可以不用掃描：adb shell am start -n dev.multicam.recorder/.MainActivity --es qr '<QR Code 的網址>'
    private fun handleIntent(intent: Intent?) {
        // 從「最近使用的應用程式」開回來時，不要拿舊的配對碼重複配對
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val data = intent.data
        if (data?.scheme == "multicam" && data.host == "pair") {
            val server = data.getQueryParameter("server")
            val code = data.getQueryParameter("code")
            if (server.isNullOrEmpty() || code.isNullOrEmpty()) return toast(getString(R.string.pair_link_incomplete))
            // 任何網頁都能用這種連結打開 App，所以先讓使用者看清楚要連到哪台電腦，確認了才配對
            AlertDialog.Builder(this)
                .setTitle(R.string.pair_confirm_title)
                .setMessage(getString(R.string.pair_confirm_message, server.removePrefix("http://")))
                .setPositiveButton(R.string.pair_confirm_ok) { _, _ -> pair(server, code) }
                .setNegativeButton(R.string.cancel, null)
                .show()
            return
        }
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        intent.getStringExtra("qr")?.takeIf { debuggable }?.let(::pairFromQr)
    }

    // QR Code 的內容是 http://<電腦>:8787/pair?code=<配對碼>
    private fun pairFromQr(raw: String) {
        val uri = Uri.parse(raw)
        val code = runCatching { uri.getQueryParameter("code") }.getOrNull()
        if (uri.scheme != "http" || uri.path != "/pair" || code.isNullOrEmpty()) return toast(getString(R.string.not_pairing_qr))
        pair("http://${uri.encodedAuthority}", code)
    }

    private fun pair(url: String, code: String) {
        thread {
            val result = runCatching {
                val body = JSONObject().put("pair", code).put("deviceId", store.deviceId).put("model", Build.MODEL)
                    .toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                val request = Request.Builder().url("$url/api/pair").header("Accept-Language", languageTag()).post(body).build()
                OkHttpClient().newCall(request).execute().use { res ->
                    val json = JSONObject(res.body.string())
                    if (!res.isSuccessful) error(json.optString("error", "HTTP ${res.code}"))
                    json
                }
            }
            main.post {
                result.onSuccess { json ->
                    store.serverUrl = url
                    store.token = json.getString("deviceToken")
                    store.name = json.getString("name")
                    link.connect()
                    toast(getString(R.string.paired, store.name))
                }.onFailure { e -> showPairFailed(url, e) }
                render()
            }
        }
    }

    // 配對失敗：用不會自動消失的對話框說清楚可以怎麼做。連不到電腦時列出要檢查的地方；電腦回了錯誤（例如 QR Code 過期）就照它的說明。
    private fun showPairFailed(url: String, e: Throwable) {
        val message = if (e is java.io.IOException) {
            getString(R.string.pair_failed_network, url.removePrefix("http://")) + "\n\n" + getString(R.string.pair_failed_detail, e.message ?: e.javaClass.simpleName)
        } else {
            e.message ?: getString(R.string.pair_failed_network, url.removePrefix("http://"))
        }
        AlertDialog.Builder(this).setTitle(R.string.pair_failed_title).setMessage(message).setPositiveButton(android.R.string.ok, null).show()
    }

    // ---------- 狀態與畫面 ----------

    private val loop = object : Runnable {
        override fun run() {
            render()
            if (tick++ % 4 == 0) sendStatus() // 每 2 秒回報一次
            main.postDelayed(this, 500)
        }
    }

    private fun sendStatus() {
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.let {
            it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
        }
        val charging = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        val temperature = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0)?.div(10.0)
        link.send(
            JSONObject()
                .put("type", "status")
                .put("battery", level)
                .put("charging", charging)
                .put("temperatureC", temperature)
                .put("freeBytes", StatFs(moviesDir.path).availableBytes)
                .put("cameraReady", cameraReady)
                .put("recordingFileId", recording?.fileId ?: JSONObject.NULL)
                .put("audioSource", micDevice()?.let(camera::audioSource) ?: "builtin")
                .put("audioName", micDevice()?.takeIf { camera.audioSource(it) != "builtin" }?.productName?.toString() ?: JSONObject.NULL)
                .put("audioInput", micLabel()) // 舊版電腦端顯示的說明文字
                .put("zoom", camera.zoom.toDouble())
                .put("zoomRange", JSONArray().put(camera.zoomRange.lower.toDouble()).put(camera.zoomRange.upper.toDouble()))
                .put("orientation", orientationName())
                .put("thermal", getSystemService(PowerManager::class.java).currentThermalStatus),
            queueIfOffline = false,
        )
    }

    private fun orientationName() =
        if (resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT) "portrait" else "landscape"

    // 錄影中是實際用的那支；沒在錄時，有外接麥克風就是它，沒有就是手機內建
    private fun micDevice(): AudioDeviceInfo? = recordingMic ?: camera.externalMic()

    private fun micLabel(): String = micDevice()?.let(camera::describe) ?: getString(R.string.mic_builtin)

    // App 畫面上用的語言（不是手機的語言：簡體中文的手機顯示英文），電腦送來的訊息才會和畫面一致
    private fun languageTag(): String = getString(R.string.language_tag)

    // 狀態列的版面直拿、橫拿各一份（layout-port/overlay.xml），換版面後重新接上
    private fun bindOverlay() {
        overlayPortrait = resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        nameView = findViewById(R.id.name)
        connectionView = findViewById(R.id.connection)
        timerView = findViewById(R.id.timer)
        micView = findViewById(R.id.mic)
        uploadView = findViewById(R.id.upload)
        scanButton = findViewById<Button>(R.id.scan).apply { setOnClickListener { scan() } }
        scanBackground = scanButton.background
        scanHighlight = scanBackground?.constantState?.newDrawable(resources, theme)?.mutate()?.apply { setTintList(RED_TINT) }
        dimButton = findViewById<Button>(R.id.dim).apply {
            setOnClickListener { toggleDim() }
            setText(if (dimmed) R.string.undim else R.string.dim)
        }
        cleanButton = findViewById<Button>(R.id.clean).apply { setOnClickListener { confirmClean() } }
        uploadView.setOnClickListener { if (orphanFiles().isNotEmpty()) confirmSaveOrphans() }
        // 權限被拒絕過，系統就不會再問，只能到 App 的設定頁打開
        findViewById<View>(R.id.status).setOnClickListener {
            if (!hasPermissions()) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            }
        }
        // 避開瀏海和打孔鏡頭
        val overlay = findViewById<View>(R.id.overlay)
        val pad = overlay.paddingLeft
        overlay.setOnApplyWindowInsetsListener { v, insets ->
            val c = insets.getInsets(WindowInsets.Type.displayCutout() or WindowInsets.Type.systemBars())
            v.setPadding(pad + c.left, pad + c.top, pad + c.right, pad + c.bottom)
            insets
        }
        overlay.requestApplyInsets()
    }

    private fun render() {
        nameView.text = store.name ?: Build.MODEL
        val unpaired = store.token == null
        // 連不到電腦時寫出正在連的位址，可以和電腦上「手機會連到」的位址比對；連不到很久，多半是電腦的網路換了
        val address = store.serverUrl?.removePrefix("http://") ?: ""
        val offlineMs = SystemClock.elapsedRealtime() - disconnectedSince
        connectionView.text = when {
            !hasPermissions() -> getString(R.string.status_need_permission)
            unpaired -> getString(R.string.status_unpaired)
            link.connected -> getString(R.string.status_connected)
            offlineMs > 60_000 -> getString(R.string.status_unreachable_long, address)
            offlineMs > 10_000 -> getString(R.string.status_unreachable, address)
            else -> getString(R.string.status_connecting)
        }
        connectionView.setTextColor(
            when {
                !hasPermissions() -> AMBER
                link.connected -> GREEN
                else -> MUTED
            },
        )
        // 還沒配對時，把掃描按鈕標成紅色，告訴使用者下一步
        val background = if (unpaired) scanHighlight ?: scanBackground else scanBackground
        if (scanButton.background !== background) scanButton.background = background
        val zoomable = camera.zoomRange.upper > camera.zoomRange.lower
        micView.text = getString(R.string.mic_line, micLabel()) +
            if (zoomable) "\n" + getString(R.string.zoom_line, "%.1f".format(camera.zoom)) else ""
        uploadView.text = uploader.summary(resources)

        val rec = recording
        when {
            rec == null -> timerView.visibility = View.GONE
            rec.startedAt == 0L -> {
                timerView.setText(R.string.timer_starting)
                timerView.setTextColor(TEXT)
                timerView.visibility = View.VISIBLE
            }
            else -> {
                val elapsed = System.currentTimeMillis() - rec.startedAt
                val left = rec.maxDurationSec * 1000L - elapsed
                val warn = left <= rec.warnBeforeSec * 1000L
                val max = clock(rec.maxDurationSec * 1000L)
                // 最後幾分鐘不寫上限、改寫剩多少，字數才和平常差不多，不會蓋到旁邊的狀態或換行
                timerView.text =
                    if (warn) getString(R.string.timer_rec_warn, clock(elapsed), clock(left)) else getString(R.string.timer_rec, clock(elapsed), max)
                timerView.setTextColor(if (warn) AMBER else RED)
                timerView.visibility = View.VISIBLE
            }
        }
        // 錄影中不能掃描或清檔案：掃描會切到別的畫面，錄影就會中斷
        scanButton.isEnabled = rec == null
        val cleanable = store.transferred.count { File(it).exists() }
        cleanButton.text = if (cleanable > 0) getString(R.string.clean_count, cleanable) else getString(R.string.clean)
        cleanButton.isEnabled = rec == null && cleanable > 0
    }

    private fun toggleDim() {
        dimmed = !dimmed
        window.attributes = window.attributes.apply {
            screenBrightness = if (dimmed) 0.02f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        }
        dimButton.setText(if (dimmed) R.string.undim else R.string.dim)
    }

    private fun confirmClean() {
        val files = store.transferred.map(::File).filter { it.exists() }
        if (files.isEmpty()) return toast(getString(R.string.clean_nothing))
        AlertDialog.Builder(this)
            .setTitle(R.string.clean)
            .setMessage(resources.getQuantityString(R.plurals.clean_confirm, files.size, files.size, formatBytes(files.sumOf { it.length() })))
            .setPositiveButton(R.string.delete) { _, _ ->
                files.forEach { it.delete() }
                store.transferred = emptySet()
                sendStatus()
                toast(getString(R.string.cleared))
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ---------- 沒傳到電腦的影片 ----------

    // 電腦不認得了的影片（例如在電腦上被刪掉，或換了一台電腦）。檔案還在手機上，不能默默不管。
    private fun orphanFiles(): List<File> = store.orphans.map(::File).filter { it.exists() }

    private fun confirmSaveOrphans() {
        val files = orphanFiles()
        AlertDialog.Builder(this)
            .setTitle(R.string.orphans_title)
            .setMessage(resources.getQuantityString(R.plurals.orphans_message, files.size, files.size, formatBytes(files.sumOf { it.length() })))
            .setPositiveButton(R.string.orphans_save) { _, _ -> saveOrphans(files) }
            .setNegativeButton(R.string.orphans_later, null)
            .show()
    }

    // 存到系統的「影片／MultiCamRecorder」資料夾：相簿和檔案管理員都看得到，解除安裝 App 也不會被刪。存好就刪掉 App 裡的那份。
    private fun saveOrphans(files: List<File>) {
        toast(getString(R.string.orphans_saving))
        thread {
            val failed = files.filterNot { file ->
                runCatching { exportToMovies(file) }.isSuccess.also { ok -> if (ok) file.delete() }
            }
            main.post {
                store.orphans = failed.map { it.path }.toSet()
                toast(if (failed.isEmpty()) getString(R.string.orphans_saved) else getString(R.string.orphans_failed, failed.size))
                render()
            }
        }
    }

    private fun exportToMovies(file: File) {
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, file.name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/MultiCamRecorder")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
            ?: error("MediaStore insert failed")
        try {
            contentResolver.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out, 1 shl 20) } }
            contentResolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            contentResolver.delete(uri, null, null) // 沒存完的不要留著
            throw e
        }
    }

    // ---------- 小工具 ----------

    private fun openCamera() {
        val s = surface ?: return
        if (hasPermissions()) camera.open(s, videoSize)
    }

    private fun hasPermissions() =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun hideSystemBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun displayRotationDegrees() = when (display?.rotation) {
        Surface.ROTATION_90 -> 90
        Surface.ROTATION_180 -> 180
        Surface.ROTATION_270 -> 270
        else -> 0
    }

    private fun durationOf(file: File): Long? = runCatching {
        MediaMetadataRetriever().use {
            it.setDataSource(file.path)
            it.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong()
        }
    }.getOrNull()

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    companion object {
        private const val TEXT = 0xFFECE8E1.toInt()
        private const val MUTED = 0xFFC9C6C0.toInt() // 亮的畫面上（白牆、窗邊）也要看得清楚
        private const val GREEN = 0xFF3DDC84.toInt()
        private const val RED = 0xFFFF3B3B.toInt()
        private const val AMBER = 0xFFFFB000.toInt()
        private const val PREVIEW_INTERVAL_MS = 200L // 每秒 5 張
        private val RED_TINT = ColorStateList.valueOf(RED)

        private fun sizeOf(resolution: String) = when (resolution) {
            "2160p" -> Size(3840, 2160)
            "1440p" -> Size(2560, 1440)
            "1080p" -> Size(1920, 1080)
            "720p" -> Size(1280, 720)
            else -> null
        }

        private fun clock(ms: Long): String {
            val s = (ms / 1000).coerceAtLeast(0)
            return "%02d:%02d".format(s / 60, s % 60)
        }
    }
}
