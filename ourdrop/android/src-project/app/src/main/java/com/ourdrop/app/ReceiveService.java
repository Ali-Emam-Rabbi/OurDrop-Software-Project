package com.ourdrop.app;

import android.Manifest;
import android.app.DownloadManager;
import android.database.Cursor;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Background receiving: a foreground service polls the PC every 4 seconds
 * and downloads new shared files with DownloadManager, so files keep
 * arriving while the app is closed or the screen is locked. The seen /
 * downloaded bookkeeping lives in the same SharedPreferences keys the
 * WebView screen uses, and LOCK is shared with it — a file can never be
 * downloaded twice.
 */
public class ReceiveService extends Service {

    public static final String EXTRA_BASE_URL = "base_url";
    public static final Object LOCK = new Object();

    private static final String CH_BG = "ourdrop_bg";
    private static final String CH_FILES = "ourdrop_files";
    private static final int FG_ID = 1001;

    private String baseUrl;
    private SharedPreferences prefs;
    private ScheduledExecutorService scheduler;
    private java.util.concurrent.ScheduledFuture<?> pollFuture;
    /** True while Wi-Fi is off: no polling, no discovery, no notification. */
    private volatile boolean dormant = false;

    /**
     * True once the PC has been confirmed unreachable: polling and the
     * foreground notification STOP; only mDNS discovery (plus a rare
     * recovery probe) stays alive so the session resumes by itself
     * when the PC returns. Persisted so a system restart of the
     * service does not resurrect polling to a dead PC.
     */
    private volatile boolean pcGone = false;
    private volatile boolean probePending = false;
    // Loop self-watchdog: pollCycle stamps lastTickAt on every tick; an
    // independent executor rebuilds the scheduler if the ticks stop
    // while the service lives. A wedged poll thread otherwise leaves a
    // zombie service — process alive, notification still saying "on",
    // but no poll ever reaching the PC, and no state transition able
    // to fire because every transition runs on the wedged thread.
    private ScheduledExecutorService watchdogExec;
    private volatile long lastTickAt = 0;
    /** Tick counter + entry time for the pc-gone posture (in-loop probes). */
    private volatile int goneTicks = 0;
    private volatile long pcGoneSince = 0;
    private volatile boolean goneLocksReleased = false;
    /** The Wi-Fi network itself (from the network callback), so the
     *  service's requests ride Wi-Fi even if Android flips the default
     *  network to mobile data while Wi-Fi stays associated. */
    private volatile android.net.Network wifiNetwork;
    /** x-od-folder header from the latest /api/files response: the
     *  identity of the PC's CURRENT storage folder. */
    private volatile String lastFolderId;
    /** x-od-boot / x-od-cancel headers from the latest /api/files
     *  response (v48): the boot id identifies this server process —
     *  a change means the PC app restarted and old download state is
     *  hopeless; the cancel list carries names the user cancelled
     *  from the PC transfer card. */
    private volatile String lastBootId;
    private volatile String lastCancelCsv;

