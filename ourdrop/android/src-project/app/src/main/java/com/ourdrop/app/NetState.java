package com.ourdrop.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;

import java.lang.reflect.Method;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Enumeration;
import java.util.Locale;

/**
 * v54: is this phone itself providing the local network (hotspot)?
 *
 * OurDrop historically treated "Wi-Fi client off" as "no network"
 * everywhere — but when the phone's own hotspot is ON, the PC joins
 * the phone's network as a client and file sharing must work exactly
 * as on a router Wi-Fi (the user's live test 2026-11-16: the PC on
 * his hotspot saw the phone and could Send, yet nothing arrived
 * because the phone side had gone dormant).
 */
final class NetState {

    private NetState() {
    }

    /**
     * v57: THE local-network predicate — the single code path every
     * component must use. The receive service and the dashboard
     * activity used to carry two different detectWifi() copies, and
     * in hotspot mode they disagreed on the same device at the same
     * moment (device report 2026-11-16: files arriving via the
     * service underneath the activity's "Wi-Fi is off" gate). This
     * implementation is the service's original logic, moved here
     * verbatim: ANY associated Wi-Fi/Ethernet network counts (not
     * just the default route — in hotspot mode the phone's own
     * default route is cellular while the PC is served over the AP),
     * the phone's own hotspot counts, and the active network itself
     * counts when it is Wi-Fi/Ethernet/VPN. knownWifiNetwork is the
     * caller's bound Wi-Fi network if it tracks one (the service
     * does), else null; it only matters for the momentary
     * no-active-network case.
     */
    static boolean hasLocalNetwork(Context ctx, Network knownWifiNetwork) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getApplicationContext()
                    .getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            try {
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                    if (caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                            || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) {
                        return true;
                    }
                }
            } catch (Exception ignored) {
            }
            // The phone's own hotspot is a local network too — the PC
            // joins it as a client, so sharing must keep working while
            // the Wi-Fi client side is off.
            if (isHotspotOn(ctx)) return true;
            Network n = cm.getActiveNetwork();
            if (n == null) return knownWifiNetwork != null;
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps == null) return true; // unknown — never block on a guess
            return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        } catch (Exception e) {
            return true;
        }
    }

    static boolean isHotspotOn(Context ctx) {
        // Primary: the platform's own AP state via reflection (the
        // public getter for this is @SystemApi; the method itself has
        // been stable across OEM builds for years).
        try {
            WifiManager wm = (WifiManager) ctx.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                Method m = wm.getClass().getMethod("isWifiApEnabled");
                Object r = m.invoke(wm);
                if (r instanceof Boolean) return (Boolean) r;
            }
        } catch (Exception ignored) {
        }
        // Fallback: an up, non-loopback interface carrying a real
        // IPv4 address under an AP-style name (ap0 / wlan1 / swlan0…)
        // — the shape a live hotspot interface has while the Wi-Fi
        // client side is disconnected. (Link-local addresses do not
        // count: an unassociated client interface can hold one.)
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                String name = ni.getName() == null ? "" : ni.getName().toLowerCase(Locale.ROOT);
                if (!(name.startsWith("ap") || name.startsWith("wlan") || name.startsWith("swlan"))) {
                    continue;
                }
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) {
                        return true;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }
}
