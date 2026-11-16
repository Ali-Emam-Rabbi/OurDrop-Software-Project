package com.ourdrop.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;
import android.widget.Toast;

import java.io.InputStream;

/** Full-screen image preview for a received file in Downloads. */
public class ImageViewActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_image_view);
        String name = getIntent().getStringExtra("name");
        TextView title = findViewById(R.id.imgTitle);
        if (title != null && name != null) title.setText(name);
        findViewById(R.id.imgClose).setOnClickListener(v -> finish());
        ZoomImageView view = findViewById(R.id.imgView);
        if (name == null) {
            finish();
            return;
        }
        Uri uri = Uri.parse("content://com.ourdrop.app.files/" + Uri.encode(name));
        // Decode off the UI thread, downsampled to a sane size.
        new Thread(() -> {
            Bitmap bmp = null;
            try {
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    BitmapFactory.decodeStream(in, null, bounds);
                }
                int sample = 1;
                int maxDim = 2048;
                while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) sample *= 2;
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inSampleSize = sample;
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    bmp = BitmapFactory.decodeStream(in, null, opts);
                }
            } catch (Throwable ignored) {}
            final Bitmap result = bmp;
            runOnUiThread(() -> {
                if (result != null) {
                    view.setImageBitmap(result);
                } else {
                    Toast.makeText(this, "Could not open this image", Toast.LENGTH_SHORT).show();
                    finish();
                }
            });
        }).start();
    }
}
