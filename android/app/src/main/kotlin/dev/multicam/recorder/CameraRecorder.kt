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
import android.os.SystemClock
import android.util.Range
import android.util.Size
import android.view.Surface
import android.view.SurfaceHolder
import java.io.File
import java.util.concurrent.Executor

// 後鏡頭的預覽和錄影（Camera2 + MediaRecorder）。
// 錄影用的 surface 一開始就放進相機的 session，開始錄影只要切換 request，
// 啟動延遲短而且穩定，多台手機比較能同時開始。
// 有外接麥克風時用 MIC 音源並指定那個裝置：Android 對 CAMCORDER 音源會優先選內建麥克風。
//
// 對外的方法都可以從主執行緒呼叫，實際工作在 camera 執行緒做，結果回到主執行緒。
class CameraRecorder(private val context: Context, private val listener: Listener) {
    interface Listener {
        fun onReadyChanged(ready: Boolean)
        fun onMaxDurationReached()
        fun onCameraError(message: String)
        fun onRecordingMic(label: String)
    }

    class Spec(val size: Size, val fps: Int, val bitrate: Int, val maxDurationSec: Int)

    class Started(val wallClockMs: Long, val mic: String)

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

    // 預覽用不超過 1080p 的 16:9
    val previewSize: Size = streamMap.getOutputSizes(SurfaceHolder::class.java)
        .filter { it.width * 9 == it.height * 16 && it.width <= 1920 }
        .maxByOrNull { it.width } ?: Size(1280, 720)

    // 以下只在 camera 執行緒存取
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var previewSurface: Surface? = null
    private var recorderSurface: Surface? = null
    private var sessionSize: Size? = null // recorderSurface 是用這個大小配置的
    private var wantedSize: Size? = null
    private var fps = 30
    private var prepared: MediaRecorder? = null // 準備好了，等開始時間到
    private var recorder: MediaRecorder? = null // 錄影中
    private var pendingStart: (() -> Unit)? = null // 等 session 重建好才開始
    private var ready = false
    private val startToken = Any()

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

    fun describe(mic: AudioDeviceInfo?): String = when (mic?.type) {
        null -> "未知"
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "手機內建"
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "外接 USB（${mic.productName}）"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "耳機孔外接（${mic.productName}）"
        else -> "其他（${mic.productName}）"
    }

    @SuppressLint("MissingPermission") // MainActivity 確認過權限才會呼叫
    fun open(surface: Surface, size: Size) = handler.post {
        previewSurface = surface
        wantedSize = size
        if (device == null) manager.openCamera(cameraId, executor, deviceCallback) else createSession()
    }

    // Mac 改了解析度：沒在錄影就先把 session 準備好，開始時才不用等
    fun configure(size: Size) = handler.post {
        wantedSize = size
        if (sessionSize != size && recorder == null && prepared == null) createSession()
    }

    // 在 atUptimeMs（SystemClock.uptimeMillis）開始錄影
    fun start(file: File, spec: Spec, orientationHint: Int, atUptimeMs: Long, done: (Result<Started>) -> Unit) = handler.post {
        if (recorder != null || prepared != null || pendingStart != null) {
            main.post { done(Result.failure(IllegalStateException("已經在錄影"))) }
            return@post
        }
        val prepare: () -> Unit = {
            try {
                // 相機太久沒準備好就放棄，免得很晚才突然開始錄
                check(SystemClock.uptimeMillis() - atUptimeMs < 5000) { "相機太久沒準備好" }
                val r = buildRecorder(file, spec, orientationHint)
                prepared = r
                handler.postAtTime({ begin(r, done) }, startToken, atUptimeMs) // 時間已過就馬上開始
            } catch (e: Exception) {
                prepared?.release()
                prepared = null
                main.post { done(Result.failure(e)) }
            }
        }
        fps = spec.fps
        if (session != null && sessionSize == spec.size) {
            prepare()
        } else {
            pendingStart = prepare
            wantedSize = spec.size
            if (sessionSize != spec.size) createSession()
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
            main.post { done(Result.failure(IllegalStateException("沒有在錄影"))) }
            return@post
        }
        recorder = null
        val result = runCatching { r.stop() } // 錄太短（沒有任何畫面）時會失敗
        r.release()
        runCatching { session?.setRepeatingRequest(request(record = false), null, handler) }
        if (wantedSize != sessionSize) createSession()
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

        override fun onDisconnected(camera: CameraDevice) = lost(camera, "相機被系統或其他 App 中斷")

        override fun onError(camera: CameraDevice, error: Int) = lost(camera, "相機發生錯誤（$error）")
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
        val outputs = listOf(OutputConfiguration(preview), OutputConfiguration(recorderSurface!!))
        val callback = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                if (device !== camera) {
                    s.close()
                    return
                }
                session = s
                s.setRepeatingRequest(request(record = false), null, handler)
                setReady(true)
                pendingStart?.let {
                    pendingStart = null
                    it()
                }
            }

            override fun onConfigureFailed(s: CameraCaptureSession) {
                setReady(false)
                main.post { listener.onCameraError("相機不支援這個設定（${size.width}×${size.height}）") }
            }
        }
        camera.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outputs, executor, callback))
    }

    private fun request(record: Boolean): CaptureRequest {
        val builder = device!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
        builder.addTarget(previewSurface!!)
        if (record) builder.addTarget(recorderSurface!!)
        builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange(fps))
        if (continuousAf) builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
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

    private fun buildRecorder(file: File, spec: Spec, orientationHint: Int): MediaRecorder {
        val mic = externalMic()
        return MediaRecorder(context).apply {
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
            setAudioEncodingBitRate(192_000)
            setAudioChannels(1)
            setOrientationHint(orientationHint)
            setMaxDuration(spec.maxDurationSec * 1000)
            setInputSurface(recorderSurface!!)
            if (mic != null) setPreferredDevice(mic)
            setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) main.post { listener.onMaxDurationReached() }
            }
            setOnErrorListener { _, what, extra -> main.post { listener.onCameraError("錄影發生錯誤（$what/$extra）") } }
            prepare()
        }
    }

    private fun begin(r: MediaRecorder, done: (Result<Started>) -> Unit) {
        try {
            val s = session ?: throw IllegalStateException("相機還沒準備好")
            s.setRepeatingRequest(request(record = true), null, handler)
            r.start()
            recorder = r
            prepared = null
            val started = Started(System.currentTimeMillis(), describe(r.routedDevice))
            main.post { done(Result.success(started)) }
            // 實際用哪支麥克風，開始後才確定
            handler.postDelayed({ recorder?.routedDevice?.let { mic -> main.post { listener.onRecordingMic(describe(mic)) } } }, 1000)
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
    }
}
