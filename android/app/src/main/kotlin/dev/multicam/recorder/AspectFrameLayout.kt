package dev.multicam.recorder

import android.content.Context
import android.util.AttributeSet
import android.widget.FrameLayout

// 預覽區維持 16:9，放不滿的部分留黑邊；裡面的相機畫面和構圖輔助框一起縮放
class AspectFrameLayout(context: Context, attrs: AttributeSet?) : FrameLayout(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        val (fw, fh) = if (w * 9 > h * 16) h * 16 / 9 to h else w to w * 9 / 16
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(fw, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(fh, MeasureSpec.EXACTLY),
        )
    }
}
