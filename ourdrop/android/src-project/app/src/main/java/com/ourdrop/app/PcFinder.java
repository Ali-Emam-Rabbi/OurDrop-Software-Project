package com.ourdrop.app;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;

import java.util.LinkedList;
import java.util.Map;
import java.util.Queue;

/**
 * Shared mDNS browser for the OurDrop PC service ("_ourdrop._tcp").
 * Used by the connect screen (to list PCs), the WebView screen and the
 * background service (to follow the paired PC when its IP changes).
 * Resolves are serialized — Android's NSD allows only one at a time.
 */
public class PcFinder {

    public static final String SERVICE_TYPE = "_ourdrop._tcp";

    public interface Listener {
        /** A PC was found/resolved. deviceName comes from the TXT record. */
        void onPcFound(String serviceName, String deviceName, String hostPort);

        void onPcLost(String serviceName);
    }

    private final Context ctx;
    private final Listener listener;
    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener discoveryListener;
    private WifiManager.MulticastLock multicastLock;
    private final Queue<NsdServiceInfo> resolveQueue = new LinkedList<>();
    private boolean resolving = false;
    private boolean running = false;

    public PcFinder(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        try {
            WifiManager wifi = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("ourdrop-discovery");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception ignored) {
        }
        try {
            nsdManager = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override
                public void onServiceFound(NsdServiceInfo info) {
                    queueResolve(info);
                }

                @Override
                public void onServiceLost(NsdServiceInfo info) {
                    listener.onPcLost(info.getServiceName());
                }

                @Override public void onDiscoveryStarted(String type) { }
                @Override public void onDiscoveryStopped(String type) { }
                @Override public void onStartDiscoveryFailed(String type, int code) { }
                @Override public void onStopDiscoveryFailed(String type, int code) { }
            };
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception ignored) {
            running = false;
        }
    }

    public synchronized void stop() {
        if (!running) return;
        running = false;
        try {
            if (nsdManager != null && discoveryListener != null) {
                nsdManager.stopServiceDiscovery(discoveryListener);
            }
        } catch (Exception ignored) {
        }
        try {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        } catch (Exception ignored) {
        }
        synchronized (resolveQueue) {
            resolveQueue.clear();
        }
        resolving = false;
    }

    public synchronized boolean isRunning() {
        return running;
    }

    private void queueResolve(NsdServiceInfo info) {
        synchronized (resolveQueue) {
            resolveQueue.add(info);
        }
        resolveNext();
    }

    private void resolveNext() {
        final NsdServiceInfo next;
        synchronized (resolveQueue) {
            if (resolving) return;
            next = resolveQueue.poll();
            resolving = next != null;
        }
        if (next == null || nsdManager == null) return;
        try {
            nsdManager.resolveService(next, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo info, int code) {
                    synchronized (resolveQueue) {
                        resolving = false;
                    }
                    resolveNext();
                }

                @Override
                public void onServiceResolved(NsdServiceInfo info) {
                    synchronized (resolveQueue) {
                        resolving = false;
                    }
                    try {
                        if (info.getHost() != null) {
                            String host = info.getHost().getHostAddress();
                            String device = deviceName(info.getServiceName(), info.getAttributes());
                            listener.onPcFound(info.getServiceName(), device, host + ":" + info.getPort());
                        }
                    } catch (Exception ignored) {
                    }
                    resolveNext();
                }
            });
        } catch (Exception e) {
            synchronized (resolveQueue) {
                resolving = false;
            }
        }
    }

    static String deviceName(String serviceName, Map<String, byte[]> attrs) {
        if (attrs != null && attrs.get("device") != null) {
            try {
                String d = new String(attrs.get("device"), "UTF-8").trim();
                if (!d.isEmpty()) return d;
            } catch (Exception ignored) {
            }
        }
        String n = serviceName == null ? "" : serviceName;
        if (n.startsWith("OurDrop-")) n = n.substring("OurDrop-".length());
        return n.isEmpty() ? "OurDrop PC" : n;
    }
}
