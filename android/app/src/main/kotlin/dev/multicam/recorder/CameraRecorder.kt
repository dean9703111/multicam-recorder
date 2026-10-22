package dev.multicam.recorder

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaCodec
import android.media.MediaRecorder
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.StatFs
import android.os.SystemClock
import android.util.Range
import android.util.Size
import android.view.Surface
import android.view.SurfaceHolder
import java.io.File
import java.util.concurrent.Executor
import kotlin.math.log10

// 後鏡頭的預覽和錄影（Camera2 + MediaRecorder）。
// 錄影用的 surface 一開始就放進相機的 session，開始錄影只要切換 request，
// 啟動延遲短而且穩定，多台手機比較能同時開始。
// 有外接麥克風時用 MIC 音源並指定那個裝置：Android 對 CAMCORDER 音源會優先選內建麥克風。
//
// 人像設定也都交給手機的相機處理，不經過 App 的影像處理，畫質不變：
// - 臉部優先：場景模式 FACE_PRIORITY，對焦、曝光、白平衡以人臉為準，畫面裡沒有人臉時跟自動一樣。
//   部分手機（例如 Pixel）的場景模式是 session 參數，改了要重建 session。
// - 鎖定曝光、白平衡和對焦：開始錄影的那一刻鎖住，停止後恢復自動。
//
// 對外的方法都可以從主執行緒呼叫，實際工作在 camera 執行緒做，結果回到主執行緒。
class CameraRecorder(private val context: Context, private val listener: Listener) {
    interface Listener {
        fun onReadyChanged(ready: Boolean)
        fun onMaxDurationReached()
        fun onMaxFileSizeReached() // 手機空間快滿了，或碰到這支手機單一影片的大小上限（不少手機是 4 GB）
        fun onCameraError(message: String)
        fun onRecordingMic(mic: AudioDeviceInfo)
        fun onAudioLevel(db: Double) // 錄影中每秒 4 次，這段時間最大的音量（dBFS）
    }

    class Spec(val size: Size, val fps: Int, val bitrate: Int, val maxDurationSec: Int, val lockExposure: Boolean)

    class Started(val wallClockMs: Long, val mic: AudioDeviceInfo?, val channels: Int)

    // 開始錄影失敗：code 照 server/protocol.ts 的 FailureCode，電腦會用自己的語言顯示
    class StartFailure(val code: String, message: String) : Exception(message)

    private val thread = HandlerThread("camera").apply { start() }
    private val handler = Handler(thread.looper)
    private val executor = Executor { handler.post(it) }
    private val main = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(CameraManager::class.java)
    private val audio = context.getSystemService(AudioManager::class.java)

