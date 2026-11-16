package com.ourdrop.app;

import android.content.Context;
import android.graphics.Matrix;
import android.graphics.PointF;
import android.util.AttributeSet;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.widget.ImageView;

/**
 * ImageView with pinch-to-zoom, double-tap zoom and pan, implemented with
 * a plain transformation matrix (no AndroidX dependency in this build).
 */
public class ZoomImageView extends ImageView {
    private final Matrix matrix = new Matrix();
    private final float[] vals = new float[9];
    private float baseScale = 1f;
    private float minScale = 1f;
    private static final float MAX_SCALE = 6f;
    private boolean fitted = false;

    private final ScaleGestureDetector scaleDetector;
    private final GestureDetector gestureDetector;

    public ZoomImageView(Context context, AttributeSet attrs) {
        super(context, attrs);
        setScaleType(ScaleType.MATRIX);
        scaleDetector = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector d) {
                float factor = d.getScaleFactor();
                float cur = currentScale();
                float target = clamp(cur * factor, minScale, MAX_SCALE * baseScale);
                float apply = target / cur;
                matrix.postScale(apply, apply, d.getFocusX(), d.getFocusY());
                clampPan();
                setImageMatrix(matrix);
                return true;
            }
        });
        gestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDoubleTap(MotionEvent e) {
                float cur = currentScale();
                float target = cur > baseScale * 1.2f ? baseScale : baseScale * 2.5f;
                float apply = target / cur;
                matrix.postScale(apply, apply, e.getX(), e.getY());
                if (target == baseScale) fitMatrix();
                clampPan();
                setImageMatrix(matrix);
                return true;
            }

            @Override
            public boolean onScroll(MotionEvent e1, MotionEvent e2, float dx, float dy) {
                if (currentScale() > baseScale * 1.01f) {
                    matrix.postTranslate(-dx, -dy);
                    clampPan();
                    setImageMatrix(matrix);
                }
                return true;
            }
        });
    }

    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        if (!fitted && getDrawable() != null && getWidth() > 0) {
            fitMatrix();
            fitted = true;
        }
    }

    private void fitMatrix() {
        if (getDrawable() == null) return;
        float dw = getDrawable().getIntrinsicWidth();
        float dh = getDrawable().getIntrinsicHeight();
        if (dw <= 0 || dh <= 0) return;
        baseScale = Math.min(getWidth() / dw, getHeight() / dh);
        minScale = baseScale;
        matrix.reset();
        matrix.postScale(baseScale, baseScale);
        matrix.postTranslate((getWidth() - dw * baseScale) / 2f, (getHeight() - dh * baseScale) / 2f);
        setImageMatrix(matrix);
    }

    private float currentScale() {
        matrix.getValues(vals);
        return vals[Matrix.MSCALE_X];
    }

    private float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    /** Keep the image from being dragged completely off screen. */
    private void clampPan() {
        if (getDrawable() == null) return;
        matrix.getValues(vals);
        float scale = vals[Matrix.MSCALE_X];
        float w = getDrawable().getIntrinsicWidth() * scale;
        float h = getDrawable().getIntrinsicHeight() * scale;
        float x = vals[Matrix.MTRANS_X];
        float y = vals[Matrix.MTRANS_Y];
        float minX = Math.min(0, getWidth() - w);
        float minY = Math.min(0, getHeight() - h);
        float maxX = Math.max(0, getWidth() - w);
        float maxY = Math.max(0, getHeight() - h);
        // When the image is larger than the view, keep edges covering the view.
        float cx = w > getWidth() ? clamp(x, getWidth() - w, 0) : clamp(x, minX, maxX);
        float cy = h > getHeight() ? clamp(y, getHeight() - h, 0) : clamp(y, minY, maxY);
        matrix.postTranslate(cx - x, cy - y);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        scaleDetector.onTouchEvent(event);
        gestureDetector.onTouchEvent(event);
        return true;
    }
}
