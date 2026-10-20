package dev.multicam.recorder

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View

// 構圖輔助框：在 16:9 預覽上標出 9:16、4:5 或 1:1 的裁切範圍，框外調暗。只是輔助，錄影照樣是 16:9。
class GuideOverlay(context: Context, attrs: AttributeSet?) : View(context, attrs) {
    private var ratio: Float? = null // 寬 / 高
    private var label = ""
    private val dp = resources.displayMetrics.density
    private val dim = Paint().apply { color = 0x66000000 }
    private val frame = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xD9FFFFFF.toInt()
        strokeWidth = 1.5f * dp
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12f, resources.displayMetrics)
        setShadowLayer(3 * dp, 0f, 0f, 0xCC000000.toInt()) // 亮的畫面上也看得清楚
    }

    // guide 是電腦傳來的設定：none、9:16、4:5、1:1
    fun setGuide(guide: String) {
        ratio = when (guide) {
            "9:16" -> 9f / 16f
            "4:5" -> 4f / 5f
            "1:1" -> 1f
            else -> null
        }
        label = guide
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val r = ratio ?: return
        val w = width.toFloat()
        val h = height.toFloat()
        val (cw, ch) = if (r < w / h) h * r to h else w to w / r
        val left = (w - cw) / 2
        val top = (h - ch) / 2
        canvas.drawRect(0f, 0f, left, h, dim)
        canvas.drawRect(left + cw, 0f, w, h, dim)
        canvas.drawRect(left, 0f, left + cw, top, dim)
        canvas.drawRect(left, top + ch, left + cw, h, dim)
        canvas.drawRect(left, top, left + cw, top + ch, frame)
        // 標在框的左下角：上方中間是錄影計時
        canvas.drawText(label, left + 8 * dp, top + ch - 10 * dp, text)
    }
}
