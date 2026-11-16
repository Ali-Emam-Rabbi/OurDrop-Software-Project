package com.ourdrop.app;

import android.app.Activity;
import android.content.Intent;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.io.IOException;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Minimal QR scanner: legacy Camera API for frames + ZXing core for decoding.
 * (Camera API is deprecated but still functional; keeps the app dependency-light.)
 */
@SuppressWarnings("deprecation")
public class ScannerActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

    public static final String EXTRA_RESULT = "scan_result";

    private Camera camera;
    private SurfaceView preview;
    private MultiFormatReader reader;
    private final AtomicBoolean decoding = new AtomicBoolean(false);
    private volatile boolean finished = false;
    private long lastAttempt = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_scanner);
        preview = findViewById(R.id.preview);
        preview.getHolder().addCallback(this);

        reader = new MultiFormatReader();
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        try {
            camera = Camera.open();
            Camera.Parameters p = camera.getParameters();
            // Pick a modest preview size (good enough for QR, fast to decode)
            Camera.Size best = null;
            for (Camera.Size s : p.getSupportedPreviewSizes()) {
                if (s.width >= 640 && s.width <= 1280) { best = s; break; }
            }
            if (best != null) p.setPreviewSize(best.width, best.height);
            if (p.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            } else if (p.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
            }
            camera.setParameters(p);
            camera.setDisplayOrientation(90);
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(this);
            camera.startPreview();
        } catch (IOException | RuntimeException e) {
            Toast.makeText(this, "Could not open the camera", Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        // handled in surfaceCreated
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        releaseCamera();
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseCamera();
    }

    private void releaseCamera() {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
            } catch (Exception ignored) {
            }
            camera.release();
            camera = null;
        }
    }

    @Override
    public void onPreviewFrame(byte[] data, Camera cam) {
        if (finished || data == null) return;
        long now = System.currentTimeMillis();
        if (now - lastAttempt < 150) return; // throttle decode attempts
        if (!decoding.compareAndSet(false, true)) return;
        lastAttempt = now;
        try {
            Camera.Size size = cam.getParameters().getPreviewSize();
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                    data, size.width, size.height, 0, 0, size.width, size.height, false);
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = reader.decodeWithState(bitmap);
            if (result != null && result.getText() != null && !result.getText().isEmpty()) {
                finished = true;
                Intent out = new Intent();
                out.putExtra(EXTRA_RESULT, result.getText());
                setResult(RESULT_OK, out);
                finish();
            }
        } catch (ReaderException e) {
            // no code in this frame — keep scanning
        } finally {
            reader.reset();
            decoding.set(false);
        }
    }
}
