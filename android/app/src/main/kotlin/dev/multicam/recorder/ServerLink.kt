package dev.multicam.recorder

import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

// 和電腦的 WebSocket 連線。所有狀態都只在主執行緒改動。
// 斷線時照常錄影；重要的訊息（開始、停止、失敗）先排隊，連回來再送。
class ServerLink(private val store: Store, private val listener: Listener) {
    interface Listener {
        fun onConnectionChanged(connected: Boolean)
        fun onUnpaired()
        fun onMessage(msg: JSONObject)
    }

    private val client = OkHttpClient.Builder().pingInterval(10, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private val outbox = ArrayDeque<String>()
    private var bestRtt = Long.MAX_VALUE

    var connected = false
        private set

    // 電腦時間 - 手機時間（毫秒）
    var clockOffset = 0L
        private set

    fun toServerTime(localMs: Long) = localMs + clockOffset
    fun toLocalTime(serverMs: Long) = serverMs - clockOffset

    fun connect() {
        val base = store.serverUrl ?: return
        val token = store.token ?: return
        main.removeCallbacks(reconnect)
        ws?.cancel()
        val url = base.replaceFirst("http", "ws") + "/ws/device?token=" + URLEncoder.encode(token, "UTF-8")
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post { if (webSocket === ws) opened(webSocket) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                main.post { if (webSocket === ws) received(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                main.post { if (webSocket === ws) closed(code) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { if (webSocket === ws) closed(-1) }
            }
        })
    }

    fun send(msg: JSONObject, queueIfOffline: Boolean) {
        val text = msg.toString()
        if (connected) ws?.send(text) else if (queueIfOffline) outbox.addLast(text)
    }

    private fun opened(socket: WebSocket) {
        connected = true
        socket.send(JSONObject().put("type", "hello").put("model", Build.MODEL).put("appVersion", APP_VERSION).toString())
        while (outbox.isNotEmpty()) socket.send(outbox.removeFirst())
        bestRtt = Long.MAX_VALUE
        for (i in 0 until 5) main.postDelayed({ sync() }, i * 200L)
        listener.onConnectionChanged(true)
    }

    private fun received(text: String) {
        val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (msg.optString("type") == "sync") {
            // 取來回時間最短的那次估算時差
            val t2 = System.currentTimeMillis()
            val t0 = msg.getLong("t0")
            val rtt = t2 - t0
            if (rtt < bestRtt) {
                bestRtt = rtt
                clockOffset = msg.getLong("t1") - (t0 + t2) / 2
            }
            return
        }
        listener.onMessage(msg)
    }

    private fun closed(code: Int) {
        ws = null
        val wasConnected = connected
        connected = false
        if (wasConnected) listener.onConnectionChanged(false)
        if (code == 4001) listener.onUnpaired() else main.postDelayed(reconnect, 2000)
    }

    private val reconnect = Runnable { connect() }

    private fun sync() {
        if (connected) ws?.send(JSONObject().put("type", "sync").put("t0", System.currentTimeMillis()).toString())
    }

    init {
        // 每 10 秒對時一次，修正時鐘漂移
        main.post(object : Runnable {
            override fun run() {
                sync()
                main.postDelayed(this, 10_000)
            }
        })
    }

    companion object {
        const val APP_VERSION = "0.1.0"
    }
}
