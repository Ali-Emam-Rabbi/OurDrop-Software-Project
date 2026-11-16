package com.ourdrop.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * OurDrop's built-in PDF viewer, on the framework's PdfRenderer (no
 * external library, no app chooser). Pages are rendered lazily — only
 * the visible ones, a couple ahead — and bitmaps of far-away pages are
 * recycled, so large PDFs stay within memory. Vertical scrolling,
 * page indicator, and zoom (re-render at a wider page width, panned
 * with the horizontal scroller) are supported.
 */
public class PdfViewActivity extends Activity {
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());

    private PdfRenderer renderer;
    private ParcelFileDescriptor pfd;
    private int pageCount = 0;
    private int[] pageW = new int[0];
    private int[] pageH = new int[0];
    private int[] pageTops = new int[0];
    private int[] pageHeights = new int[0];
    private ImageView[] pageViews = new ImageView[0];
    private Bitmap[] bitmaps = new Bitmap[0];
    private boolean[] rendering = new boolean[0];

    private LinearLayout pagesBox;
    private ScrollView vScroll;
    private TextView pageLabel;
    private TextView errorView;
    private float zoom = 1f;
    private int baseWidth = 0;
    private boolean destroyed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_pdf);
        String name = getIntent().getStringExtra("name");
        TextView title = findViewById(R.id.pdfTitle);
        if (title != null && name != null) title.setText(name);
        findViewById(R.id.pdfBack).setOnClickListener(v -> finish());
        pagesBox = findViewById(R.id.pdfPages);
        vScroll = findViewById(R.id.pdfScroll);
        pageLabel = findViewById(R.id.pdfPageLabel);
        errorView = findViewById(R.id.pdfError);
        findViewById(R.id.pdfZoomIn).setOnClickListener(v -> setZoom(zoom + 0.25f));
        findViewById(R.id.pdfZoomOut).setOnClickListener(v -> setZoom(zoom - 0.25f));
        vScroll.getViewTreeObserver().addOnScrollChangedListener(() -> {
            updatePageLabel();
            renderVisible();
        });
        if (name == null) {
            showError("This PDF could not be opened.");
            return;
        }
        baseWidth = getResources().getDisplayMetrics().widthPixels - dp(20);
        Uri uri = Uri.parse("content://com.ourdrop.app.files/" + Uri.encode(name));
        exec.execute(() -> {
            try {
                pfd = getContentResolver().openFileDescriptor(uri, "r");
                if (pfd == null) throw new Exception("no fd");
                renderer = new PdfRenderer(pfd);
                pageCount = renderer.getPageCount();
                if (pageCount <= 0) throw new Exception("no pages");
                pageW = new int[pageCount];
                pageH = new int[pageCount];
                for (int i = 0; i < pageCount; i++) {
                    PdfRenderer.Page p = renderer.openPage(i);
                    pageW[i] = p.getWidth();
                    pageH[i] = p.getHeight();
                    p.close();
                }
                ui.post(() -> {
                    if (destroyed) return;
                    buildPages();
                    updatePageLabel();
                    renderVisible();
                });
            } catch (Exception e) {
                ui.post(() -> showError(
                        "This PDF could not be opened. It may be corrupted or password-protected."));
            }
        });
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void showError(String msg) {
        if (destroyed) return;
        vScroll.setVisibility(View.GONE);
        errorView.setText(msg);
        errorView.setVisibility(View.VISIBLE);
    }

    private void setZoom(float z) {
        float nz = Math.max(0.75f, Math.min(2.5f, z));
        if (nz == zoom || pageCount == 0) return;
        zoom = nz;
        for (int i = 0; i < bitmaps.length; i++) {
            if (bitmaps[i] != null) {
                bitmaps[i].recycle();
                bitmaps[i] = null;
            }
            rendering[i] = false;
        }
        buildPages();
        renderVisible();
    }

    private void buildPages() {
        pagesBox.removeAllViews();
        pageViews = new ImageView[pageCount];
        bitmaps = new Bitmap[pageCount];
        rendering = new boolean[pageCount];
        pageTops = new int[pageCount];
        pageHeights = new int[pageCount];
        int w = Math.round(baseWidth * zoom);
        int top = 0;
        for (int i = 0; i < pageCount; i++) {
            int h = Math.max(40, Math.round((float) w * pageH[i] / Math.max(1, pageW[i])));
            ImageView iv = new ImageView(this);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, h);
            if (i > 0) lp.topMargin = dp(10);
            iv.setLayoutParams(lp);
            iv.setBackgroundColor(Color.WHITE);
            iv.setScaleType(ImageView.ScaleType.FIT_XY);
            iv.setContentDescription("Page " + (i + 1));
            pagesBox.addView(iv);
            pageViews[i] = iv;
            pageTops[i] = top;
            pageHeights[i] = h;
            top += h + (i > 0 ? dp(10) : 0);
        }
    }

    private void updatePageLabel() {
        if (pageCount == 0 || pageLabel == null) return;
        int y = vScroll.getScrollY();
        int cur = 0;
        for (int i = 0; i < pageCount; i++) {
            if (pageTops[i] <= y + 4) cur = i;
        }
        pageLabel.setText("Page " + (cur + 1) + " of " + pageCount);
    }

    private void renderVisible() {
        if (renderer == null || pageCount == 0 || destroyed) return;
        int y = vScroll.getScrollY();
        int vh = vScroll.getHeight();
        if (vh == 0) vh = getResources().getDisplayMetrics().heightPixels;
        int first = -1, last = -1;
        for (int i = 0; i < pageCount; i++) {
            int top = pageTops[i], bot = top + pageHeights[i];
            if (bot >= y && top <= y + vh) {
                if (first < 0) first = i;
                last = i;
            }
        }
        if (first < 0) {
            first = 0;
            last = 0;
        }
        // Recycle bitmaps of pages well outside the viewport.
        for (int i = 0; i < pageCount; i++) {
            if ((i < first - 3 || i > last + 3) && bitmaps[i] != null) {
                pageViews[i].setImageBitmap(null);
                bitmaps[i].recycle();
                bitmaps[i] = null;
            }
        }
        int from = Math.max(0, first - 1);
        int to = Math.min(pageCount - 1, last + 1);
        for (int i = from; i <= to; i++) {
            if (bitmaps[i] == null && !rendering[i]) {
                rendering[i] = true;
                final int idx = i;
                exec.execute(() -> renderPage(idx));
            }
        }
    }

    private void renderPage(int idx) {
        Bitmap bmp = null;
        try {
            if (renderer == null || destroyed) return;
            PdfRenderer.Page page = renderer.openPage(idx);
            int tw = Math.min(2200, Math.round(baseWidth * zoom));
            int th = Math.max(40, Math.round((float) tw * page.getHeight() / Math.max(1, page.getWidth())));
            bmp = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888);
            bmp.eraseColor(Color.WHITE);
            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
            page.close();
        } catch (Exception e) {
            if (bmp != null) {
                bmp.recycle();
                bmp = null;
            }
        }
        final Bitmap done = bmp;
        ui.post(() -> {
            rendering[idx] = false;
            if (destroyed) {
                if (done != null) done.recycle();
                return;
            }
            if (done != null && pageViews[idx] != null) {
                if (bitmaps[idx] != null) bitmaps[idx].recycle();
                bitmaps[idx] = done;
                pageViews[idx].setImageBitmap(done);
            }
        });
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        super.onDestroy();
        exec.shutdownNow();
        for (Bitmap b : bitmaps) {
            if (b != null) b.recycle();
        }
        try {
            if (renderer != null) renderer.close();
        } catch (Exception ignored) {
        }
        try {
            if (pfd != null) pfd.close();
        } catch (Exception ignored) {
        }
    }
}
