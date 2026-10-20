package dev.multicam.recorder

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

// 照 server/protocol.ts 的流程把影片傳到電腦：錄影中就邊錄邊傳，停止後 finish → 分段雜湊 → verify → 補傳。
// 跑在自己的執行緒，連不上就每 3 秒重試，App 重開後會從電腦已收到的位置繼續。
class Uploader(private val store: Store, private val onChange: () -> Unit) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        // 10 秒送不出任何資料就當作這條連線卡住了，換一條新的重來（Wi-Fi 不穩時常見）
        .writeTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS) // verify 時電腦要算整支檔案的雜湊
        .build()
    private val jobs = CopyOnWriteArrayList<UploadJob>()

    // 上次 App 被關掉時還在錄的影片：檔案沒有正常收尾，不傳，交給 MainActivity 回報失敗
    val interrupted: List<UploadJob>

    init {
        val (unfinished, saved) = store.loadJobs().partition { it.size < 0 }
        interrupted = unfinished
        jobs.addAll(saved)
        persist()
    }

    fun start() {
        Thread(::loop, "uploader").apply { isDaemon = true }.start()
    }

    fun add(job: UploadJob) {
        jobs.add(job)
        persist()
    }

    fun recordingFinished(fileId: String, size: Long, durationMs: Long) {
        val job = jobs.find { it.fileId == fileId } ?: return
        job.durationMs = durationMs
        job.size = size
        persist()
    }

    fun drop(fileId: String) {
        jobs.removeAll { it.fileId == fileId }
        persist()
    }

    // 畫面上顯示的傳輸狀態
    fun summary(): String {
        if (jobs.isEmpty()) return "影片都已傳到電腦"
        val recording = jobs.count { it.size < 0 }
        val left = jobs.filter { it.size >= 0 }.sumOf { (it.size - it.sent).coerceAtLeast(0) }
        val parts = mutableListOf<String>()
        if (recording > 0) parts += "邊錄邊傳中"
        if (jobs.size > recording) parts += "還有 ${jobs.size - recording} 支在收尾（剩 ${formatBytes(left)}）"
        return parts.joinToString("，")
    }

    private fun persist() = store.saveJobs(jobs)

    private fun loop() {
        while (true) {
            // 被電腦移除或還沒配對時先暫停，重新配對後會從電腦已收到的位置接著傳
            if (store.token == null) {
                Thread.sleep(1000)
                continue
            }
            for (job in jobs) {
                if (System.currentTimeMillis() < job.retryAt) continue
                try {
                    if (step(job)) {
                        jobs.remove(job)
                        persist()
                        store.transferred = store.transferred + job.path
                    }
                } catch (e: StatusException) {
                    when {
                        e.status == 409 && e.body.has("receivedBytes") -> job.sent = e.body.getLong("receivedBytes")
                        e.status == 404 -> {
                            // 電腦不認得這支影片（例如資料被清掉），不再重試，檔案留在手機上
                            Log.w(TAG, "電腦找不到 ${job.fileId}，停止傳輸")
                            drop(job.fileId)
                        }
                        else -> retryLater(job, e)
                    }
                } catch (e: Exception) {
                    retryLater(job, e) // 網路斷線、電腦回了看不懂的內容等
                }
                onChange()
            }
            Thread.sleep(500)
        }
    }

    private fun retryLater(job: UploadJob, e: Exception) {
        Log.w(TAG, "上傳暫停，1 秒後重試：${e.message}")
        client.connectionPool.evictAll() // 別再用到其他可能也卡住的舊連線
        job.retryAt = System.currentTimeMillis() + 1000
        job.resync = true
    }

    // 回傳 true 表示這支影片已傳完並驗證通過
    private fun step(job: UploadJob): Boolean {
        val file = File(job.path)
        if (job.resync) {
            val received = call("GET", "/api/upload/${job.fileId}", null).getLong("receivedBytes")
            job.sent = if (job.size >= 0) minOf(received, job.size) else received
            job.resync = false
        }
        // 錄影中最後一小段可能還在寫入，先不傳
        val limit = if (job.size >= 0) job.size else (file.length() - TAIL_GUARD).coerceAtLeast(0)
        if (job.sent < limit) sendRange(job, job.sent, limit)
        if (job.size < 0 || job.sent < job.size) return false

        // 錄完了：通知電腦開始算雜湊，手機同時也算，算完比對、補傳不一樣的分段
        call("POST", "/api/upload/${job.fileId}/finish", json("size" to job.size, "durationMs" to job.durationMs))
        val hashes = job.hashes ?: chunkHashes(file, job.size).also { job.hashes = it }
        repeat(3) {
            val result = call("POST", "/api/upload/${job.fileId}/verify", json("chunkSize" to CHUNK_SIZE, "hashes" to JSONArray(hashes)))
            if (result.optBoolean("ok")) return true
            val resend = result.getJSONArray("resend")
            for (i in 0 until resend.length()) {
                val index = resend.getLong(i)
                sendRange(job, index * CHUNK_SIZE, minOf((index + 1) * CHUNK_SIZE, job.size))
            }
        }
        throw IOException("補傳三次還是對不上")
    }

    private fun sendRange(job: UploadJob, start: Long, end: Long) {
        RandomAccessFile(job.path, "r").use { raf ->
            var offset = start
            val buf = ByteArray(PIECE)
            while (offset < end) {
                raf.seek(offset)
                val n = raf.read(buf, 0, minOf(PIECE.toLong(), end - offset).toInt())
                if (n <= 0) break
                call("PUT", "/api/upload/${job.fileId}?offset=$offset", buf.toRequestBody(OCTET, 0, n))
                offset += n
                if (offset > job.sent) job.sent = offset
            }
        }
    }

    private fun chunkHashes(file: File, size: Long): List<String> {
        val hashes = ArrayList<String>()
        FileInputStream(file).use { input ->
            val buf = ByteArray(1 shl 20)
            var remaining = size
            while (remaining > 0) {
                val md = MessageDigest.getInstance("SHA-256")
                var chunkLeft = minOf(CHUNK_SIZE, remaining)
                while (chunkLeft > 0) {
                    val n = input.read(buf, 0, minOf(buf.size.toLong(), chunkLeft).toInt())
                    if (n < 0) throw IOException("檔案比預期的短")
                    md.update(buf, 0, n)
                    chunkLeft -= n
                    remaining -= n
                }
                hashes += md.digest().joinToString("") { "%02x".format(it) }
            }
        }
        return hashes
    }

    private fun call(method: String, path: String, body: RequestBody?): JSONObject {
        val base = store.serverUrl ?: throw IOException("還沒配對")
        val request = Request.Builder()
            .url(base + path)
            .header("X-Device-Token", store.token ?: "")
            .method(method, body)
            .build()
        client.newCall(request).execute().use { res ->
            val text = res.body.string()
            val json = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (!res.isSuccessful) throw StatusException(res.code, json)
            return json
        }
    }

    private fun json(vararg pairs: Pair<String, Any>): RequestBody {
        val o = JSONObject()
        for ((k, v) in pairs) o.put(k, v)
        return o.toString().toRequestBody(JSON)
    }

    private class StatusException(val status: Int, val body: JSONObject) : Exception("HTTP $status ${body.optString("error")}")

    companion object {
        private const val TAG = "Uploader"
        const val CHUNK_SIZE = 16L * 1024 * 1024 // 要和 server/protocol.ts 一致
        private const val PIECE = 4 * 1024 * 1024
        private const val TAIL_GUARD = 256L * 1024
        private val OCTET = "application/octet-stream".toMediaType()
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

fun formatBytes(n: Long): String = when {
    n >= 1_000_000_000 -> "%.1f GB".format(n / 1e9)
    n >= 1_000_000 -> "${n / 1_000_000} MB"
    else -> "${n / 1000} KB"
}
