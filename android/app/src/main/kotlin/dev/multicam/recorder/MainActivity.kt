package dev.multicam.recorder

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Bitmap
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
import android.os.StatFs
import android.os.SystemClock
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
import android.widget.TextView
import android.widget.Toast
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

// 唯一的畫面：相機預覽加上狀態。錄影的開始和停止都由電腦控制。
// App 必須留在前景、螢幕不能關（Android 不讓背景 App 用相機），切到背景時會先把錄影正常收尾。
class MainActivity : Activity(), ServerLink.Listener, CameraRecorder.Listener {
    private class Recording(val fileId: String, val file: File, val maxDurationSec: Int, val warnBeforeSec: Int) {
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
    private var recording: Recording? = null
    private var recordingMic: String? = null
    private var dimmed = false
    private var wifiLock: WifiManager.WifiLock? = null
    private var tick = 0
    private var disconnectedSince = SystemClock.elapsedRealtime() // 連不上太久就提示檢查網路
    private lateinit var previewView: SurfaceView

    // 即時畫面：電腦上有人在看時，大約每秒 5 張把預覽畫面縮成 640×360 的 JPEG 送過去。
    // 用 PixelCopy 從預覽複製，不必在相機多開一路影像，錄影的設定不受影響。
    private val previewThread = HandlerThread("preview").apply { start() }
    private val previewHandler = Handler(previewThread.looper)
    private val previewBitmap = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888)
    private var previewOn = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        store = Store(this)
        moviesDir = getExternalFilesDir(Environment.DIRECTORY_MOVIES)!!
        camera = CameraRecorder(this, this)
        videoSize = camera.videoSize(videoSize.width, videoSize.height)
        uploader = Uploader(store) { main.post { render() } }
        link = ServerLink(store, this)