    /**
     * Liveness locks, held ONLY while a PC session is live. Without
     * them the CPU suspends within about a minute of the screen
     * turning off and the poll executor freezes solid — the PC then
     * (correctly, from what it can see) reports the phone gone, and
     * no transfer channel survives. Released in both quiet states
     * (Wi-Fi dormancy and pc-gone) and in onDestroy, so they never
     * drain the battery for a session that is not actually live.
     */
    private android.os.PowerManager.WakeLock wakeLock;
    private android.net.wifi.WifiManager.WifiLock wifiLock;

    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "ourdrop:connection");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        } catch (Exception ignored) {
        }
        try {
            if (wifiLock == null) {
                android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int mode = android.os.Build.VERSION.SDK_INT >= 29
                            ? android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                            : android.net.wifi.WifiManager.WIFI_MODE_FULL;
                    wifiLock = wm.createWifiLock(mode, "ourdrop:wifi");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        } catch (Exception ignored) {
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {
        }
    }

    // Reconnection: after a few failed polls, follow the paired PC to a
    // new IP via mDNS instead of polling a dead address forever.
    private volatile int failCount = 0;
    private PcFinder finder;
    private ConnectivityManager.NetworkCallback netCallback;

    // Honest connection state for the persistent notification.
    private volatile boolean wifiUp = true;
    private volatile String connState = "on"; // on | searching | wifi_off

    private String seenKey() {
        return "seen_" + baseUrl;
    }

    private String dlKey() {
        return "dl_" + baseUrl;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("ourdrop", MODE_PRIVATE);
        createChannels();
        // pc-gone is deliberately NOT persisted anymore: a persisted
        // quiet posture latched across service restarts and could keep
        // the phone silent forever. State is re-derived live instead —
        // clear any stale flag left by older versions.
        prefs.edit().remove("pc_gone").apply();
        pcGone = false;
        wifiUp = detectWifi();
        connState = wifiUp ? "on" : "wifi_off";
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                netCallback = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        // Remember the Wi-Fi network itself: service
                        // requests bind to it, so they keep working even
                        // if the default network flips to mobile data.
                        wifiNetwork = network;
                        // Wi-Fi is back: re-check right away (the poll
                        // loop itself decides the resulting state). While
                        // the PC is marked gone, a single confirm probe —
                        // not the full poll — decides about resuming.
                        wifiUp = true;
                        failCount = 0;
                        if (pcGone) {
                            scheduleConfirmProbe();
                        } else if (scheduler != null) {
                            scheduler.schedule(() -> pollSafely(), 300, TimeUnit.MILLISECONDS);
                        }
                    }

                    @Override
                    public void onLost(Network network) {
                        if (network.equals(wifiNetwork)) wifiNetwork = null;
                        // v54: a lost client network only means "no
                        // network" when the phone's own hotspot is not
                        // providing one either — re-derive first.
                        if (detectWifi()) {
                            wifiUp = true;
                            return;
                        }
                        // Wi-Fi went off — go dormant at once: polling
                        // and discovery stop and the notification is
                        // removed instead of lingering on screen.
                        wifiUp = false;
                        enterDormant();
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

    private boolean detectWifi() {
        // v57: the one shared predicate — NetState.hasLocalNetwork
        // holds this method's original logic verbatim; the dashboard
        // activity now calls the same code (its own weaker copy is
        // what let the two disagree in hotspot mode).
        return NetState.hasLocalNetwork(this, wifiNetwork);
    }

    /** Open a connection bound to the Wi-Fi network when it is known,
     *  so service traffic is immune to default-network flips. */
    private HttpURLConnection openConn(String url) throws Exception {
        Network w = wifiNetwork;
        if (w != null) {
            try {
                return (HttpURLConnection) w.openConnection(new URL(url));
            } catch (Exception ignored) {
                // fall through to the default route
            }
        }
        return (HttpURLConnection) new URL(url).openConnection();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String target = intent != null ? intent.getStringExtra(EXTRA_BASE_URL) : null;
        // An explicit start (the user just connected in the app) always
        // begins a fresh session. A system restart simply re-derives
        // the state live — no posture is persisted anymore.
        boolean explicit = target != null;
        if (explicit && pcGone) pcGone = false;
        if (target == null) target = prefs.getString("current_base", null);
        if (target == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        boolean changed = !target.equals(baseUrl);
        baseUrl = target;
        prefs.edit().putString("current_base", baseUrl).apply();
        startForeground(FG_ID, buildNotification());
        if (scheduler == null || changed) {
            if (scheduler != null) scheduler.shutdownNow();
            scheduler = Executors.newSingleThreadScheduledExecutor();
            pollFuture = null;
        }
        ensureLoop();
        lastTickAt = System.currentTimeMillis();
        if (watchdogExec == null) {
            watchdogExec = Executors.newSingleThreadScheduledExecutor();
            watchdogExec.scheduleWithFixedDelay(() -> {
                try {
                    if (scheduler == null || pollFuture == null) return;
                    if (System.currentTimeMillis() - lastTickAt <= 20000) return;
                    // No tick for 20s although the service is alive —
                    // the loop thread is wedged. Abandon and rebuild.
                    try { pollFuture.cancel(true); } catch (Exception ignored) {}
                    try { scheduler.shutdownNow(); } catch (Exception ignored) {}
                    scheduler = Executors.newSingleThreadScheduledExecutor();
                    pollFuture = null;
                    lastTickAt = System.currentTimeMillis();
                    acquireLocks();
                    ensureLoop();
                } catch (Throwable ignored) {
                }
            }, 15, 15, TimeUnit.SECONDS);
        }
        if (!detectWifi()) {
            enterDormant();
        } else if (pcGone) {
            enterPcGone();
        }
        // Locks are held for a live session AND while the PC is marked
        // gone (the recovery probes need a running CPU); they are
        // released only in Wi-Fi dormancy and on destroy.
        if (!dormant) acquireLocks();
        return START_STICKY;
    }

    /**
     * The ONE poll loop for the service's whole life. Nothing cancels
     * it — states are handled inside pollCycle. (Cancelling it was the
     * latch bug: revival then depended on a network-callback
     * transition that might never fire.)
     */
    private void ensureLoop() {
        if (scheduler == null) return;
        if (pollFuture == null || pollFuture.isCancelled()) {
            pollFuture = scheduler.scheduleWithFixedDelay(this::pollSafely, 1, 2, TimeUnit.SECONDS);
        }
    }

    private void pollSafely() {
        try {
            pollCycle();
        } catch (Throwable ignored) {
            // The poll loop must NEVER die: scheduleWithFixedDelay stops
            // forever if a run throws, which would silently kill
            // auto-receive until the app is reopened.
        }
    }

    private void pollCycle() {
        lastTickAt = System.currentTimeMillis(); // watchdog heartbeat
        // The state is re-derived from ground truth on EVERY tick of
        // the never-cancelled loop, so no state can latch: dormancy is
        // just "check Wi-Fi again next tick" (a local call, zero
        // network traffic, notification stays removed), and pc-gone
        // probes the PC from inside the loop every ~10s.
        wifiUp = detectWifi();
        if (!wifiUp) {
            if (!dormant) enterDormant();
            return;
        }
        if (dormant) resumeFromDormant();
        if (pcGone) {
            goneTicks++;
            // After 10 continuous minutes gone, stop holding the CPU
            // awake for a PC that is probably off; the loop, the
            // finder and the network callbacks still notice its return
            // whenever the device wakes for anything else.
            if (!goneLocksReleased && System.currentTimeMillis() - pcGoneSince > 10 * 60 * 1000L) {
                goneLocksReleased = true;
                releaseLocks();
            }
            // Probe EVERY tick (~2s) while the PC is marked gone:
            // recovery then lands within a few seconds of the path
            // returning, instead of up to ~10s later — each flap's
            // total silence stays far below the PC's gone threshold.
            if (probePc()) resumeFromPcGone();
            return;
        }
        try {
            poll();
            reportRxProgress();
            if (failCount != 0) {
                failCount = 0;
                stopFinder();
            }
            setConnState("on");
        } catch (Exception ignored) {
            // PC unreachable this round — do not wait for several slow
            // cycles: confirm with one fast probe (~1s later) and, if
            // the PC is really gone, go quiet immediately.
            failCount++;
            scheduleConfirmProbe();
        }
    }

    /** One fast reachability check, shortly after a failed poll. */
    private void scheduleConfirmProbe() {
        if (probePending || dormant || scheduler == null) return;
        probePending = true;
        try {
            scheduler.schedule(() -> {
                probePending = false;
                if (dormant) return;
                if (probePc()) {
                    if (pcGone) {
                        resumeFromPcGone();
                    } else {
                        failCount = 0;
                    }
                } else if (!detectWifi()) {
                    // Our own Wi-Fi dropped mid-check — that is
                    // dormancy's case, not a vanished PC.
                    enterDormant();
                } else if (!pcGone) {
                    enterPcGone();
                }
            }, 800, TimeUnit.MILLISECONDS);
        } catch (Exception ignored) {
            probePending = false;
        }
    }

    private boolean probePc() {
        if (baseUrl == null) return false;
        // Both routes, like httpGetText: bound first, default second.
        return probeOnce(true) || probeOnce(false);
    }

    private boolean probeOnce(boolean bound) {
        HttpURLConnection c = null;
        try {
            c = bound ? openConn(baseUrl + "/api/info")
                    : (HttpURLConnection) new URL(baseUrl + "/api/info").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1200);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * The PC is confirmed unreachable: stop hammering it and REMOVE
     * the foreground notification — but the loop keeps ticking (it
     * probes from inside pollCycle every ~10s), mDNS discovery keeps
     * watching, and the locks stay held for the first 10 minutes so
     * the recovery machinery actually gets CPU time. Pairing data,
     * files and history are untouched.
     */
    private void enterPcGone() {
        if (pcGone) {
            // Already gone — just make sure discovery is watching.
            startFinder();
            return;
        }
        pcGone = true;
        pcGoneSince = System.currentTimeMillis();
        goneTicks = 0;
        goneLocksReleased = false;
        connState = "searching";
        try {
            stopForeground(true);
        } catch (Exception ignored) {
        }
        startFinder();
    }

    /** The PC is back: full session again — foreground + live polls. */
    private void resumeFromPcGone() {
        if (!pcGone) return;
        pcGone = false;
        acquireLocks();
        failCount = 0;
        stopFinder();
        connState = "searching";
        try {
            startForeground(FG_ID, buildNotification());
        } catch (Exception ignored) {
        }
    }

    /** Single doorway for state changes: posts ONLY on real transitions. */
    private void setConnState(String next) {
        if (next.equals(connState)) return;
        connState = next;
        if (dormant || pcGone) return; // no notification in either quiet state
        applyNotification();
    }

    /**
     * Wi-Fi is off: go fully quiet. Polling and discovery stop and the
     * foreground notification is REMOVED (stopForeground) rather than
     * sitting on screen saying "Wi-Fi is off". Only the lightweight
     * network callback stays registered, so the moment a Wi-Fi network
     * returns, the service wakes itself up via resumeFromDormant().
     * Paired-PC data, received files and history are never touched.
     */
    private void enterDormant() {
        releaseLocks();
        connState = "wifi_off";
        // Wi-Fi loss supersedes pc-gone; the state is re-derived from
        // scratch when Wi-Fi returns. The loop is NOT cancelled: it
        // keeps re-checking Wi-Fi locally every tick, so a transient
        // mis-read can never strand the service in this state.
        pcGone = false;
        stopFinder();
        if (dormant) return;
        dormant = true;
        try {
            stopForeground(true);
        } catch (Exception ignored) {
        }
    }

    /** Wi-Fi is back: become a normal foreground service again; the
     *  loop (which never stopped) is already ticking, and the first
     *  successful poll flips the state from "searching" to "on". */
    private void resumeFromDormant() {
        if (!dormant) return;
        dormant = false;
        acquireLocks();
        connState = "searching";
        try {
            startForeground(FG_ID, buildNotification());
        } catch (Exception ignored) {
        }
    }

    private void startFinder() {
        if (finder != null && finder.isRunning()) return;
        if (finder == null) {
            finder = new PcFinder(this, new PcFinder.Listener() {
                @Override
                public void onPcFound(String serviceName, String deviceName, String hostPort) {
                    adoptIfOurs("http://" + hostPort, deviceName);
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

    /** A PC announced itself — adopt it if it is our paired PC. */
    private void adoptIfOurs(String candidate, String announcedDevice) {
        if (candidate.equals(baseUrl)) {
            failCount = 0;
            if (pcGone) {
                resumeFromPcGone();
            } else {
                stopFinder();
            }
            return;
        }
        try {
            HttpURLConnection c = openConn(candidate + "/api/info");
            c.setConnectTimeout(2500);
            c.setReadTimeout(2500);
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            String device = new JSONObject(sb.toString()).optString("device", announcedDevice);
            String paired = prefs.getString("paired_device_name", "");
            if (paired != null && !paired.isEmpty() && !paired.equals(device)) {
                return; // a different PC on the same Wi-Fi — not ours
            }
            baseUrl = candidate;
            failCount = 0;
            prefs.edit()
                    .putString("current_base", candidate)
                    .putString("last_address", MainActivity.extractAddress(candidate))
                    .putString("paired_device_name", device)
                    .apply();
            stopFinder();
            if (pcGone) {
                resumeFromPcGone();
            } else {
                startForeground(FG_ID, buildNotification());
            }
        } catch (Exception ignored) {
            // Not reachable after all — keep looking.
        }
    }

    /**
     * GET a URL as text, trying the Wi-Fi-bound route first and the
     * default route as a fallback within the SAME attempt. The bound
     * route pins traffic to Wi-Fi, but its captured Network object can
     * go stale across a roam or band switch; if that route fails, the
     * other route may still reach the PC — one dead route must never
     * black out a whole poll cycle (that is how brief network flaps
     * used to add up to a PC-side "device disconnected").
     */
    private String httpGetText(String url) throws Exception {
        try {
            return readGet(openConn(url));
        } catch (Exception first) {
            return readGet((HttpURLConnection) new URL(url).openConnection());
        }
    }

    private String readGet(HttpURLConnection c) throws Exception {
        c.setRequestProperty("x-od-id", deviceId());
        c.setRequestProperty("x-od-device", deviceLabel());
        c.setConnectTimeout(2000);
        c.setReadTimeout(2000);
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
            String fid = c.getHeaderField("x-od-folder");
            if (fid != null) lastFolderId = fid;
            String boot = c.getHeaderField("x-od-boot");
            if (boot != null) lastBootId = boot;
            String canc = c.getHeaderField("x-od-cancel");
            if (canc != null) lastCancelCsv = canc;
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        } finally {
            c.disconnect();
        }
        return sb.toString();
    }

    private void poll() throws Exception {
        String body = httpGetText(baseUrl + "/api/files");
        handleServerIdentity();
        // (The x-od-folder header is still captured in readGet, but
        // auto-receive no longer needs folder-change detection: the
        // loop below never auto-downloads storage-folder files at
        // all — see the receive-only gate there.)
        JSONArray arr = new JSONArray(body);
        List<String[]> fresh = new ArrayList<>();
        synchronized (LOCK) {
            prefs.edit().putString("files_" + baseUrl, body).apply();
            Set<String> seen = new HashSet<>(prefs.getStringSet(seenKey(), new HashSet<>()));
            Set<String> cancelledPairs = new HashSet<>(prefs.getStringSet("cancelled_pairs", new HashSet<>()));
            boolean firstSync = !prefs.contains(seenKey());
            long nowSec = System.currentTimeMillis() / 1000;
            long nowMs = System.currentTimeMillis();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String name = o.getString("name");
                long size = o.getLong("size");
                long mtime = o.optLong("mtime", 0);
                boolean isOutbox = o.optBoolean("outbox", false);
                long offeredAt = o.optLong("offeredAt", 0);
                // Identity (v48): an outbox offer is identified by its
                // OFFER stamp, not the file's mtime. Pressing Send
                // again — after an interruption, a failure, anything —
                // creates a new offer with a new stamp, so the file
                // genuinely downloads again. (Before, the identity was
                // name|size|file-mtime PLUS a permanent name|size
                // record: a re-send of the same file could never be
                // fetched again, ever.)
                long stamp = isOutbox && offeredAt > 0 ? offeredAt : mtime;
                String key = name + "|" + size + "|" + stamp;
                String pairKey = name + "|" + size;
                if (seen.contains(key)) {
                    continue;
                }
                if (!isOutbox && seen.contains(pairKey)) {
                    seen.add(key); // legacy record upgrade — non-offers only
                    continue;
                }
                // The user cancelled THIS offer (either side's card):
                // records are pair|epochMs; an offer stamped before
                // the cancel stays cancelled, a re-send (newer stamp)
                // is a new offer and downloads normally.
                boolean userCancelled = false;
                for (String cp : cancelledPairs) {
                    if (cp.startsWith(pairKey + "|")) {
                        try {
                            if (Long.parseLong(cp.substring(pairKey.length() + 1)) >= stamp) userCancelled = true;
                        } catch (Exception ignored) {
                        }
                    }
                }
                if (userCancelled) {
                    seen.add(key);
                    continue;
                }
                // The PC storage folder is a RECEIVE-ONLY destination
                // (the user's explicit rule): a file sitting in it is
                // NEVER an automatic send — not when the folder is
                // selected, not when a file is later copied into it,
                // not on reconnect or on restart. Only genuine sends
                // are auto-received: outbox offers, created when the
                // PC user presses Send in the app. (This replaces the
                // v29/v30 folder-change baseline, which tried to tell
                // "old" folder files from "new" ones and missed cases;
                // the receive-only rule has no cases to miss.)
                if (!isOutbox) {
                    seen.add(key);
                    continue;
                }
                // NEVER download back a file THIS phone uploaded: the
                // server records the uploader's device id as the file's
                // origin; our own uploads are only marked seen above.
                if (deviceId().equals(o.optString("origin", ""))) {
                    seen.add(key);
                    continue;
                }
                // A recently failed download backs off instead of
                // retrying on every poll — WITHOUT being marked seen,
                // so the retry really happens when the delay passes.
                long retryAt = prefs.getLong("retryat_" + baseUrl + "_" + pairKey, 0);
                if (retryAt > nowSec) {
                    continue;
                }
                seen.add(key);
                // On a first sync, old files are only marked — but a file
                // sent moments ago must still arrive automatically.
                if (!firstSync || (mtime > 0 && nowSec - mtime < 600) || (offeredAt > 0 && nowMs - offeredAt < 600000)) {
                    fresh.add(new String[]{name, String.valueOf(size), String.valueOf(stamp)});
                }
            }
            prefs.edit().putStringSet(seenKey(), seen).apply();
        }
        for (String[] f : fresh) enqueueDownload(f[0], Long.parseLong(f[1]), Long.parseLong(f[2]));
    }

    /**
     * v48: act on the identity signals riding the /api/files response.
     * A changed boot id means the PC app restarted: downloads tied to
     * the old process can never finish (their offers died with it), so
     * purge them and their marks — nothing stays frozen, and a re-send
     * starts clean. The cancel list carries names the user cancelled
     * from the PC transfer card.
     */
    private void handleServerIdentity() {
        try {
            String boot = lastBootId;
            if (boot != null) {
                String prev = prefs.getString("pc_boot", null);
                if (prev == null) {
                    prefs.edit().putString("pc_boot", boot).apply();
                } else if (!prev.equals(boot)) {
                    prefs.edit().putString("pc_boot", boot).apply();
                    purgeStaleDownloads();
                }
            }
        } catch (Exception ignored) {
        }
        try {
            String csv = lastCancelCsv;
            lastCancelCsv = null;
            if (csv != null && !csv.isEmpty()) {
                for (String enc : csv.split(",")) {
                    try {
                        cancelAutoDownload(this, java.net.URLDecoder.decode(enc, "UTF-8"));
                    } catch (Exception ignored) {
                    }
                }
            }
        } catch (Exception ignored) {
        }
    }

    /** Remove every tracked download (the PC they belonged to is
     *  gone) plus the marks that would veto their re-send. */
    private void purgeStaleDownloads() {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            JSONObject map = new JSONObject(prefs.getString("rx_map", "{}"));
            java.util.Iterator<String> ks = map.keys();
            List<String> pairs = new ArrayList<>();
            while (ks.hasNext()) {
                String idStr = ks.next();
                String ns = map.optString(idStr, "");
                if (!ns.isEmpty()) pairs.add(ns);
                if (dm != null) {
                    try {
                        dm.remove(Long.parseLong(idStr));
                    } catch (Exception ignored) {
                    }
                }
            }
            prefs.edit().putString("rx_map", "{}").apply();
            synchronized (LOCK) {
                for (String prefKey : new String[]{seenKey(), dlKey()}) {
                    Set<String> set = new HashSet<>(prefs.getStringSet(prefKey, new HashSet<>()));
                    boolean changed = false;
                    for (String pair : pairs) {
                        changed |= set.remove(pair);
                        java.util.Iterator<String> it = set.iterator();
                        while (it.hasNext()) {
                            if (it.next().startsWith(pair + "|")) {
                                it.remove();
                                changed = true;
                            }
                        }
                    }
                    if (changed) prefs.edit().putStringSet(prefKey, set).apply();
                }
            }
            // dm.remove() deletes the files it manages; sweep any
            // incomplete leftover of a purged download as well.
            for (String pair : pairs) {
                try {
                    String nm = pair.substring(0, pair.lastIndexOf('|'));
                    long tot = Long.parseLong(pair.substring(pair.lastIndexOf('|') + 1));
                    File f = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), nm);
                    if (f.exists() && f.length() < tot) f.delete();
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
    }

    /**
     * Cancel a live auto-download — from the PC card (via the
     * x-od-cancel header) or from this phone's own card (the bridge).
     * Removes the DownloadManager entry (which deletes its partial
     * file), forgets the tracking, records the cancellation against
     * this offer so the poll does not immediately re-fetch it, and
     * tells the PC once. A re-send is a new offer and downloads
     * normally. Static: callable without a service instance.
     */
    public static void cancelAutoDownload(Context ctx, String name) {
        try {
            SharedPreferences pr = ctx.getSharedPreferences("ourdrop", Context.MODE_PRIVATE);
            String base = pr.getString("current_base", null);
            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            long size = -1;
            synchronized (LOCK) {
                JSONObject map = new JSONObject(pr.getString("rx_map", "{}"));
                java.util.Iterator<String> ks = map.keys();
                List<String> removeKeys = new ArrayList<>();
                while (ks.hasNext()) {
                    String idStr = ks.next();
                    String ns = map.optString(idStr, "");
                    if (ns.startsWith(name + "|")) {
                        removeKeys.add(idStr);
                        try {
                            size = Long.parseLong(ns.substring(name.length() + 1));
                        } catch (Exception ignored) {
                        }
                        if (dm != null) {
                            try {
                                dm.remove(Long.parseLong(idStr));
                            } catch (Exception ignored) {
                            }
                        }
                    }
                }
                for (String k : removeKeys) map.remove(k);
                pr.edit().putString("rx_map", map.toString()).apply();
                if (size >= 0) {
                    Set<String> canc = new HashSet<>(pr.getStringSet("cancelled_pairs", new HashSet<>()));
                    canc.add(name + "|" + size + "|" + System.currentTimeMillis());
                    pr.edit().putStringSet("cancelled_pairs", canc).apply();
                }
            }
            // One-shot "cancelled" report so the PC card clears at once
            // (best effort — the server's own cancel flag / staleness
            // covers it if this post cannot land).
            if (base != null && size >= 0) {
                try {
                    JSONObject item = new JSONObject()
                            .put("name", name)
                            .put("received", 0)
                            .put("total", size)
                            .put("status", "cancelled");
                    JSONObject body = new JSONObject().put("items", new JSONArray().put(item));
                    HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/rx-progress").openConnection();
                    c.setRequestMethod("POST");
                    c.setRequestProperty("Content-Type", "application/json");
                    String did = pr.getString("device_id", "");
                    c.setRequestProperty("x-od-id", did);
                    c.setConnectTimeout(2000);
                    c.setReadTimeout(2000);
                    c.setDoOutput(true);
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    }
                    c.getResponseCode();
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
    }

    private boolean lastRxActive = false;

    /**
     * Report live DownloadManager progress to the PC, so the PC app can
     * mirror "downloading on your phone" in real time. Finished or
     * vanished downloads are pruned from the tracking map.
     */
    private void reportRxProgress() {
        try {
            JSONObject map = new JSONObject(prefs.getString("rx_map", "{}"));
            if (map.length() == 0 && !lastRxActive) return;
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return;
            java.util.Iterator<String> keys = map.keys();
            java.util.List<Long> idList = new ArrayList<>();
            while (keys.hasNext()) {
                try {
                    idList.add(Long.parseLong(keys.next()));
                } catch (Exception ignored) {
                }
            }
            JSONArray items = new JSONArray();
            JSONObject alive = new JSONObject();
            if (!idList.isEmpty()) {
                long[] ids = new long[idList.size()];
                for (int i = 0; i < ids.length; i++) ids[i] = idList.get(i);
                Cursor c = dm.query(new DownloadManager.Query().setFilterById(ids));
                if (c != null) {
                    int iId = c.getColumnIndex(DownloadManager.COLUMN_ID);
                    int iSt = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    int iGot = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                    int iTot = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                    while (c.moveToNext()) {
                        String key = String.valueOf(c.getLong(iId));
                        String ns = map.optString(key, null);
                        if (ns == null) continue;
                        int st = c.getInt(iSt);
                        String name = ns.substring(0, ns.lastIndexOf('|'));
                        if (st == DownloadManager.STATUS_RUNNING
                                || st == DownloadManager.STATUS_PENDING
                                || st == DownloadManager.STATUS_PAUSED) {
                            items.put(new JSONObject()
                                    .put("name", name)
                                    .put("received", c.getLong(iGot))
                                    .put("total", c.getLong(iTot))
                                    .put("status", st == DownloadManager.STATUS_PAUSED ? "paused" : "downloading"));
                            alive.put(key, ns);
                        } else if (st == DownloadManager.STATUS_SUCCESSFUL) {
                            // One terminal report so the PC card can
                            // complete and clear at once (and a
                            // range-based download still completes its
                            // offer server-side). Dropped from tracking
                            // below; the seen marks stay — it arrived.
                            long tot = 0;
                            try {
                                tot = Long.parseLong(ns.substring(ns.lastIndexOf('|') + 1));
                            } catch (Exception ignored) {
                            }
                            items.put(new JSONObject()
                                    .put("name", name)
                                    .put("received", tot)
                                    .put("total", tot)
                                    .put("status", "done"));
                            // Success resets the failure backoff.
                            prefs.edit()
                                    .remove("failcnt_" + baseUrl + "_" + ns)
                                    .remove("retryat_" + baseUrl + "_" + ns)
                                    .apply();
                        } else if (st == DownloadManager.STATUS_FAILED) {
                            // Report it once (the PC card shows the
                            // failure instead of a frozen bar), then
                            // unmark with backoff so a later poll can
                            // offer a fresh attempt.
                            items.put(new JSONObject()
                                    .put("name", name)
                                    .put("received", c.getLong(iGot))
                                    .put("total", c.getLong(iTot))
                                    .put("status", "failed"));
                            unmarkFailedDownload(ns);
                        }
                    }
                    c.close();
                }
            }
            prefs.edit().putString("rx_map", alive.toString()).apply();
            if (items.length() == 0 && !lastRxActive) return;
            lastRxActive = items.length() > 0;
            JSONObject body = new JSONObject().put("items", items);
            postRx(body.toString());
        } catch (Exception ignored) {
        }
    }

    /** POST the rx-progress JSON, Wi-Fi-bound first, default route as
     *  fallback — same dual-route rule as httpGetText. Progress posts
     *  also refresh the peer's liveness on the PC, so they matter to
     *  connection stability, not just to the progress display. */
    private void postRx(String json) throws Exception {
        try {
            postRxVia(openConn(baseUrl + "/api/rx-progress"), json);
        } catch (Exception first) {
            postRxVia((HttpURLConnection) new URL(baseUrl + "/api/rx-progress").openConnection(), json);
        }
    }

    private void postRxVia(HttpURLConnection c, String json) throws Exception {
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("x-od-id", deviceId());
        c.setRequestProperty("x-od-device", deviceLabel());
        c.setConnectTimeout(2000);
        c.setReadTimeout(2000);
        c.setDoOutput(true);
        try (OutputStream os = c.getOutputStream()) {
            os.write(json.getBytes(StandardCharsets.UTF_8));
        }
        c.getResponseCode();
        c.disconnect();
    }

    /**
     * A DownloadManager attempt failed (network froze mid-download, PC
     * blinked, storage hiccup). The file's seen/downloaded marks came
     * from poll()/enqueueDownload() BEFORE the attempt, so without this
     * cleanup the file would be treated as handled forever and never
     * offered again. Remove its marks so a later poll can retry — but
     * with a growing backoff instead of the old hard cap: the cap left
     * files permanently undownloadable after 3 failures (a re-send
     * could never revive them). Delays: immediate, 30 s, 2 min,
     * 10 min, then 30 min — a dead file never hot-loops the poll,
     * and a healthy re-send always gets through (a new offer carries
     * a new identity anyway; the backoff only throttles THIS offer).
     */
    private void unmarkFailedDownload(String pairKey) {
        try {
            // v49: delete this attempt's incomplete leftover in
            // Downloads NOW, while the pair is still known to be ours.
            // reportRxProgress prunes the failed entry from rx_map in
            // the same pass, so by the time a later poll re-enqueues
            // the file, enqueueDownload's own leftover cleanup (which
            // keys off rx_map) can no longer find it — the orphaned
            // partial then made DownloadManager save the re-send as
            // "name (1).ext". A complete file (length == size) and
            // anything not tracked as ours are never touched.
            try {
                int cut = pairKey.lastIndexOf('|');
                if (cut > 0) {
                    String nm = pairKey.substring(0, cut);
                    long tot = Long.parseLong(pairKey.substring(cut + 1));
                    File leftover = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), nm);
                    if (tot > 0 && leftover.exists() && leftover.length() < tot) leftover.delete();
                }
            } catch (Exception ignored) {
            }
            String cntKey = "failcnt_" + baseUrl + "_" + pairKey;
            int fails = prefs.getInt(cntKey, 0) + 1;
            prefs.edit().putInt(cntKey, fails).apply();
            long delaySec = fails <= 1 ? 0 : fails == 2 ? 30 : fails == 3 ? 120 : fails == 4 ? 600 : 1800;
            prefs.edit().putLong("retryat_" + baseUrl + "_" + pairKey,
                    System.currentTimeMillis() / 1000 + delaySec).apply();
            synchronized (LOCK) {
                for (String prefKey : new String[]{seenKey(), dlKey()}) {
                    Set<String> set = new HashSet<>(prefs.getStringSet(prefKey, new HashSet<>()));
                    boolean changed = set.remove(pairKey);
                    java.util.Iterator<String> it = set.iterator();
                    while (it.hasNext()) {
                        if (it.next().startsWith(pairKey + "|")) {
                            it.remove();
                            changed = true;
                        }
                    }
                    if (changed) prefs.edit().putStringSet(prefKey, set).apply();
                }
            }
        } catch (Exception ignored) {
        }
    }

    /** Persistent id for this phone, so the PC keeps ONE session for it. */
    private String deviceId() {
        String id = prefs.getString("device_id", null);
        if (id == null) {
            id = java.util.UUID.randomUUID().toString();
            prefs.edit().putString("device_id", id).apply();
        }
        return id;
    }

    private String deviceLabel() {
        String m = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim())
                + " " + (Build.MODEL == null ? "" : Build.MODEL.trim());
        m = m.trim();
        return m.isEmpty() ? "Android phone" : m;
    }

    private void enqueueDownload(String name, long size, long mtime) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        synchronized (LOCK) {
            Set<String> dl = new HashSet<>(prefs.getStringSet(dlKey(), new HashSet<>()));
            String key = name + "|" + size + "|" + mtime;
            String pairKey = name + "|" + size;
            if (dl.contains(key) || dl.contains(pairKey)) return; // never twice
            dl.add(key);
            dl.add(pairKey); // the WebView bridge checks the pair key
            Set<String> seen = new HashSet<>(prefs.getStringSet(seenKey(), new HashSet<>()));
            seen.add(key);
            prefs.edit().putStringSet(dlKey(), dl).putStringSet(seenKey(), seen).apply();
        }
        // v48 dedupe: never stack a second DownloadManager entry on
        // one that is still alive for this file, and never let a dead
        // attempt's partial file push this download into a
        // "name (1).ext" duplicate of itself.
        try {
            DownloadManager dm0 = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm0 != null) {
                JSONObject map0 = new JSONObject(prefs.getString("rx_map", "{}"));
                java.util.Iterator<String> ks = map0.keys();
                while (ks.hasNext()) {
                    String idStr = ks.next();
                    if (!map0.optString(idStr, "").equals(name + "|" + size)) continue;
                    long oldId = Long.parseLong(idStr);
                    int ost = -1;
                    Cursor oc = dm0.query(new DownloadManager.Query().setFilterById(oldId));
                    if (oc != null) {
                        if (oc.moveToFirst()) ost = oc.getInt(oc.getColumnIndex(DownloadManager.COLUMN_STATUS));
                        oc.close();
                    }
                    if (ost == DownloadManager.STATUS_PENDING
                            || ost == DownloadManager.STATUS_RUNNING
                            || ost == DownloadManager.STATUS_PAUSED) {
                        return; // still alive — it IS this file's download
                    }
                    if (ost == DownloadManager.STATUS_SUCCESSFUL) {
                        map0.remove(idStr);
                        prefs.edit().putString("rx_map", map0.toString()).apply();
                        return; // already fully downloaded
                    }
                    // Failed or vanished: drop the dead entry; the
                    // partial file it leaves is OURS — delete it so
                    // the fresh download takes the real name.
                    try {
                        dm0.remove(oldId);
                    } catch (Exception ignored) {
                    }
                    map0.remove(idStr);
                    prefs.edit().putString("rx_map", map0.toString()).apply();
                    File partial = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name);
                    if (partial.exists() && partial.length() < size) partial.delete();
                }
            }
            // A complete copy is already in Downloads — nothing to do.
            File doneFile = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name);
            if (doneFile.exists() && doneFile.length() == size) return;
        } catch (Exception ignored) {
        }
        try {
            String dl = baseUrl + "/api/download/" + Uri.encode(name);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(dl));
            request.setTitle(name);
            request.setDescription("OurDrop — received from PC");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            long dlId = dm.enqueue(request);
            try {
                JSONObject map = new JSONObject(prefs.getString("rx_map", "{}"));
                map.put(String.valueOf(dlId), name + "|" + size);
                prefs.edit().putString("rx_map", map.toString()).apply();
            } catch (Exception ignored) {
            }
            // tell the open WebView screen (it watches these counters)
            int count = prefs.getInt("recv_count_" + baseUrl, 0) + 1;
            prefs.edit()
                    .putInt("recv_count_" + baseUrl, count)
                    .putString("recv_last_" + baseUrl, name + "|" + size)
                    .apply();
            notifyFileReceived(name, size);
        } catch (Exception ignored) {
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null) return;
            nm.createNotificationChannel(new NotificationChannel(
                    CH_BG, "Background receiving", NotificationManager.IMPORTANCE_LOW));
            nm.createNotificationChannel(new NotificationChannel(
                    CH_FILES, "Received files", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    /** The persistent notification always tells the current truth. */
    private Notification buildNotification() {
        Intent open = new Intent(this, WebViewActivity.class);
        open.putExtra(WebViewActivity.EXTRA_URL, baseUrl);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CH_BG)
                : new Notification.Builder(this);
        String title, text;
        if ("wifi_off".equals(connState)) {
            title = "OurDrop — Wi-Fi is off";
            text = "Turn Wi-Fi on — OurDrop will reconnect by itself";
        } else if ("searching".equals(connState)) {
            title = "OurDrop — looking for your PC";
            text = "Will connect automatically when your PC is reachable";
        } else {
            title = "OurDrop is on";
            text = "Files from your PC arrive automatically";
        }
        return b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_plane_white)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void applyNotification() {
        try {
            // startForeground (not notify) — for a foreground service this
            // is the authoritative update path for its ongoing notification.
            startForeground(FG_ID, buildNotification());
        } catch (Exception ignored) {
        }
    }

    private void notifyFileReceived(String name, long size) {
        try {
            Intent open = new Intent(this, WebViewActivity.class);
            open.putExtra(WebViewActivity.EXTRA_URL, baseUrl);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, name.hashCode(), open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CH_FILES)
                    : new Notification.Builder(this);
            String sizeTxt = size >= 1048576
                    ? String.format("%.1f MB", size / 1048576.0)
                    : size >= 1024 ? (size / 1024) + " KB" : size + " B";
            Notification n = b.setContentTitle("File received")
                    .setContentText(name + " (" + sizeTxt + ") — saved to Downloads")
                    .setSmallIcon(R.drawable.ic_plane_white)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(2000 + (name.hashCode() & 0x3FFF), n);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        if (scheduler != null) scheduler.shutdownNow();
        if (watchdogExec != null) watchdogExec.shutdownNow();
        stopFinder();
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && netCallback != null) cm.unregisterNetworkCallback(netCallback);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
