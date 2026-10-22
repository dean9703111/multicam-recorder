package dev.multicam.recorder

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

// 一支影片的傳輸進度。size 是 -1 表示還在錄。
class UploadJob(val fileId: String, val path: String) {
    @Volatile var sent = 0L
    @Volatile var size = -1L
    @Volatile var durationMs = 0L
    @Volatile var retryAt = 0L
    @Volatile var resync = true // 先問電腦實際收到多少，再接著傳
    var hashes: List<String>? = null
}

// 存在手機上的資料：裝置 ID、配對結果、還沒傳完的影片
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("recorder", Context.MODE_PRIVATE)

    val deviceId: String =
        prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also { id -> prefs.edit().putString("deviceId", id).apply() }

    var serverUrl: String?
        get() = prefs.getString("serverUrl", null)
        set(value) = prefs.edit().putString("serverUrl", value).apply()

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    var name: String?
        get() = prefs.getString("name", null)
        set(value) = prefs.edit().putString("name", value).apply()

    // 已傳到電腦並驗證過的檔案路徑，「清除已傳完的影片」只會刪這些
    var transferred: Set<String>
        get() = prefs.getStringSet("transferred", emptySet())!!.toSet()
        set(value) = prefs.edit().putStringSet("transferred", value).apply()

    // 電腦不認得了的影片（例如在電腦上被刪掉，或換了一台電腦）：沒傳到電腦，留在手機上，畫面上會一直提醒
    var orphans: Set<String>
        get() = prefs.getStringSet("orphans", emptySet())!!.toSet()
        set(value) = prefs.edit().putStringSet("orphans", value).apply()

    fun loadJobs(): List<UploadJob> {
        val array = JSONArray(prefs.getString("jobs", "[]"))
        return (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            UploadJob(o.getString("fileId"), o.getString("path")).apply {
                size = o.getLong("size")
                durationMs = o.getLong("durationMs")
            }
        }
    }

    fun saveJobs(jobs: List<UploadJob>) {
        val array = JSONArray()
        for (j in jobs) {
            array.put(JSONObject().put("fileId", j.fileId).put("path", j.path).put("size", j.size).put("durationMs", j.durationMs))
        }
        prefs.edit().putString("jobs", array.toString()).apply()
    }
}