    private val cameraId = manager.cameraIdList.first {
        manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
    }
    private val characteristics = manager.getCameraCharacteristics(cameraId)
    private val sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
    private val streamMap = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!
    private val continuousAf = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
        ?.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) == true
    private val fpsRanges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES).orEmpty()

    // 變焦範圍。多鏡頭的手機小於 1 會切到超廣角、放大到一定倍數會切到望遠，由系統自己換鏡頭。
    val zoomRange: Range<Float> = characteristics.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) ?: Range(1f, 1f)

    @Volatile
    var zoom = 1f
        private set

    // 預覽用不超過 1080p 的 16:9
    val previewSize: Size = streamMap.getOutputSizes(SurfaceHolder::class.java)
        .filter { it.width * 9 == it.height * 16 && it.width <= 1920 }
        .maxByOrNull { it.width } ?: Size(1280, 720)

    // 手機在自然方向（一般手機是直拿）時，預覽畫面的寬高。感光元件大多轉 90° 裝，寬高要對調。
    val naturalPreviewSize: Size =
        if (sensorOrientation % 180 == 90) Size(previewSize.height, previewSize.width) else previewSize

    // 做得到哪些人像設定，連上電腦時回報
    val facePrioritySupported = characteristics.get(CameraCharacteristics.CONTROL_AVAILABLE_SCENE_MODES)
        ?.contains(CameraCharacteristics.CONTROL_SCENE_MODE_FACE_PRIORITY) == true
    val lockSupported = characteristics.get(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true &&
        characteristics.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) == true

    // 以下只在 camera 執行緒存取
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var previewSurface: Surface? = null
    private var recorderSurface: Surface? = null
    private var sessionSize: Size? = null // recorderSurface 是用這個大小配置的
    private var wantedSize: Size? = null
    private var sessionFacePriority = false // 現在的 session 有沒有開臉部優先
    private var wantedFacePriority = false
    private var lockExposure = false // 這次錄影要不要鎖定曝光和白平衡，開始錄影時才用到
    private var sessionGeneration = 0 // 每建一次 session 加一，只理會最新那個 session 的回報
    private var fps = 30
    private var prepared: MediaRecorder? = null // 準備好了，等開始時間到
    private var preparedChannels = 1
    private var recorder: MediaRecorder? = null // 錄影中
    private var focusLocked = false // 這次錄影有沒有鎖住對焦，停止時要解開
    private var pendingStart: (() -> Unit)? = null // 等 session 重建好才開始
    private var ready = false
    private val startToken = Any()

    // 錄影中的音量：MediaRecorder 回報上次問到現在最大的振幅（0–32767），換成 dBFS
    private val levelPoll = object : Runnable {
        override fun run() {
            val r = recorder ?: return
            val amplitude = runCatching { r.maxAmplitude }.getOrDefault(0)
            val db = if (amplitude <= 0) -90.0 else (20 * log10(amplitude / 32767.0)).coerceAtLeast(-90.0)
            main.post { listener.onAudioLevel(db) }
            handler.postDelayed(this, 250)
        }
    }

    // 要求的解析度不支援時，改用不超過它的最大 16:9
    fun videoSize(width: Int, height: Int): Size {
        val sizes = streamMap.getOutputSizes(MediaRecorder::class.java)
        return sizes.firstOrNull { it.width == width && it.height == height }
            ?: sizes.filter { it.width * 9 == it.height * 16 && it.width <= width }.maxByOrNull { it.width }
            ?: sizes.maxBy { it.width.toLong() * it.height }
    }

    fun orientationHint(displayRotationDegrees: Int) = (sensorOrientation - displayRotationDegrees + 360) % 360

    fun externalMic(): AudioDeviceInfo? =
        audio.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.type in EXTERNAL_MIC_TYPES }

    // App 上顯示的收音來源（跟著手機的語言）
    fun describe(mic: AudioDeviceInfo?): String = when (audioSource(mic)) {
        "builtin" -> context.getString(R.string.mic_builtin)
        "usb" -> context.getString(R.string.mic_usb, mic!!.productName)
        "wired" -> context.getString(R.string.mic_wired, mic!!.productName)
        "other" -> context.getString(R.string.mic_other, mic!!.productName)
        else -> context.getString(R.string.mic_unknown)
    }

    // 回報給電腦的收音來源（protocol.ts 的 AudioSource），電腦用自己的語言顯示
    fun audioSource(mic: AudioDeviceInfo?): String? = when (mic?.type) {
        null -> null
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin"
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
        else -> "other"
    }

    fun open(surface: Surface, size: Size) = handler.post {
        previewSurface = surface
        wantedSize = size
        if (device == null) openDevice() else createSession()
    }

    // 打不開時（例如 App 在螢幕關著時啟動，系統把它當成在背景、不給開相機）過一下再試，預覽還在才試
    @SuppressLint("MissingPermission") // MainActivity 確認過權限才會呼叫 open
    private fun openDevice() {
        handler.removeCallbacks(retryOpen)
        try {
            manager.openCamera(cameraId, executor, deviceCallback)
        } catch (e: Exception) {
            handler.postDelayed(retryOpen, 2000)
        }
    }

    private val retryOpen = Runnable { if (device == null && previewSurface != null) openDevice() }

    // 電腦改了解析度或臉部優先：沒在錄影就先把 session 準備好，開始時才不用等
    fun configure(size: Size, facePriority: Boolean) = handler.post {
        wantedSize = size
        wantedFacePriority = facePriority
        if ((sessionSize != size || sessionFacePriority != facePriority) && recorder == null && prepared == null) createSession()
    }

    // 在 atUptimeMs（SystemClock.uptimeMillis）開始錄影
    fun start(file: File, spec: Spec, facePriority: Boolean, orientationHint: Int, atUptimeMs: Long, done: (Result<Started>) -> Unit) = handler.post {
        if (recorder != null || prepared != null || pendingStart != null) {
            main.post { done(Result.failure(StartFailure("busy", "already recording"))) }
            return@post
        }
        val prepare: () -> Unit = {
            try {
                // 相機太久沒準備好就放棄，免得很晚才突然開始錄
                if (SystemClock.uptimeMillis() - atUptimeMs >= 5000) throw StartFailure("cameraNotReady", "camera took too long to get ready")
                val (r, channels) = buildRecorder(file, spec, orientationHint)
                prepared = r
                preparedChannels = channels
                handler.postAtTime({ begin(r, done) }, startToken, atUptimeMs) // 時間已過就馬上開始
            } catch (e: Exception) {
                prepared?.release()
                prepared = null
                main.post { done(Result.failure(e)) }
            }
        }
        fps = spec.fps
        lockExposure = spec.lockExposure
        wantedFacePriority = facePriority
        if (session != null && sessionSize == spec.size && sessionFacePriority == facePriority) {
            prepare()
        } else {
            pendingStart = prepare
            wantedSize = spec.size
            if (sessionSize != spec.size || sessionFacePriority != facePriority) createSession()
        }
    }

    // 預覽和錄影一起套用，錄影中也可以調。倍率馬上更新，相機執行緒再把它套到 request 上。
    fun setZoom(ratio: Float) {
        zoom = ratio.coerceIn(zoomRange.lower, zoomRange.upper)
        handler.post {
            if (session != null) runCatching { session?.setRepeatingRequest(request(record = recorder != null), null, handler) }
        }
    }

    // 還沒到開始時間就收到停止
    fun cancelPending() = handler.post {
        handler.removeCallbacksAndMessages(startToken)
        pendingStart = null
        prepared?.release()
        prepared = null
    }

    fun stop(done: (Result<Unit>) -> Unit) = handler.post {
        val r = recorder
        if (r == null) {
            main.post { done(Result.failure(IllegalStateException("not recording"))) }
            return@post
        }
        recorder = null
        handler.removeCallbacks(levelPoll)
        val result = runCatching { r.stop() } // 錄太短（沒有任何畫面）時會失敗
        r.release()
        if (focusLocked) {
            focusLocked = false
            runCatching { session?.capture(request(record = false, afTrigger = CaptureRequest.CONTROL_AF_TRIGGER_CANCEL), null, handler) }
        }
        runCatching { session?.setRepeatingRequest(request(record = false), null, handler) }
        if (wantedSize != sessionSize || wantedFacePriority != sessionFacePriority) createSession()
        main.post { done(result) }
    }

    fun close() = handler.post { closeCamera() }

    fun release() = handler.post {
        closeCamera()
        recorderSurface?.release()
        recorderSurface = null
        sessionSize = null
        thread.quitSafely()
    }

    private fun closeCamera() {
        handler.removeCallbacksAndMessages(startToken)
        handler.removeCallbacks(retryOpen)
        handler.removeCallbacks(levelPoll)
        focusLocked = false
        pendingStart = null
        prepared?.release()
        prepared = null
        recorder?.let {
            runCatching { it.stop() }
            it.release()
        }
        recorder = null
        session?.close()
        session = null
        device?.close()
        device = null
        previewSurface = null
        setReady(false)
    }

    private val deviceCallback = object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
            device = camera
            createSession()
        }

        override fun onDisconnected(camera: CameraDevice) = lost(camera, context.getString(R.string.camera_lost))

        override fun onError(camera: CameraDevice, error: Int) = lost(camera, context.getString(R.string.camera_error, error.toString()))
    }

    private fun lost(camera: CameraDevice, message: String) {
        camera.close()
        if (device !== camera) return
        device = null
        session = null
        setReady(false)
        main.post { listener.onCameraError(message) }
    }

    private fun createSession() {
        val camera = device ?: return
        val preview = previewSurface ?: return
        val size = wantedSize ?: return
        session?.close()
        session = null
        setReady(false)
        if (recorderSurface == null || sessionSize != size) {
            recorderSurface?.release()
            recorderSurface = persistentSurface(size)
            sessionSize = size
        }
        sessionFacePriority = wantedFacePriority
        val generation = ++sessionGeneration
        val outputs = listOf(OutputConfiguration(preview), OutputConfiguration(recorderSurface!!))
        val callback = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                // 相機換了，或已經建了新的 session（系統會關掉舊的，但舊的這個回報還是會晚到）
                if (device !== camera || generation != sessionGeneration) {
                    s.close()
                    return
                }
                session = s
                try {
                    s.setRepeatingRequest(request(record = false), null, handler)
                } catch (e: Exception) {
                    return // 相機剛好斷線或出錯，deviceCallback 會處理
                }
                setReady(true)
                pendingStart?.let {
                    pendingStart = null
                    it()
                }
            }

            override fun onConfigureFailed(s: CameraCaptureSession) {
                if (device !== camera || generation != sessionGeneration) return
                setReady(false)
                main.post { listener.onCameraError(context.getString(R.string.camera_unsupported_config, "${size.width}×${size.height}")) }
            }
        }
        val config = SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outputs, executor, callback)
        // 場景模式在部分手機（例如 Pixel）是 session 參數，建 session 時先帶上，第一個 request 才不用重新設定相機
        config.sessionParameters = request(record = false)
        try {
            camera.createCaptureSession(config)
        } catch (e: Exception) {
            // 相機剛好斷線或出錯，deviceCallback 會處理
        }
    }

    // afTrigger：只用在單次的 capture。START 把連續對焦鎖在目前的焦點，CANCEL 解開
    private fun request(record: Boolean, afTrigger: Int? = null): CaptureRequest {
        val builder = device!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
        builder.addTarget(previewSurface!!)
        if (record) builder.addTarget(recorderSurface!!)
        builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange(fps))
        builder.set(CaptureRequest.CONTROL_ZOOM_RATIO, zoom)
        if (continuousAf) builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
        if (afTrigger != null) builder.set(CaptureRequest.CONTROL_AF_TRIGGER, afTrigger)
        if (sessionFacePriority && facePrioritySupported) {
            builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_USE_SCENE_MODE)
            builder.set(CaptureRequest.CONTROL_SCENE_MODE, CaptureRequest.CONTROL_SCENE_MODE_FACE_PRIORITY)
        }
        // 開始錄影的那一刻鎖住，停止後的預覽恢復自動
        if (record && lockExposure && lockSupported) {
            builder.set(CaptureRequest.CONTROL_AE_LOCK, true)
            builder.set(CaptureRequest.CONTROL_AWB_LOCK, true)
        }
        return builder.build()
    }

    // 固定幀率最好；沒有的話選上限相同、下限最高的範圍
    private fun fpsRange(fps: Int): Range<Int> =
        fpsRanges.firstOrNull { it.lower == fps && it.upper == fps }
            ?: fpsRanges.filter { it.upper == fps }.maxByOrNull { it.lower }
            ?: Range(fps, fps)

    private fun persistentSurface(size: Size): Surface {
        val surface = MediaCodec.createPersistentInputSurface()
        // 先用同樣的影像設定 prepare 一次再釋放，surface 才會配置好對應大小的緩衝區，能放進相機的 session
        val warmup = File(context.cacheDir, "warmup.mp4")
        MediaRecorder(context).apply {
            setVideoSource(MediaRecorder.VideoSource.SURFACE)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setOutputFile(warmup)
            setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            setVideoSize(size.width, size.height)
            setVideoFrameRate(30)
            setVideoEncodingBitRate(10_000_000)
            setInputSurface(surface)
            prepare()
            release()
        }
        warmup.delete()
        return surface
    }

    // 外接麥克風支援雙聲道（例如雙發射器的無線麥克風）就錄雙聲道，兩個人的聲音剪輯時可以分開調；準備失敗就退回單聲道
    private fun buildRecorder(file: File, spec: Spec, orientationHint: Int): Pair<MediaRecorder, Int> {
        val mic = externalMic()
        val stereo = mic != null && (mic.channelCounts.isEmpty() || mic.channelCounts.contains(2))
        if (stereo) runCatching { return newRecorder(file, spec, orientationHint, mic, 2) to 2 }
        return newRecorder(file, spec, orientationHint, mic, 1) to 1
    }

    private fun newRecorder(file: File, spec: Spec, orientationHint: Int, mic: AudioDeviceInfo?, channels: Int): MediaRecorder {
        // 手機空間快滿時提早正常收尾，不要寫到滿：寫不下的 MP4 收不了尾，整支都會壞掉
        val free = runCatching { StatFs(file.parent).availableBytes }.getOrDefault(Long.MAX_VALUE)
        val r = MediaRecorder(context)
        try {
            r.apply {
                setAudioSource(if (mic != null) MediaRecorder.AudioSource.MIC else MediaRecorder.AudioSource.CAMCORDER)
                setVideoSource(MediaRecorder.VideoSource.SURFACE)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setOutputFile(file)
                setVideoEncoder(MediaRecorder.VideoEncoder.H264)
                setVideoSize(spec.size.width, spec.size.height)
                setVideoFrameRate(spec.fps)
                setVideoEncodingBitRate(spec.bitrate)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(48_000)
                setAudioEncodingBitRate(if (channels == 2) 256_000 else 192_000)
                setAudioChannels(channels)
                setOrientationHint(orientationHint)
                setMaxDuration(spec.maxDurationSec * 1000)
                setMaxFileSize((free - FREE_SPACE_MARGIN).coerceAtLeast(MIN_FILE_SIZE))
                setInputSurface(recorderSurface!!)
                if (mic != null) setPreferredDevice(mic)
                setOnInfoListener { _, what, _ ->
                    when (what) {
                        MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED -> main.post { listener.onMaxDurationReached() }
                        MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED -> main.post { listener.onMaxFileSizeReached() }
                    }
                }
                setOnErrorListener { _, what, extra -> main.post { listener.onCameraError(context.getString(R.string.recorder_error, "$what/$extra")) } }
                prepare()
            }
        } catch (e: Exception) {
            r.release()
            throw e
        }
        return r
    }

    private fun begin(r: MediaRecorder, done: (Result<Started>) -> Unit) {
        try {
            val s = session ?: throw StartFailure("cameraNotReady", "camera not ready")
            s.setRepeatingRequest(request(record = true), null, handler)
            r.start()
            recorder = r
            prepared = null
            // 鎖定時連對焦一起鎖：訪談的人不會動，對焦就不會因為手勢或轉頭而忽遠忽近
            if (lockExposure && continuousAf) {
                focusLocked = runCatching { s.capture(request(record = true, afTrigger = CaptureRequest.CONTROL_AF_TRIGGER_START), null, handler) }.isSuccess
            }
            val started = Started(System.currentTimeMillis(), r.routedDevice, preparedChannels)
            main.post { done(Result.success(started)) }
            // 實際用哪支麥克風，開始後才確定；錄影中換了（例如外接麥克風鬆脫，改用內建的）也馬上回報
            handler.postDelayed({ recorder?.routedDevice?.let { mic -> main.post { listener.onRecordingMic(mic) } } }, 1000)
            r.addOnRoutingChangedListener({ router -> router.routedDevice?.let { mic -> main.post { listener.onRecordingMic(mic) } } }, handler)
            handler.postDelayed(levelPoll, 250)
        } catch (e: Exception) {
            prepared = null
            r.release()
            runCatching { session?.setRepeatingRequest(request(record = false), null, handler) }
            main.post { done(Result.failure(e)) }
        }
    }

    private fun setReady(value: Boolean) {
        if (ready == value) return
        ready = value
        main.post { listener.onReadyChanged(value) }
    }

    companion object {
        private val EXTERNAL_MIC_TYPES = setOf(
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
        )
        const val FREE_SPACE_MARGIN = 300L * 1000 * 1000 // 手機至少留這麼多空間給系統和其他 App
        private const val MIN_FILE_SIZE = 10L * 1000 * 1000

        // 有沒有後鏡頭；沒有的話這個 App 沒辦法用（MainActivity 會說明，不會當掉）
        fun hasBackCamera(context: Context): Boolean = runCatching {
            val manager = context.getSystemService(CameraManager::class.java)
            manager.cameraIdList.any { manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
        }.getOrDefault(false)
    }
}