        nameView = findViewById(R.id.name)
        connectionView = findViewById(R.id.connection)
        timerView = findViewById(R.id.timer)
        micView = findViewById(R.id.mic)
        uploadView = findViewById(R.id.upload)
        guideView = findViewById(R.id.guide)
        scanButton = findViewById<Button>(R.id.scan).apply { setOnClickListener { scan() } }
        scanBackground = scanButton.background
        scanHighlight = scanBackground?.constantState?.newDrawable(resources, theme)?.mutate()?.apply { setTintList(RED_TINT) }
        dimButton = findViewById<Button>(R.id.dim).apply { setOnClickListener { toggleDim() } }
        cleanButton = findViewById<Button>(R.id.clean).apply { setOnClickListener { confirmClean() } }
        // 權限被拒絕過，系統就不會再問，只能到 App 的設定頁打開
        findViewById<View>(R.id.status).setOnClickListener {
            if (!hasPermissions()) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            }
        }

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

        // 避開瀏海和打孔鏡頭
        val overlay = findViewById<View>(R.id.overlay)
        val pad = overlay.paddingLeft
        overlay.setOnApplyWindowInsetsListener { v, insets ->
            val c = insets.getInsets(WindowInsets.Type.displayCutout() or WindowInsets.Type.systemBars())
            v.setPadding(pad + c.left, pad + c.top, pad + c.right, pad + c.bottom)
            insets
        }

        getSystemService(AudioManager::class.java).registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                sendStatus()
                render()
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
                sendStatus()
                render()
            }
        }, main)

        for (job in uploader.interrupted) {
            reportFailed(job.fileId, "App 在錄影中被關閉，這支影片沒有正常收尾", toast = false)
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
        main.removeCallbacks(loop)
        main.removeCallbacks(capture)
        previewThread.quitSafely()
        camera.release()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
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
            PixelCopy.request(previewView, previewBitmap, { result ->
                // 在 preview 執行緒壓縮，不卡畫面
                val jpeg = if (result == PixelCopy.SUCCESS) {
                    ByteArrayOutputStream().also { previewBitmap.compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
                } else {
                    null
                }
                main.post {
                    if (jpeg != null && previewOn) link.sendFrame(jpeg)
                    if (previewOn) main.postDelayed(this, PREVIEW_INTERVAL_MS)
                }
            }, previewHandler)
        }
    }

    private fun applySpec(spec: JSONObject) {
        guideView.setGuide(spec.optString("guide", "none"))
        val requested = sizeOf(spec.optString("resolution")) ?: return
        videoSize = camera.videoSize(requested.width, requested.height)
        if (recording == null) camera.configure(videoSize)
    }

    private fun startRecording(msg: JSONObject) {
        val fileId = msg.getString("fileId")
        guideView.setGuide(msg.optString("guide", "none"))
        if (recording != null) return reportFailed(fileId, "這支手機已經在錄影")
        if (!cameraReady) return reportFailed(fileId, "相機還沒準備好")
        val requested = sizeOf(msg.getString("resolution")) ?: return reportFailed(fileId, "不支援這個解析度")
        videoSize = camera.videoSize(requested.width, requested.height)
        if (videoSize != requested) toast("這支手機不支援 ${requested.width}×${requested.height}，改用 ${videoSize.width}×${videoSize.height}")

        val spec = CameraRecorder.Spec(videoSize, msg.getInt("fps"), msg.getInt("bitrate"), msg.getInt("maxDurationSec"))
        val file = File(moviesDir, msg.getString("fileName"))
        val rec = Recording(fileId, file, spec.maxDurationSec, msg.optInt("warnBeforeSec", 180))
        recording = rec
        val delay = (link.toLocalTime(msg.getLong("startAt")) - System.currentTimeMillis()).coerceAtLeast(0)
        val hint = camera.orientationHint(displayRotationDegrees())
        camera.start(file, spec, hint, SystemClock.uptimeMillis() + delay) { result ->
            result.onSuccess { started ->
                rec.startedAt = started.wallClockMs
                recordingMic = started.mic
                uploader.add(UploadJob(fileId, file.path)) // 開始邊錄邊傳
                link.send(
                    JSONObject().put("type", "recordingStarted").put("fileId", fileId)
                        .put("startedAt", link.toServerTime(started.wallClockMs))
                        .put("width", spec.size.width).put("height", spec.size.height), // 不支援時已經降級過
                    queueIfOffline = true,
                )
            }.onFailure { e ->
                if (recording === rec) recording = null
                file.delete()
                reportFailed(fileId, "開始錄影失敗：${e.message}")
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
            reportFailed(fileId, "還沒開始就取消了", toast = false)
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
                reportFailed(fileId, "錄影沒有正常結束：${result.exceptionOrNull()?.message}")
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

    private fun reportFailed(fileId: String, message: String, toast: Boolean = true) {
        link.send(JSONObject().put("type", "recordingFailed").put("fileId", fileId).put("error", message), queueIfOffline = true)
        if (toast) toast(message)
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

    override fun onCameraError(message: String) {
        toast(message)
        recording?.let { stopRecording(it.fileId, "error") }
    }

    override fun onRecordingMic(label: String) {
        recordingMic = label
        sendStatus()
        render()
    }

    // ---------- 配對 ----------

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode -> barcode.rawValue?.let(::pairFromQr) }
            .addOnFailureListener { e -> toast("沒辦法掃描：${e.message}") }
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
            if (server.isNullOrEmpty() || code.isNullOrEmpty()) toast("配對連結不完整") else pair(server, code)
            return
        }
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        intent.getStringExtra("qr")?.takeIf { debuggable }?.let(::pairFromQr)
    }

    // QR Code 的內容是 http://<電腦>:8787/pair?code=<配對碼>
    private fun pairFromQr(raw: String) {
        val uri = Uri.parse(raw)
        val code = runCatching { uri.getQueryParameter("code") }.getOrNull()
        if (uri.scheme != "http" || uri.path != "/pair" || code.isNullOrEmpty()) return toast("這不是配對用的 QR Code")
        pair("http://${uri.encodedAuthority}", code)
    }

    private fun pair(url: String, code: String) {
        thread {
            val result = runCatching {
                val body = JSONObject().put("pair", code).put("deviceId", store.deviceId).put("model", Build.MODEL)
                    .toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                OkHttpClient().newCall(Request.Builder().url("$url/api/pair").post(body).build()).execute().use { res ->
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
                    toast("配對完成：${store.name}")
                }.onFailure { e -> toast("配對失敗：${e.message}") }
                render()
            }
        }
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
                .put("audioInput", micLabel())
                .put("zoom", camera.zoom.toDouble())
                .put("zoomRange", JSONArray().put(camera.zoomRange.lower.toDouble()).put(camera.zoomRange.upper.toDouble())),
            queueIfOffline = false,
        )
    }

    private fun micLabel(): String = recordingMic ?: camera.externalMic()?.let(camera::describe) ?: "手機內建"

    private fun render() {
        nameView.text = store.name ?: Build.MODEL
        val unpaired = store.token == null
        connectionView.text = when {
            !hasPermissions() -> "需要相機和麥克風權限才能錄影，點這裡打開設定"
            unpaired -> "尚未配對：請點右下角「掃描 QR Code」"
            link.connected -> "已連線到電腦"
            SystemClock.elapsedRealtime() - disconnectedSince > 10_000 -> "連不到電腦：請確認電腦上的伺服器開著，手機和電腦連同一個 Wi-Fi"
            else -> "連線中…"
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
        micView.text = "收音：${micLabel()}" + if (zoomable) "\n變焦：${"%.1f".format(camera.zoom)}×" else ""
        uploadView.text = uploader.summary()

        val rec = recording
        when {
            rec == null -> timerView.visibility = View.GONE
            rec.startedAt == 0L -> {
                timerView.text = "準備開始…"
                timerView.setTextColor(TEXT)
                timerView.visibility = View.VISIBLE
            }
            else -> {
                val elapsed = System.currentTimeMillis() - rec.startedAt
                val left = rec.maxDurationSec * 1000L - elapsed
                val warn = left <= rec.warnBeforeSec * 1000L
                timerView.text = "● REC ${clock(elapsed)} / ${clock(rec.maxDurationSec * 1000L)}" + if (warn) "　剩 ${clock(left)}" else ""
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
        if (files.isEmpty()) return toast("沒有已傳完的影片可以清除")
        AlertDialog.Builder(this)
            .setTitle(R.string.clean)
            .setMessage("刪除 ${files.size} 支已傳到電腦並驗證過的影片，共 ${formatBytes(files.sumOf { it.length() })}？\n電腦上的檔案不受影響。")
            .setPositiveButton("刪除") { _, _ ->
                files.forEach { it.delete() }
                store.transferred = emptySet()
                sendStatus()
                toast("已清除")
            }
            .setNegativeButton("取消", null)
            .show()
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
        private const val MUTED = 0xFF8B919A.toInt()
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
