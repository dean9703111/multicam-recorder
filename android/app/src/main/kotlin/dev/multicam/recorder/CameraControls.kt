package dev.multicam.recorder

import org.json.JSONArray
import org.json.JSONObject

// Camera2 的線性白平衡增益。保留兩個綠色通道，切換自動／手動時沿用實測值。
data class CameraControls(val exposureEv: Double = 0.0, val whiteBalance: String = "auto", val gains: List<Float> = listOf(2f, 1f, 1f, 2f)) {
    fun json() = JSONObject().put("exposureEv", exposureEv).put("whiteBalance", whiteBalance)
        .put("gains", JSONArray(gains.map { it.toDouble() }))

    companion object {
        fun parse(o: JSONObject): CameraControls? = runCatching {
            val ev = o.getDouble("exposureEv")
            val mode = o.getString("whiteBalance")
            val a = o.getJSONArray("gains")
            require(ev.isFinite() && ev in -24.0..24.0 && mode in listOf("auto", "manual") && a.length() == 4)
            val gains = (0..3).map { a.getDouble(it).toFloat() }
            require(gains.all { it.isFinite() && it in 1f..8f })
            CameraControls(ev, mode, gains)
        }.getOrNull()
    }
}
