package com.ourdrop.app;

import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.MotionEvent;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.LinearInterpolator;
import android.view.animation.OvershootInterpolator;

/**
 * Two-second branded launch animation (native views, transform/alpha
 * only — cheap for the GPU): glow + waves start, the logo materializes,
 * the wordmark rises, a final glow pulse settles, then a smooth fade
 * into the dashboard. Tapping skips; reduced-motion shortens it.
 */
public class SplashActivity extends Activity {

    private boolean navigated = false;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_splash);

        View root = findViewById(R.id.splashRoot);
        View glow = findViewById(R.id.splashGlow);
        View logo = findViewById(R.id.splashLogo);
        View name = findViewById(R.id.splashName);
        View sub = findViewById(R.id.splashSub);
        View waveA = findViewById(R.id.waveA);
        View waveB = findViewById(R.id.waveB);

        float motionScale = 1f;
        try {
            motionScale = Settings.Global.getFloat(getContentResolver(),
                    Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
        } catch (Exception ignored) {
        }
        boolean reduced = motionScale == 0f;

        // Waves drift continuously (transform only).
        waveDrift(waveA, 9000, 90f);
        waveDrift(waveB, 13000, -70f);

        if (reduced) {
            logo.setAlpha(1f);
            glow.setAlpha(0.6f);
            name.setAlpha(1f);
            sub.setAlpha(1f);
            handler.postDelayed(this::navigate, 350);
            return;
        }

        AnimatorSet set = new AnimatorSet();
        // 0.00–0.35s: glow emerges
        ObjectAnimator glowIn = ObjectAnimator.ofFloat(glow, View.ALPHA, 0f, 0.85f);
        glowIn.setDuration(600);
        ObjectAnimator glowScaleX = ObjectAnimator.ofFloat(glow, View.SCALE_X, 0.8f, 1.15f);
        ObjectAnimator glowScaleY = ObjectAnimator.ofFloat(glow, View.SCALE_Y, 0.8f, 1.15f);
        glowScaleX.setDuration(700);
        glowScaleY.setDuration(700);
        // 0.35–0.90s: logo materializes
        ObjectAnimator logoIn = ObjectAnimator.ofFloat(logo, View.ALPHA, 0f, 1f);
        logoIn.setStartDelay(300);
        logoIn.setDuration(500);
        ObjectAnimator logoScaleX = ObjectAnimator.ofFloat(logo, View.SCALE_X, 0.82f, 1f);
        ObjectAnimator logoScaleY = ObjectAnimator.ofFloat(logo, View.SCALE_Y, 0.82f, 1f);
        ObjectAnimator logoRise = ObjectAnimator.ofFloat(logo, View.TRANSLATION_Y, 26f, 0f);
        for (ObjectAnimator a : new ObjectAnimator[]{logoScaleX, logoScaleY, logoRise}) {
            a.setStartDelay(300);
            a.setDuration(650);
            a.setInterpolator(new OvershootInterpolator(1.1f));
        }
        // 0.90–1.45s: wordmark + tagline rise in
        ObjectAnimator nameIn = ObjectAnimator.ofFloat(name, View.ALPHA, 0f, 1f);
        nameIn.setStartDelay(900);
        nameIn.setDuration(450);
        ObjectAnimator nameRise = ObjectAnimator.ofFloat(name, View.TRANSLATION_Y, 14f, 0f);
        nameRise.setStartDelay(900);
        nameRise.setDuration(450);
        ObjectAnimator subIn = ObjectAnimator.ofFloat(sub, View.ALPHA, 0f, 1f);
        subIn.setStartDelay(1050);
        subIn.setDuration(400);
        ObjectAnimator subRise = ObjectAnimator.ofFloat(sub, View.TRANSLATION_Y, 12f, 0f);
        subRise.setStartDelay(1050);
        subRise.setDuration(400);
        // 1.45–2.00s: settle glow pulse
        ObjectAnimator pulse = ObjectAnimator.ofFloat(glow, View.ALPHA, 0.85f, 0.45f, 0.85f);
        pulse.setStartDelay(1450);
        pulse.setDuration(500);
        set.playTogether(glowIn, glowScaleX, glowScaleY, logoIn, logoScaleX, logoScaleY,
                logoRise, nameIn, nameRise, subIn, subRise, pulse);
        set.setInterpolator(new AccelerateDecelerateInterpolator());
        set.start();

        handler.postDelayed(() -> {
            root.animate().alpha(0f).setDuration(240).withEndAction(this::navigate).start();
        }, 1780);
    }

    private void waveDrift(View v, int durationMs, float distance) {
        ObjectAnimator a = ObjectAnimator.ofFloat(v, View.TRANSLATION_X, -distance, distance);
        a.setDuration(durationMs);
        a.setRepeatCount(ValueAnimator.INFINITE);
        a.setRepeatMode(ValueAnimator.REVERSE);
        a.setInterpolator(new LinearInterpolator());
        a.start();
    }

    private void navigate() {
        if (navigated) return;
        navigated = true;
        // v54: straight to the dashboard — it opens with or without
        // a PC session (the old connect-first gate is gone; the
        // connect screen survives as a dismissible flow inside).
        startActivity(new Intent(this, WebViewActivity.class));
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        finish();
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        navigate();
        return super.onTouchEvent(event);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
