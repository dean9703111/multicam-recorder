package dev.multicam.recorder

import android.content.Context
import android.util.AttributeSet
import android.widget.FrameLayout

// 預覽區橫拿時維持 16:9、直拿時 9:16，放不滿的部分留黑邊；裡面的相機畫面和構圖輔助框一起縮放
class AspectFrameLayout(context: Context, attrs: AttributeSet?) : FrameLayout(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        val (rw, rh) = if (h > w) 9 to 16 else 16 to 9
        val (fw, fh) = if (w * rh > h * rw) h * rw / rh to h else w to w * rh / rw
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(fw, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(fh, MeasureSpec.EXACTLY),
        )
    }
}
