package com.ourdrop.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String PREFS = "ourdrop";
    private static final String KEY_ADDR = "last_address";
    private static final int REQ_SCAN = 42;
    private static final int REQ_CAMERA = 43;

    /**
     * v54: when the dashboard opens this screen via
     * Bridge.openConnectFlow, it runs as a dismissible connect flow:
     * a Cancel button shows, and a successful connect RETURNS the
     * chosen PC to WebViewActivity instead of stacking a second one.
     */
    public static final String EXTRA_CONNECT_FLOW = "connect_flow";

    private EditText etAddress;
    private SharedPreferences prefs;
    private LinearLayout discoveryList;
    private TextView tvDiscovery;
    private boolean connectFlow = false;

    private PcFinder finder;
    private final Map<String, Button> foundButtons = new HashMap<>();
    private boolean autoTried = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        connectFlow = getIntent().getBooleanExtra(EXTRA_CONNECT_FLOW, false);
        if (connectFlow) {
            Button btnCancelFlow = findViewById(R.id.btnCancelFlow);
            if (btnCancelFlow != null) {
                btnCancelFlow.setVisibility(android.view.View.VISIBLE);
                btnCancelFlow.setOnClickListener(v -> {
                    setResult(RESULT_CANCELED);
                    finish();
                });
            }
        }
        etAddress = findViewById(R.id.etAddress);
        discoveryList = findViewById(R.id.discoveryList);
        tvDiscovery = findViewById(R.id.tvDiscovery);
        String last = prefs.getString(KEY_ADDR, "");
        if (last != null && !last.isEmpty()) {
            etAddress.setText(last);
            etAddress.setSelection(last.length());
        }

        Button btnConnect = findViewById(R.id.btnConnect);
        Button btnScan = findViewById(R.id.btnScan);
        TextView txtAbout = findViewById(R.id.txtAbout);
        if (txtAbout != null) {
            txtAbout.setOnClickListener(v ->
                    startActivity(new Intent(this, AboutActivity.class)));
        }

        btnConnect.setOnClickListener(v -> connect(etAddress.getText().toString(), null));
        btnScan.setOnClickListener(v -> {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                startScanner();
            } else {
                requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
            }
        });

        startDiscovery();
        autoConnectIfReachable(last);
    }

    /** If the last PC still answers at its old address, open it straight away. */
    private void autoConnectIfReachable(final String addr) {
        if (autoTried || addr == null || addr.trim().isEmpty()) return;
        autoTried = true;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL("http://" + addr.trim() + "/api/info").openConnection();
                c.setConnectTimeout(1800);
                c.setReadTimeout(1800);
                int code = c.getResponseCode();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
                    while (r.readLine() != null) { /* drain */ }
                }
                if (code == 200) {
                    runOnUiThread(() -> connect(addr, prefs.getString("paired_device_name", null)));
                }
            } catch (Exception ignored) {
                // PC offline or moved — discovery below will find it.
            }
        }).start();
    }

    // ---------------- mDNS discovery (shared PcFinder) ----------------
    private void startDiscovery() {
        finder = new PcFinder(this, new PcFinder.Listener() {
            @Override
            public void onPcFound(String serviceName, String deviceName, String hostPort) {
                runOnUiThread(() -> {
                    addFound(serviceName, deviceName, hostPort);
                    // Our paired PC appeared (possibly at a NEW address) —
                    // reconnect to it automatically, like Phone Link.
                    String paired = prefs.getString("paired_device_name", "");
                    if (!autoTried && paired != null && !paired.isEmpty() && paired.equals(deviceName)) {
                        autoTried = true;
                        connect(hostPort, deviceName);
                    }
                });
            }

            @Override
            public void onPcLost(String serviceName) {
                runOnUiThread(() -> removeFound(serviceName));
            }
        });
        finder.start();
        if (!finder.isRunning() && tvDiscovery != null) {
            tvDiscovery.setText("Auto-discovery is unavailable here — use the QR code or type the address.");
        }
    }

    private void addFound(String serviceName, String displayName, String addr) {
        if (discoveryList == null) return;
        if (tvDiscovery != null) tvDiscovery.setText("Tap your PC to connect — no typing needed:");
        Button existing = foundButtons.get(serviceName);
        if (existing != null) {
            existing.setText(displayName + "  •  " + addr);
            existing.setOnClickListener(v -> connect(addr, displayName));
            return;
        }
        Button b = new Button(this);
        b.setText(displayName + "  •  " + addr);
        b.setTextColor(0xFFFFFFFF);
        b.setTextSize(15);
        b.setBackgroundResource(R.drawable.btn_ghost);
        b.setPadding(14, 12, 14, 12);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 10;
        b.setLayoutParams(lp);
        b.setOnClickListener(v -> connect(addr, displayName));
        discoveryList.addView(b);
        foundButtons.put(serviceName, b);
    }

    private void removeFound(String serviceName) {
        Button b = foundButtons.remove(serviceName);
        if (b != null && discoveryList != null) discoveryList.removeView(b);
        if (foundButtons.isEmpty() && tvDiscovery != null) {
            tvDiscovery.setText("Searching this Wi-Fi for your PC… (the PC app announces itself automatically)");
        }
    }

    @Override
    protected void onDestroy() {
        if (finder != null) finder.stop();
        super.onDestroy();
    }

    private void startScanner() {
        startActivityForResult(new Intent(this, ScannerActivity.class), REQ_SCAN);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startScanner();
            } else {
                Toast.makeText(this, "Camera permission is needed to scan the QR code", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SCAN && resultCode == RESULT_OK && data != null) {
            String text = data.getStringExtra(ScannerActivity.EXTRA_RESULT);
            if (text != null && !text.trim().isEmpty()) {
                String addr = extractAddress(text.trim());
                etAddress.setText(addr);
                etAddress.setSelection(addr.length());
                connect(addr, null);
            }
        }
    }

    /** QR codes shown by the PC contain a full URL like http://192.168.1.5:8765 — reduce to host:port for the field. */
    static String extractAddress(String scanned) {
        String s = scanned.trim();
        if (s.startsWith("http://")) s = s.substring(7);
        else if (s.startsWith("https://")) s = s.substring(8);
        int slash = s.indexOf('/');
        if (slash >= 0) s = s.substring(0, slash);
        return s;
    }

    static String normalizeUrl(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            s = "http://" + s;
        }
        return s;
    }

    private void connect(String raw, String deviceName) {
        String url = normalizeUrl(raw);
        if (url == null) {
            Toast.makeText(this, "Enter the PC address first, e.g. 192.168.1.5:8765", Toast.LENGTH_LONG).show();
            return;
        }
        SharedPreferences.Editor ed = prefs.edit().putString(KEY_ADDR, extractAddress(raw));
        if (deviceName != null && !deviceName.isEmpty()) {
            ed.putString("paired_device_name", deviceName);
        }
        ed.apply();
        if (connectFlow) {
            // v54: hand the chosen PC back to the dashboard that
            // opened this flow — it adopts the address itself.
            Intent result = new Intent();
            result.putExtra(WebViewActivity.EXTRA_URL, url);
            if (deviceName != null) result.putExtra(WebViewActivity.EXTRA_DEVICE, deviceName);
            setResult(RESULT_OK, result);
            finish();
            return;
        }
        Intent i = new Intent(this, WebViewActivity.class);
        i.putExtra(WebViewActivity.EXTRA_URL, url);
        if (deviceName != null) i.putExtra(WebViewActivity.EXTRA_DEVICE, deviceName);
        startActivity(i);
    }
}
