package dev.multicam.recorder

import android.content.Context
import android.util.AttributeSet
import android.view.SurfaceView

// 預覽畫面維持 16:9，放不滿的部分留黑邊
class AspectSurfaceView(context: Context, attrs: AttributeSet?) : SurfaceView(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        if (w * 9 > h * 16) setMeasuredDimension(h * 16 / 9, h) else setMeasuredDimension(w, w * 9 / 16)
    }
}
