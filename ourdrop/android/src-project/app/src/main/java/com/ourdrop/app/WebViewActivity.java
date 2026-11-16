package com.ourdrop.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class WebViewActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_DEVICE = "device";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_STORAGE = 1002;
    private static final int REQ_CONNECT_FLOW = 1004;
    // v54: with no PC session, the dashboard is served from the
    // bundled copy of the web UI (APK assets) under this origin.
    // Only static files are answered locally; /api and everything
    // else is left to fail naturally, exactly like an unreachable PC.
    private static final String OFFLINE_HOST = "ourdrop.local";
    private static final String OFFLINE_URL = "https://" + OFFLINE_HOST + "/";
    private boolean offlineMode = false;
    private boolean coldStartPending = false;

    private WebView webView;
    // Manual (Files-tab) downloads started by THIS activity, by
    // DownloadManager id. Completion is announced exactly once per
    // download through the React toast (see fireDlEvent) — the entry
    // is removed before the event fires, so a repeated broadcast can
    // never announce the same file twice.
    private final java.util.Map<Long, String> manualDl = new java.util.HashMap<>();
    private android.content.BroadcastReceiver dlReceiver;
    // v56: the in-app update download (DownloadManager id + its own
    // completion receiver, kept apart from manualDl — a finished
    // update opens the install prompt instead of a file toast).
    private android.content.BroadcastReceiver updDlReceiver;
    private volatile long updateDlId = -1;
    private static final String UPDATE_APK_NAME = "OurDrop.apk";
    private ProgressBar progress;
    private ValueCallback<Uri[]> filePathCallback;

    // --- auto-receive -------------------------------------------------
    // Polling + downloading live in ReceiveService (a foreground service).
    // LOCK is shared with the service, which makes "check seen/downloaded
    // -> mark -> enqueue" atomic — a file can never download twice.
    private static final Object LOCK = ReceiveService.LOCK;

    private String baseUrl;
    private SharedPreferences prefs;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private int lastRecvCount = -1;
    private final Runnable recvWatcher = new Runnable() {
        @Override
        public void run() {
            checkServiceReceived();
            uiHandler.postDelayed(this, 2500);
        }
    };

    /** The service bumps a counter when it saves a file — mirror it here. */
    private void checkServiceReceived() {
        if (prefs == null || baseUrl == null) return;
        int count = prefs.getInt("recv_count_" + baseUrl, 0);
        if (lastRecvCount < 0) {
            lastRecvCount = count;
            return;
        }
        if (count > lastRecvCount) {
            lastRecvCount = count;
            String last = prefs.getString("recv_last_" + baseUrl, "");
            int bar = last == null ? -1 : last.lastIndexOf('|');
            if (bar > 0) {
                String name = last.substring(0, bar);
                long size = 0;
                try {
                    size = Long.parseLong(last.substring(bar + 1));
                } catch (Exception ignored) {
                }
                // No system Toast here: a Toast appears over OTHER apps
                // too and repeats per file. The web UI shows a single
                // grouped in-app indicator via __odReceived instead.
                if (webView != null) {
                    webView.evaluateJavascript(
                            "window.__odReceived&&window.__odReceived("
                                    + JSONObject.quote(name) + "," + size + ")", null);
                }
            }
        }
    }

    private String seenKey() {
        return "seen_" + baseUrl;
    }

    private String dlKey() {
        return "dl_" + baseUrl;
    }

    /** Record that a file is (being) downloaded to this phone. Caller holds LOCK. */
    private void markDownloadedLocked(String name, long size) {
        String key = name + "|" + size;
        Set<String> dl = new HashSet<>(prefs.getStringSet(dlKey(), new HashSet<>()));
        dl.add(key);
        Set<String> seen = new HashSet<>(prefs.getStringSet(seenKey(), new HashSet<>()));
        seen.add(key);
        prefs.edit().putStringSet(dlKey(), dl).putStringSet(seenKey(), seen).apply();
    }

    private boolean isDownloaded(String name, long size) {
        synchronized (LOCK) {
            Set<String> dl = prefs.getStringSet(dlKey(), new HashSet<>());
            return dl.contains(name + "|" + size);
        }
    }

    /** Bridge so the web UI can show "On this device" instead of Download. */
    public class Bridge {
        /**
         * THE device id for this phone — the same SharedPreferences value
         * ReceiveService uses. The web UI adopts it (api.ts deviceId), so
         * uploads, peer sessions and the service's own-upload skip all
         * compare against one identity.
         */
        @JavascriptInterface
        public String getDeviceId() {
            String id = prefs.getString("device_id", null);
            if (id == null) {
                id = java.util.UUID.randomUUID().toString();
                prefs.edit().putString("device_id", id).apply();
            }
            return id;
        }

        @JavascriptInterface
        public boolean isDownloaded(String name, long size) {
            return WebViewActivity.this.isDownloaded(name, size);
        }

        /**
         * The update popup (web UI) confirms it is really on screen —
         * only then is the once-per-day "shown" mark recorded (v42:
         * the popup moved into the web UI; detection stays native).
         */
        @JavascriptInterface
        public void updateDisplayed() {
            if (pendingUpdDayKey != null) {
                prefs.edit().putString("upd_shown", pendingUpdDayKey)
                        .putString("upd_diag", "shown " + pendingUpdName).apply();
                pendingUpdDayKey = null;
            }
        }

        /**
         * Manual "Check for Updates" from Settings (v45): runs the
         * same detection as the automatic triggers, but always —
         * no throttle, no already-shown skip — and reports the
         * outcome to the web UI via window.__odUpdateResult.
         */
        @JavascriptInterface
        public void checkForUpdate() {
            WebViewActivity.this.checkForUpdate(true);
        }

        /** Open a link (e.g. the update's download page) externally. */
        @JavascriptInterface
        public void openExternal(String url) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                WebViewActivity.this.startActivity(i);
            } catch (Exception ignored) {
            }
        }

        /**
         * v56: the update popup's Download button. Until v55 the web
         * UI sent the tap to openExternal, which fired ACTION_VIEW on
         * the Drive link and dumped the user onto the Drive page in
         * a browser — the in-app download+install of the v40/v41
         * native-dialog era died when the popup moved into the web
         * UI (v42). Now the APK downloads natively (DownloadManager,
         * the same machinery as file downloads) and the install
         * prompt opens when it lands — the user never leaves the
         * app. The web UI checks for this method before calling it,
         * so shells older than v56 keep the old behaviour.
         */
        @JavascriptInterface
        public void downloadUpdate(String url) {
            if (url == null || url.isEmpty()) return;
            final String direct = driveDirectDownloadUrl(url);
            runOnUiThread(() -> startUpdateDownload(direct));
        }

        /** True when the system lets OurDrop run unrestricted in the background. */
        @JavascriptInterface
        public boolean isBatteryExempt() {
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
            } catch (Exception e) {
                return true; // cannot tell — never nag
            }
        }

        /** Open the system dialog that exempts OurDrop from battery limits. */
        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(() -> askBatteryExemption());
        }

        /**
         * Open a received file (in this phone's Downloads) with the right
         * system app — gallery for images, player for videos, PDF viewer
         * for PDFs — via a secure content:// URI. Returns a status code.
         */
        @JavascriptInterface
        public String previewFile(String name) {
            try {
                if (name == null || name.contains("/") || name.contains("\\")) return "notfound";
                File f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name);
                if (!f.isFile()) return "notfound";
                // Images and videos open in OurDrop's own integrated
                // viewers (full-screen image with pinch zoom; video with
                // playback controls) — never a generic app chooser.
                String lower = name.toLowerCase(java.util.Locale.ROOT);
                if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")
                        || lower.endsWith(".webp") || lower.endsWith(".gif") || lower.endsWith(".bmp")) {
                    Intent i = new Intent(WebViewActivity.this, ImageViewActivity.class);
                    i.putExtra("name", name);
                    startActivity(i);
                    return "opened";
                }
                if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mkv")
                        || lower.endsWith(".mov") || lower.endsWith(".3gp") || lower.endsWith(".avi")) {
                    Intent i = new Intent(WebViewActivity.this, VideoPlayerActivity.class);
                    i.putExtra("name", name);
                    startActivity(i);
                    return "opened";
                }
                // PDFs open in OurDrop's own viewer (PdfRenderer) —
                // never the generic app chooser.
                if (lower.endsWith(".pdf")) {
                    Intent i = new Intent(WebViewActivity.this, PdfViewActivity.class);
                    i.putExtra("name", name);
                    startActivity(i);
                    return "opened";
                }
                // Everything else (office documents and other types)
                // goes to the device's default app for that type via a
                // plain ACTION_VIEW: if a default is set it opens
                // directly, if not the system shows its normal picker,
                // and if nothing can open it we report "noapp" so the
                // UI can show a clear message. (No forced chooser.)
                Uri uri = Uri.parse("content://com.ourdrop.app.files/" + Uri.encode(name));
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, mimeFor(name));
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getApplicationContext().startActivity(view);
                } catch (ActivityNotFoundException e) {
                    return "noapp";
                }
                return "opened";
            } catch (Exception e) {
                return "noapp";
            }
        }

        /** Live DownloadManager progress for files landing on this phone. */
        @JavascriptInterface
        public String getReceiveProgress() {
            try {
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) return "[]";
                Cursor c = dm.query(new DownloadManager.Query().setFilterByStatus(
                        DownloadManager.STATUS_RUNNING | DownloadManager.STATUS_PENDING | DownloadManager.STATUS_PAUSED));
                JSONArray arr = new JSONArray();
                if (c != null) {
                    int iT = c.getColumnIndex(DownloadManager.COLUMN_TITLE);
                    int iB = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                    int iTot = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                    int iSt = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    while (c.moveToNext()) {
                        JSONObject o = new JSONObject();
                        o.put("name", c.getString(iT));
                        o.put("received", c.getLong(iB));
                        o.put("total", c.getLong(iTot));
                        // v48: the card distinguishes a paused system
                        // download from a moving one.
                        o.put("status", c.getInt(iSt) == DownloadManager.STATUS_PAUSED ? "paused" : "downloading");
                        arr.put(o);
                    }
                    c.close();
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        /** v50: manual download from the Files list. React passes the
         * exact file name, so the destination never depends on
         * URLUtil.guessFileName — that guess could silently fail for
         * the server's RFC-5987 filename* disposition on some
         * WebViews, which left the Download tap completely dead. */
        @JavascriptInterface
        public void downloadFile(String name) {
            if (name == null || name.isEmpty() || baseUrl == null) return;
            final String url = baseUrl + "/api/download/" + Uri.encode(name);
            runOnUiThread(() -> {
                String ua = "";
                try {
                    ua = webView.getSettings().getUserAgentString();
                } catch (Exception ignored) {
                }
                startNativeDownload(url, ua, null, null, -1, name);
            });
        }

        /** v48: cancel a live auto-download from the transfer card. */
        @JavascriptInterface
        public void cancelReceive(String name) {
            ReceiveService.cancelAutoDownload(WebViewActivity.this, name);
        }

        /**
         * v54: open the native connect flow (scan QR / type the PC
         * address / pick a discovered PC) from the dashboard. The
         * flow is dismissible — Cancel returns here with no change.
         * React checks for this method before calling it, so shells
         * older than v54 simply never offer it.
         */
        @JavascriptInterface
        public void openConnectFlow() {
            runOnUiThread(() -> {
                Intent i = new Intent(WebViewActivity.this, MainActivity.class);
                i.putExtra(MainActivity.EXTRA_CONNECT_FLOW, true);
                startActivityForResult(i, REQ_CONNECT_FLOW);
            });
        }

        /** Open the system Downloads screen so the user can find received files. */
        @JavascriptInterface
        public void openDownloads() {
            uiHandler.post(() -> {
                try {
                    startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
                } catch (Exception e) {
                    Toast.makeText(WebViewActivity.this,
                            "Received files are in your Downloads folder.",
                            Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    /** Size of a shared file from the last /api/files snapshot (0 if unknown). */
    private long knownSize(String name) {
        try {
            String json = prefs.getString("files_" + baseUrl, "[]");
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (name.equals(o.getString("name"))) return o.getLong("size");
            }
        } catch (Exception ignored) {
        }
        return 0;
    }

    // ================= connection management =================
    // The WebView must NEVER show its default error page. A native
    // overlay covers it while a watchdog probes the PC (heartbeat),
    // follows it to a new IP via mDNS, and reloads when it is back.
    private View connOverlay;
    private TextView connState, connTitle, connSub;
    private View connSpinner;
    private Button btnRetry;
    private volatile boolean pageOk = false;
    private volatile boolean everConnected = false;
    private volatile String failedUrl = null;
    private long downSince = 0;
    private long backoffMs = 2000;
    private long nextProbeAt = 0;
    private int heartbeatFails = 0;
    private final AtomicBoolean probing = new AtomicBoolean(false);
    private final ExecutorService probeExec = Executors.newSingleThreadExecutor();
    private PcFinder finder;
    private ConnectivityManager.NetworkCallback netCallback;
    private volatile boolean wifiUp = true;
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            tickWatchdog();
            uiHandler.postDelayed(this, 2000);
        }
    };

    private String pairedName() {
        return prefs.getString("paired_device_name", "");
    }

    private void tickWatchdog() {
        if (offlineMode) {
            // v54: the offline dashboard stays on screen — no overlay,
            // no gate. Quietly keep probing the known PC (and follow
            // the service if it adopts a new address); a success
            // flips the WebView to the real PC origin via
            // onProbeResult → recoverLoad.
            String svcBase = prefs.getString("current_base", null);
            if (svcBase != null && !svcBase.equals(baseUrl)) {
                baseUrl = svcBase;
                nextProbeAt = 0;
            }
            if (baseUrl != null && System.currentTimeMillis() >= nextProbeAt) {
                probe(baseUrl, false);
            }
            return;
        }
        // v57: re-derive from ground truth on EVERY tick — the same
        // discipline the receive service's poll loop has always used.
        // Trusting the latched field alone could pin the Wi-Fi-off
        // gate forever in hotspot mode: with the Wi-Fi client off,
        // the TRANSPORT_WIFI-filtered callback has no network to
        // report, so nothing ever cleared a stale "off" — while the
        // service, re-deriving every tick, kept receiving underneath
        // the gate (device report 2026-11-16).
        boolean wasUp = wifiUp;
        wifiUp = detectWifi();
        if (!wifiUp) {
            showOverlayWifiOff();
            return;
        }
        if (!wasUp) {
            // The network is (back) — hotspot came up or Wi-Fi
            // returned: the same recovery the callback's onAvailable
            // performs, so the gate lifts within one tick.
            if (pageOk) {
                if (connOverlay != null) connOverlay.setVisibility(View.GONE);
            } else {
                showOverlayReconnecting();
                kickProbe();
            }
        }
        // The background service may have rediscovered the PC first.
        String svcBase = prefs.getString("current_base", null);
        if (svcBase != null && !svcBase.equals(baseUrl) && everConnected) {
            adoptBase(svcBase, true);
            return;
        }
        long now = System.currentTimeMillis();
        if (!pageOk) {
            updateOverlayTexts();
            if (now >= nextProbeAt) probe(baseUrl, false);
        } else if (now >= nextProbeAt) {
            probe(baseUrl, true); // heartbeat while connected
        }
    }

    /** Kick an immediate probe (network came back, user tapped Try Again). */
    private void kickProbe() {
        backoffMs = 2000;
        nextProbeAt = 0;
        if (!pageOk) showOverlayReconnecting();
        probe(baseUrl, false);
    }

    private void probe(final String base, final boolean heartbeat) {
        if (base == null || !probing.compareAndSet(false, true)) return;
        probeExec.execute(() -> {
            String device = null;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/info").openConnection();
                c.setConnectTimeout(2000);
                c.setReadTimeout(2000);
                StringBuilder sb = new StringBuilder();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line);
                }
                device = new JSONObject(sb.toString()).optString("device", "");
            } catch (Exception ignored) {
            }
            probing.set(false);
            final String dev = device;
            uiHandler.post(() -> onProbeResult(base, dev, heartbeat));
        });
    }

    private void onProbeResult(String base, String device, boolean heartbeat) {
        long now = System.currentTimeMillis();
        if (device != null) {
            if (!device.isEmpty()) {
                prefs.edit().putString("paired_device_name", device).apply();
            }
            coldStartPending = false;
            heartbeatFails = 0;
            backoffMs = 2000;
            nextProbeAt = now + 15000; // next heartbeat
            if (!base.equals(baseUrl)) {
                adoptBase(base, true);
            } else if (!pageOk) {
                recoverLoad();
            }
        } else {
            nextProbeAt = now + backoffMs;
            backoffMs = Math.min(15000, Math.max(2500, (long) (backoffMs * 1.8)));
            if (heartbeat) {
                heartbeatFails++;
                if (heartbeatFails >= 2 && pageOk) {
                    pageOk = false;
                    downSince = now;
                    if (webView != null) webView.setVisibility(View.INVISIBLE);
                    showOverlayReconnecting();
                    startFinder();
                } else if (heartbeatFails == 1) {
                    nextProbeAt = now + 2500; // confirm quickly before alarming
                }
            } else if (!pageOk && coldStartPending && !everConnected) {
                // v54 cold start: the known PC is not answering —
                // open the offline dashboard instead of trapping the
                // user on the reconnect overlay. The watchdog keeps
                // probing quietly and flips to the PC origin the
                // moment the PC answers.
                coldStartPending = false;
                enterOfflineMode();
                startFinder();
            } else if (!pageOk) {
                updateOverlayTexts();
                startFinder();
            }
        }
    }

    /** The PC is reachable at the current base — (re)load the page. */
    private void recoverLoad() {
        offlineMode = false;
        failedUrl = null;
        if (webView != null) webView.loadUrl(baseUrl + "/");
    }

    /**
     * v54: no PC session — show the bundled dashboard from the APK
     * assets (served by shouldInterceptRequest under OFFLINE_URL).
     * The dashboard renders fully; its API calls simply fail until
     * the user connects (or the watchdog finds the PC again).
     */
    private void enterOfflineMode() {
        offlineMode = true;
        if (connOverlay != null) connOverlay.setVisibility(View.GONE);
        if (webView != null) {
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(OFFLINE_URL);
        }
        nextProbeAt = System.currentTimeMillis() + 4000;
    }

    /** Serve one bundled dashboard file for the offline origin. */
    private android.webkit.WebResourceResponse serveBundled(String path) {
        String p = path == null ? "" : path;
        if (p.startsWith("/")) p = p.substring(1);
        String last = p.substring(p.lastIndexOf('/') + 1);
        if (p.isEmpty() || !last.contains(".")) p = "index.html"; // SPA root
        String mime = mimeForPath(p);
        try {
            java.io.InputStream in = getAssets().open("web/" + p);
            boolean text = mime.startsWith("text/") || mime.equals("application/json")
                    || mime.equals("text/javascript");
            return new android.webkit.WebResourceResponse(mime, text ? "UTF-8" : null, in);
        } catch (Exception e) {
            return null; // not bundled — let the request fail naturally
        }
    }

    private static String mimeForPath(String p) {
        String l = p.toLowerCase(java.util.Locale.ROOT);
        if (l.endsWith(".html")) return "text/html";
        if (l.endsWith(".js") || l.endsWith(".mjs")) return "text/javascript";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".json")) return "application/json";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
        if (l.endsWith(".webp")) return "image/webp";
        if (l.endsWith(".gif")) return "image/gif";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".ico")) return "image/x-icon";
        if (l.endsWith(".woff2")) return "font/woff2";
        if (l.endsWith(".woff")) return "font/woff";
        if (l.endsWith(".ttf")) return "font/ttf";
        if (l.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /** Follow the PC to a new address (IP changed / service rediscovered). */
    private void adoptBase(String newBase, boolean reload) {
        if (newBase == null || newBase.equals(baseUrl)) {
            if (reload && !pageOk) recoverLoad();
            return;
        }
        baseUrl = newBase;
        lastRecvCount = -1;
        prefs.edit()
                .putString("current_base", newBase)
                .putString("last_address", MainActivity.extractAddress(newBase))
                .apply();
        startReceiveService();
        stopFinder();
        if (reload) recoverLoad();
    }

    private void startFinder() {
        if (finder != null && finder.isRunning()) return;
        if (finder == null) {
            finder = new PcFinder(this, new PcFinder.Listener() {
                @Override
                public void onPcFound(String serviceName, String deviceName, String hostPort) {
                    String paired = pairedName();
                    if (paired != null && !paired.isEmpty() && !paired.equals(deviceName)) {
                        return; // some other PC — not ours
                    }
                    String candidate = "http://" + hostPort;
                    if (!candidate.equals(baseUrl) || !pageOk) {
                        backoffMs = 2000;
                        nextProbeAt = 0;
                        probe(candidate, false);
                    }
                }

                @Override
                public void onPcLost(String serviceName) {
                }
            });
        }
        finder.start();
    }

    private void stopFinder() {
        if (finder != null) finder.stop();
    }

    // ---- overlay states ----
    // v54: in offline mode the connection overlay NEVER covers the
    // dashboard — being unconnected is a normal state now, not a gate.
    private boolean overlaySuppressed() {
        if (!offlineMode) return false;
        if (connOverlay != null) connOverlay.setVisibility(View.GONE);
        return true;
    }

    private void showOverlayReconnecting() {
        if (connOverlay == null || overlaySuppressed()) return;
        connOverlay.setVisibility(View.VISIBLE);
        connState.setText("");
        connTitle.setText(everConnected ? "Reconnecting to your PC…" : "Connecting to your PC…");
        connSub.setText("Trying to restore your connection automatically");
        connSpinner.setVisibility(View.VISIBLE);
        btnRetry.setVisibility(View.GONE);
    }

    private void updateOverlayTexts() {
        if (overlaySuppressed()) return;
        if (connOverlay == null || connOverlay.getVisibility() != View.VISIBLE || pageOk) return;
        if (!wifiUp) {
            showOverlayWifiOff();
            return;
        }
        long now = System.currentTimeMillis();
        if (downSince == 0) downSince = now;
        if (now - downSince > 20000) {
            String paired = pairedName();
            connState.setText(paired != null && !paired.isEmpty() ? "Last PC: " + paired : "");
            connState.setTextColor(0xFFF87171);
            connTitle.setText("PC is currently unavailable");
            connSub.setText("Make sure your PC is turned on and connected to the same network. OurDrop will reconnect automatically.");
            connSpinner.setVisibility(View.GONE);
            btnRetry.setVisibility(View.VISIBLE);
        } else {
            showOverlayReconnecting();
        }
    }

    /** Wi-Fi is off: the connection is off too — show exactly that. */
    private void showOverlayWifiOff() {
        if (connOverlay == null || overlaySuppressed()) return;
        connOverlay.setVisibility(View.VISIBLE);
        connState.setText("● Not connected");
        connState.setTextColor(0xFFF87171);
        connTitle.setText("Wi-Fi is off");
        connSub.setText("OurDrop reaches your PC over Wi-Fi. Turn Wi-Fi back on — it will reconnect automatically.");
        connSpinner.setVisibility(View.GONE);
        btnRetry.setVisibility(View.GONE);
    }

    private boolean detectWifi() {
        // v57: the one shared predicate (NetState.hasLocalNetwork) —
        // this activity used to carry a weaker copy that only looked
        // at the default network, which in hotspot mode is the
        // cellular route, so the gate could read "Wi-Fi is off" on
        // the very device whose hotspot was serving the PC (and
        // whose receive service, using the full check, was happily
        // downloading underneath the gate).
        return NetState.hasLocalNetwork(this, null);
    }

    private void flashConnectedAgain() {
        if (connOverlay == null || overlaySuppressed()) return;
        connOverlay.setVisibility(View.VISIBLE);
        String paired = pairedName();
        connState.setText("● Connected");
        connState.setTextColor(0xFF4ADE80);
        connTitle.setText("Connected again!");
        connSub.setText(paired != null && !paired.isEmpty() ? "Connected to " + paired + " — ready to transfer files" : "Ready to transfer files");
        connSpinner.setVisibility(View.GONE);
        btnRetry.setVisibility(View.GONE);
        uiHandler.postDelayed(() -> {
            if (pageOk) connOverlay.setVisibility(View.GONE);
        }, 1300);
    }

    private void onPageLoadedOk() {
        boolean wasDown = connOverlay != null && connOverlay.getVisibility() == View.VISIBLE;
        pageOk = true;
        heartbeatFails = 0;
        backoffMs = 2000;
        nextProbeAt = System.currentTimeMillis() + 15000;
        if (webView != null) webView.setVisibility(View.VISIBLE);
        stopFinder();
        if (wasDown && everConnected) {
            flashConnectedAgain();
        } else if (connOverlay != null) {
            connOverlay.setVisibility(View.GONE);
        }
        everConnected = true;
        downSince = 0;
        new Handler(Looper.getMainLooper()).postDelayed(this::maybeCheckForUpdate, 1500);
    }

    /** Ask the system to exempt OurDrop from battery optimization. */
    private void askBatteryExemption() {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * One-time prompt. Without the exemption, many phones freeze the
     * background service about a minute after the app is left — the
     * foreground notification survives (the system holds it), but the
     * connection silently dies and files stop arriving. Exemption is
     * the one mechanism Android gives apps to prevent that.
     */
    @Override
    protected void onResume() {
        super.onResume();
        // v57: re-evaluate the connection gate the moment the user
        // returns to the app (e.g. after toggling the hotspot in
        // quick settings) instead of waiting for the next watchdog
        // tick; the tick itself now re-derives the predicate.
        tickWatchdog();
        maybeCheckForUpdate();
        // v56: an update APK that finished downloading while Android's
        // install-permission step was up resumes into the install
        // prompt the moment the user returns with it granted. If it
        // is still not granted we do nothing here (no settings loop)
        // — the downloaded file stays in Downloads and the next
        // update check offers the flow again.
        try {
            if (prefs != null && prefs.getBoolean("upd_install_pending", false)
                    && (Build.VERSION.SDK_INT < 26
                        || getPackageManager().canRequestPackageInstalls())) {
                File f = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS), UPDATE_APK_NAME);
                if (f.isFile()) launchApkInstall(f);
                else prefs.edit().remove("upd_install_pending").apply();
            }
        } catch (Exception ignored) {
        }
    }

    // Update check (v40; hardened in v41): read the small version.json
    // notice file from the public GitHub repo; if it names a newer
    // release than this install, offer it once per day per version.
    // Silent on ANY failure (offline, timeout, bad JSON) — never
    // bother the user with errors. The v40 build only checked once,
    // 4s after onCreate, and recorded "prompted" BEFORE the dialog
    // was shown, so on the user's phone the prompt never appeared
    // (the phone's browser loads the same file fine — network ruled
    // out on-device 2026-11-11). v41: checks are triggered from
    // onCreate, from the first successful dashboard load, and from
    // onResume (throttled to one attempt per 10 min per process);
    // "shown" is recorded ONLY after the popup is really on screen,
    // under a fresh prefs key; every outcome is noted in upd_diag.
    // v42: the popup itself is the designed in-app (web UI) popup —
    // this side only detects and dispatches, as commented below.
    private long lastUpdCheckAt = 0;
    private String pendingUpdDayKey;
    private String pendingUpdName;

    private void maybeCheckForUpdate() {
        long now = System.currentTimeMillis();
        if (now - lastUpdCheckAt < 10 * 60 * 1000L) return;
        lastUpdCheckAt = now;
        checkForUpdate();
    }

    private void checkForUpdate() {
        checkForUpdate(false);
    }

    private void checkForUpdate(boolean manual) {
        new Thread(() -> {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                long mine = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
                HttpURLConnection c = (HttpURLConnection) new URL(
                        "https://raw.githubusercontent.com/Ali-Emam-Rabbi/ourdrop/main/version.json").openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
                r.close();
                JSONObject j = new JSONObject(sb.toString());
                long latest = j.optLong("latest", 0);
                if (latest <= mine) {
                    prefs.edit().putString("upd_diag", "ok latest=" + latest + " mine=" + mine).apply();
                    if (manual) reportUpdateResult("uptodate");
                    return;
                }
                String dayKey = latest + ":" + (System.currentTimeMillis() / 86400000L);
                if (!manual && dayKey.equals(prefs.getString("upd_shown", ""))) {
                    prefs.edit().putString("upd_diag", "skip already shown " + dayKey).apply();
                    return;
                }
                String name = j.optString("name", "v" + latest);
                String notes = j.optString("notes", "");
                String apk = j.optString("apk", "");
                runOnUiThread(() -> {
                    if (isFinishing() || webView == null) return;
                    try {
                        // v42: the designed in-app popup replaces the
                        // native dialog. Detection stays here; the web
                        // UI renders the popup and confirms via
                        // Bridge.updateDisplayed(), which is what
                        // records upd_shown — a dispatch to a page
                        // that is not loaded yet confirms nothing and
                        // is retried at the next trigger.
                        JSONObject payload = new JSONObject();
                        payload.put("name", name);
                        payload.put("notes", notes);
                        payload.put("apk", apk);
                        payload.put("current", "v" + mine);
                        pendingUpdDayKey = dayKey;
                        pendingUpdName = name;
                        // v52: the payload MUST go as a JS object.
                        // Quoting it (the v42..v51 code did) made React
                        // receive a string, so the popup's name, notes,
                        // current and apk were all undefined — blank
                        // version chips, no notes, a dead Download
                        // button. payload.toString() IS the JSON text;
                        // embedding it unquoted passes a real object.
                        webView.evaluateJavascript(
                                "window.__odUpdate && window.__odUpdate("
                                        + payload.toString() + ")",
                                null);
                        prefs.edit().putString("upd_diag", "dispatched " + name).apply();
                    } catch (Exception e) {
                        prefs.edit().putString("upd_diag",
                                "dispatchfail " + e.getClass().getSimpleName() + ": " + e.getMessage()).apply();
                    }
                    if (manual) reportUpdateResult("available");
                });
            } catch (Exception e) {
                try {
                    prefs.edit().putString("upd_diag",
                            "err " + e.getClass().getSimpleName() + ": " + e.getMessage()).apply();
                } catch (Exception ignored) {
                }
                if (manual) reportUpdateResult("error");
            }
        }).start();
    }

    // Manual-check result for the Settings UI (v45).
    private void reportUpdateResult(String status) {
        runOnUiThread(() -> {
            if (isFinishing() || webView == null) return;
            webView.evaluateJavascript(
                    "window.__odUpdateResult && window.__odUpdateResult(\"" + status + "\")", null);
        });
    }

    private void maybePromptBatteryExemption() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            if (prefs == null || prefs.getBoolean("batt_asked", false)) return;
            prefs.edit().putBoolean("batt_asked", true).apply();
            // Branded explanation dialog (the user's approved design):
            // real controls, no paragraph text. "Allow" runs the same
            // system exemption flow as before; "Not Now" and the X
            // simply dismiss without granting anything.
            android.app.Dialog dlg = new android.app.Dialog(this);
            dlg.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE);
            android.view.View dv = getLayoutInflater().inflate(R.layout.dialog_battery, null);
            dv.setClipToOutline(true);
            dlg.setContentView(dv);
            if (dlg.getWindow() != null) {
                dlg.getWindow().setBackgroundDrawable(
                        new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));
                int w = (int) (getResources().getDisplayMetrics().widthPixels * 0.9);
                dlg.getWindow().setLayout(w, android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
            }
            dv.findViewById(R.id.btnBattNotNow).setOnClickListener(v -> dlg.dismiss());
            dv.findViewById(R.id.btnBattClose).setOnClickListener(v -> dlg.dismiss());
            dv.findViewById(R.id.btnBattAllow).setOnClickListener(v -> {
                dlg.dismiss();
                askBatteryExemption();
            });
            dlg.show();
        } catch (Exception ignored) {
        }
    }

    private void startReceiveService() {
        Intent svc = new Intent(this, ReceiveService.class);
        svc.putExtra(ReceiveService.EXTRA_BASE_URL, baseUrl);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_webview);

        prefs = getSharedPreferences("ourdrop", MODE_PRIVATE);
        // v54: the dashboard is no longer gated on a connection.
        // Entry cases: (1) an explicit connect (intent extra from
        // the connect flow) — load the PC origin exactly as before;
        // (2) a PC known from earlier — one quick probe decides:
        // reachable → the PC origin as before, unreachable → the
        // bundled offline dashboard; (3) no PC known yet — the
        // offline dashboard straight away.
        String url = getIntent().getStringExtra(EXTRA_URL);
        boolean explicitConnect = url != null && !url.isEmpty();
        if (!explicitConnect) {
            String known = prefs.getString("current_base", null);
            if (known != null && !known.isEmpty()) url = known;
        }
        if (url != null && !url.isEmpty()) {
            try {
                URL u = new URL(url);
                baseUrl = u.getProtocol() + "://" + u.getHost() + ":" + u.getPort();
            } catch (Exception e) {
                baseUrl = url;
            }
            prefs.edit().putString("current_base", baseUrl).apply();
        }
        String devExtra = getIntent().getStringExtra(EXTRA_DEVICE);
        if (devExtra != null && !devExtra.isEmpty()) {
            prefs.edit().putString("paired_device_name", devExtra).apply();
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1003);
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
        }
        maybePromptBatteryExemption();
        new Handler(Looper.getMainLooper()).postDelayed(this::maybeCheckForUpdate, 4000);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);
        connOverlay = findViewById(R.id.connOverlay);
        connState = findViewById(R.id.connState);
        connTitle = findViewById(R.id.connTitle);
        connSub = findViewById(R.id.connSub);
        connSpinner = findViewById(R.id.connSpinner);
        btnRetry = findViewById(R.id.btnRetry);
        btnRetry.setOnClickListener(v -> {
            downSince = System.currentTimeMillis();
            kickProbe();
            startFinder();
        });
        webView.setVisibility(View.INVISIBLE);
        wifiUp = detectWifi();
        if (wifiUp) {
            showOverlayReconnecting();
        } else {
            showOverlayWifiOff();
        }

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                return !(u.startsWith("http://") || u.startsWith("https://"));
            }

            // v54: the offline origin is served from the bundled
            // dashboard in the APK assets. Static files only — /api
            // (and anything not bundled) is NOT intercepted, so it
            // fails exactly like an unreachable PC would.
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u != null && OFFLINE_HOST.equals(u.getHost())) {
                    String path = u.getPath();
                    if (path != null && !path.startsWith("/api") && !"/ws".equals(path)) {
                        android.webkit.WebResourceResponse r = serveBundled(path);
                        if (r != null) return r;
                    }
                }
                return null;
            }

            @Override
            public void onPageStarted(WebView view, String u, android.graphics.Bitmap favicon) {
                if (u != null && !u.equals(failedUrl)) failedUrl = null;
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                if (u != null && u.equals(failedUrl)) {
                    return; // this "finished" page is the error page — stay covered
                }
                if (u != null && baseUrl != null && u.startsWith(baseUrl)) {
                    onPageLoadedOk();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    // v54: the offline dashboard never bounces to the
                    // reconnect overlay — being unconnected is a
                    // normal state now, not an error gate.
                    if (offlineMode) return;
                    Uri eu = request.getUrl();
                    if (eu != null && OFFLINE_HOST.equals(eu.getHost())) return;
                    failedUrl = request.getUrl().toString();
                    pageOk = false;
                    downSince = System.currentTimeMillis();
                    webView.setVisibility(View.INVISIBLE);
                    showOverlayReconnecting();
                    backoffMs = 2000;
                    nextProbeAt = 0;
                    startFinder();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress >= 100) {
                    progress.setVisibility(View.GONE);
                } else {
                    progress.setVisibility(View.VISIBLE);
                    progress.setProgress(newProgress);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String[] accept = params.getAcceptTypes();
                String type = "*/*";
                if (accept != null) {
                    for (String a : accept) {
                        if (a != null && !a.isEmpty() && !a.startsWith(".")) { type = a; break; }
                    }
                }
                intent.setType(type);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                        params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener((dlUrl, userAgent, contentDisposition, mimeType, contentLength) ->
                startNativeDownload(dlUrl, userAgent, contentDisposition, mimeType, contentLength));

        webView.addJavascriptInterface(new Bridge(), "OurDropAndroid");
        // Once per app generation, drop the HTTP cache so an updated PC
        // build's web UI is never masked by a stale cached copy (which
        // previously made current features look missing). localStorage —
        // history, settings, display name — is NOT touched by clearCache.
        try {
            // v54: bumped — the offline origin's index page must not
            // be served stale from a previous APK's cache either.
            // v58: bumped per the standing per-native-release rule
            // (the bridge surface itself is unchanged this release).
            final int UI_GEN = 33;
            if (prefs.getInt("ui_gen", 0) < UI_GEN) {
                webView.clearCache(true);
                prefs.edit().putInt("ui_gen", UI_GEN).apply();
            }
        } catch (Throwable ignored) {}
        if (baseUrl == null) {
            enterOfflineMode();
        } else if (explicitConnect) {
            webView.loadUrl(url);
        } else {
            // Returning launch with a known PC: the probe's verdict
            // picks the origin (onProbeResult → recoverLoad or
            // enterOfflineMode).
            coldStartPending = true;
            probe(baseUrl, false);
        }
        if (baseUrl != null) startReceiveService();
        uiHandler.postDelayed(recvWatcher, 2500);
        uiHandler.postDelayed(watchdog, 1500);

        // React instantly to Wi-Fi changes: off means the connection is
        // off (say so at once); back on means reconnect immediately.
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                netCallback = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        uiHandler.post(() -> {
                            boolean wasOff = !wifiUp;
                            wifiUp = true;
                            if (wasOff) showOverlayReconnecting();
                            kickProbe();
                        });
                    }

                    @Override
                    public void onLost(Network network) {
                        uiHandler.post(() -> {
                            // v54: hotspot counts as a local network —
                            // losing the client Wi-Fi while our own
                            // hotspot is up is NOT "Wi-Fi is off".
                            wifiUp = detectWifi();
                            if (wifiUp) {
                                kickProbe();
                                return;
                            }
                            if (offlineMode) return; // the offline dashboard just stays
                            if (pageOk) {
                                pageOk = false;
                                downSince = System.currentTimeMillis();
                                if (webView != null) webView.setVisibility(View.INVISIBLE);
                            }
                            stopFinder();
                            showOverlayWifiOff();
                        });
                    }
                };
                try {
                    cm.registerNetworkCallback(
                            new NetworkRequest.Builder()
                                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                                    .build(),
                            netCallback);
                } catch (Exception e) {
                    cm.registerDefaultNetworkCallback(netCallback);
                }
            }
        } catch (Exception ignored) {
        }
    }

    /**
     * Central extension → MIME table for opening files with the
     * device's default apps. The document types are spelled out
     * explicitly (so the right app is picked even where the platform
     * table is thin); anything else falls back to the platform
     * MimeTypeMap, then to a generic type.
     */
    static String mimeFor(String name) {
        String ext = "";
        int dot = name == null ? -1 : name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            ext = name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        }
        switch (ext) {
            case "pdf":
                return "application/pdf";
            case "doc":
                return "application/msword";
            case "docx":
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "odt":
                return "application/vnd.oasis.opendocument.text";
            case "rtf":
                return "application/rtf";
            case "xls":
                return "application/vnd.ms-excel";
            case "xlsx":
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "csv":
                return "text/csv";
            case "ods":
                return "application/vnd.oasis.opendocument.spreadsheet";
            case "ppt":
                return "application/vnd.ms-powerpoint";
            case "pptx":
                return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            case "odp":
                return "application/vnd.oasis.opendocument.presentation";
            case "txt":
                return "text/plain";
            default:
                String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                return m != null ? m : "*/*";
        }
    }

    /**
     * Announce a manual download's outcome on the SINGLE notification
     * surface — the React in-app toast. (This flow used to also fire a
     * native Toast here, so two "Downloading …" messages overlapped on
     * screen; the native Toast is gone and the React side owns every
     * announcement: "Downloading …" at tap time, then exactly one
     * completion/failure update delivered through this hook.)
     */
    private void fireDlEvent(String name, boolean ok, String err) {
        try {
            if (webView == null || name == null) return;
            String js = "window.__odDlEvent&&window.__odDlEvent("
                    + org.json.JSONObject.quote(name) + "," + ok + ","
                    + (err == null ? "null" : org.json.JSONObject.quote(err)) + ")";
            runOnUiThread(() -> {
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    /**
     * v56: a public Drive VIEW link → the direct-download form that
     * DownloadManager can fetch anonymously (no sign-in, no cookies —
     * the link is public, so this works for every user, not just the
     * owner). Non-Drive links pass through unchanged.
     * v58: the target is drive.usercontent.google.com with confirm=t —
     * the same form the PC updater uses. The older uc?export=download
     * form 303-redirects to usercontent WITHOUT the confirm flag and
     * Drive answers with its "virus scan warning" HTML page, which
     * DownloadManager happily saved as the APK (the system installer
     * then reported "problem parsing the package" on a real device,
     * 2026-11-16). The confirm=t form serves the binary directly —
     * verified live against the real release links.
     */
    static String driveDirectDownloadUrl(String url) {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("drive\\.google\\.com/file/d/([^/?#]+)")
                    .matcher(url);
            if (m.find()) {
                return "https://drive.usercontent.google.com/download?id=" + m.group(1)
                        + "&export=download&confirm=t";
            }
            m = java.util.regex.Pattern
                    .compile("drive\\.google\\.com/(?:open|uc)\\?(?:[^#]*&)?id=([^&#]+)")
                    .matcher(url);
            if (m.find()) {
                return "https://drive.usercontent.google.com/download?id=" + m.group(1)
                        + "&export=download&confirm=t";
            }
        } catch (Exception ignored) {
        }
        return url;
    }

    /** v56: enqueue the update APK with DownloadManager — the system
     * download notification shows its progress, exactly like a file
     * download; completion is handled by ensureUpdDlReceiver(). */
    private void startUpdateDownload(String directUrl) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            Toast.makeText(this, "Grant storage permission, then tap Download Update again.",
                    Toast.LENGTH_LONG).show();
            return;
        }
        try {
            // A stale APK from an earlier attempt must not block or
            // shadow this one — DownloadManager refuses a destination
            // that already exists.
            File dest = new File(Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS), UPDATE_APK_NAME);
            if (dest.isFile()) dest.delete();
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(directUrl));
            request.setMimeType("application/vnd.android.package-archive");
            request.setTitle("OurDrop update");
            request.setDescription("Downloading the OurDrop update");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, UPDATE_APK_NAME);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            updateDlId = dm.enqueue(request);
            prefs.edit().putLong("upd_dl_id", updateDlId).apply();
            ensureUpdDlReceiver();
            Toast.makeText(this, "Downloading OurDrop update…", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Update download failed — check your connection and try again.",
                    Toast.LENGTH_LONG).show();
        }
    }

    private void ensureUpdDlReceiver() {
        if (updDlReceiver != null) return;
        updDlReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id < 0 || id != updateDlId) return;
                updateDlId = -1;
                boolean ok = false;
                try {
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Cursor c = dm.query(new DownloadManager.Query().setFilterById(id));
                    if (c != null) {
                        if (c.moveToFirst()) {
                            ok = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                                    == DownloadManager.STATUS_SUCCESSFUL;
                        }
                        c.close();
                    }
                } catch (Exception ignored) {
                }
                if (ok) {
                    // v58: DownloadManager reports success for ANY bytes
                    // it fetched — including an HTML error/interstitial
                    // page saved under the APK name. Validate the payload
                    // before it can reach the installer; a bad payload
                    // becomes one clear Toast here instead of the system
                    // "problem parsing the package" dialog.
                    File f = new File(Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS), UPDATE_APK_NAME);
                    if (isValidUpdateApk(f)) {
                        promptInstallUpdate();
                    } else {
                        try {
                            f.delete();
                        } catch (Exception ignored) {
                        }
                        Toast.makeText(WebViewActivity.this,
                                "Update download failed — please try again.",
                                Toast.LENGTH_LONG).show();
                    }
                } else {
                    Toast.makeText(WebViewActivity.this,
                            "Update download failed — check your connection and try again.",
                            Toast.LENGTH_LONG).show();
                }
            }
        };
        android.content.IntentFilter f = new android.content.IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(updDlReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(updDlReceiver, f);
        }
    }

    /**
     * v58: shape check for a downloaded update payload — pure file
     * inspection: the file exists, has a plausible size (the real APK
     * is ≈4.2 MB; an HTML error page is a few KB), and starts with the
     * ZIP magic every APK begins with (PK\x03\x04). Static and free of
     * Android calls so the od58 JVM harness can exercise the exact
     * shipped code against fixtures.
     */
    static boolean hasApkShape(File f) {
        try {
            if (f == null || !f.isFile()) return false;
            if (f.length() < 1000000L) return false;
            byte[] head = new byte[4];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            try {
                if (in.read(head) != 4) return false;
            } finally {
                in.close();
            }
            return head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * v58: full validation of the downloaded update, run after the
     * DownloadManager completion and BEFORE any install intent: the
     * shape check above, plus the package manager must parse the file
     * as an archive of THIS app (package com.ourdrop.app). Anything
     * else — an HTML page, a truncated download, a foreign APK — is
     * rejected by the caller, which deletes the file and shows one
     * clear Toast instead of letting the system installer fail with
     * its parse-error dialog.
     */
    private boolean isValidUpdateApk(File f) {
        if (!hasApkShape(f)) return false;
        try {
            android.content.pm.PackageInfo info =
                    getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
            return info != null && "com.ourdrop.app".equals(info.packageName);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * v56: open the system install prompt for the downloaded APK.
     * A first-time user has not yet granted Android's "allow installs
     * from this source" permission — carry them through that system
     * step and resume into the install prompt automatically when
     * they return (see onResume); a user who already granted it goes
     * straight to the prompt. Either way the flow stays inside the
     * system installer, never a browser or a Drive page.
     */
    private void promptInstallUpdate() {
        File f = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_DOWNLOADS), UPDATE_APK_NAME);
        if (!f.isFile()) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            prefs.edit().putBoolean("upd_install_pending", true).apply();
            Toast.makeText(this, "Allow installs from OurDrop to finish the update.",
                    Toast.LENGTH_LONG).show();
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES));
                } catch (Exception ignored) {
                }
            }
            return;
        }
        launchApkInstall(f);
    }

    private void launchApkInstall(File f) {
        prefs.edit().remove("upd_install_pending").apply();
        try {
            Uri uri = Uri.parse("content://com.ourdrop.app.files/" + Uri.encode(f.getName()));
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ignored) {
        }
    }

    private void ensureDlReceiver() {
        if (dlReceiver != null) return;
        dlReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                // Remove FIRST: whatever happens next, this download
                // can only ever be announced once. Ids that are not in
                // the map (e.g. auto-receive downloads owned by
                // ReceiveService) are ignored.
                String name = manualDl.remove(id);
                if (name == null) return;
                boolean ok = false;
                try {
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Cursor c = dm.query(new DownloadManager.Query().setFilterById(id));
                    if (c != null) {
                        if (c.moveToFirst()) {
                            ok = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                                    == DownloadManager.STATUS_SUCCESSFUL;
                        }
                        c.close();
                    }
                } catch (Exception ignored) {
                }
                fireDlEvent(name, ok, null);
            }
        };
        android.content.IntentFilter f = new android.content.IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(dlReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(dlReceiver, f);
        }
    }

    private void startNativeDownload(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
        startNativeDownload(url, userAgent, contentDisposition, mimeType, contentLength, null);
    }

    private void startNativeDownload(String url, String userAgent, String contentDisposition, String mimeType, long contentLength, String forcedName) {
        String guessed = null;
        try {
            guessed = URLUtil.guessFileName(url, contentDisposition, mimeType);
        } catch (Exception ignored) {
        }
        // v50: the bridge path supplies the exact name; the listener
        // path falls back to the URL's last segment when the guess
        // fails, so a failure can still be announced by name instead
        // of being dropped silently.
        String fileName = forcedName != null ? forcedName : guessed;
        if (fileName == null) {
            try {
                fileName = Uri.decode(Uri.parse(url).getLastPathSegment());
            } catch (Exception ignored) {
            }
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            fireDlEvent(fileName, false, "Storage permission needed — grant it, then tap the download again.");
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (mimeType != null) request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) request.addRequestHeader("Cookie", cookies);
            request.setTitle(fileName);
            request.setDescription("OurDrop download");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            long id = dm.enqueue(request);
            manualDl.put(id, fileName);
            ensureDlReceiver();
            long sz = contentLength > 0 ? contentLength : knownSize(fileName);
            if (sz > 0) { // auto-receive must not fetch the same file again
                synchronized (LOCK) {
                    markDownloadedLocked(fileName, sz);
                }
            }
            // No native Toast here: the React side already showed
            // "Downloading …" when the user tapped, and the completion
            // is announced once via fireDlEvent when it lands.
        } catch (Exception e) {
            fireDlEvent(fileName, false, "Download failed: " + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CONNECT_FLOW) {
            // v54: the connect flow returns the chosen PC (or nothing
            // at all when the user cancelled — the dashboard simply
            // stays as it was).
            if (resultCode == RESULT_OK && data != null) {
                String u = data.getStringExtra(EXTRA_URL);
                if (u != null && !u.isEmpty()) {
                    String newBase;
                    try {
                        URL parsed = new URL(u);
                        newBase = parsed.getProtocol() + "://" + parsed.getHost() + ":" + parsed.getPort();
                    } catch (Exception e) {
                        newBase = u;
                    }
                    adoptBase(newBase, true);
                }
            }
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        results[i] = clip.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && pageOk && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacks(recvWatcher);
        uiHandler.removeCallbacks(watchdog);
        stopFinder();
        if (dlReceiver != null) {
            try {
                unregisterReceiver(dlReceiver);
            } catch (Exception ignored) {
            }
            dlReceiver = null;
        }
        if (updDlReceiver != null) {
            try {
                unregisterReceiver(updDlReceiver);
            } catch (Exception ignored) {
            }
            updDlReceiver = null;
        }
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && netCallback != null) cm.unregisterNetworkCallback(netCallback);
        } catch (Exception ignored) {
        }
        probeExec.shutdownNow();
        // ReceiveService keeps running: background receiving stays on.
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
