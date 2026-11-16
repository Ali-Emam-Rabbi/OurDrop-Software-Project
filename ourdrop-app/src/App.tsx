import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import QRCode from "qrcode";
import { motion, AnimatePresence } from "framer-motion";
import { Icon, Logo, HeroScene, FileTypeIcon, BrandIcon } from "./icons";
import {
  FileItem, Info, Peer, HistItem, Approvals, fmtSize, fetchInfo, fetchFiles, fetchPeers,
  deleteFile, deleteAllFiles, loadHistory, addHistory, clearHistory, loadDisplayName, saveDisplayName, ChunkedUpload,
  OutboxUpload, connectWs, fetchApprovals, postSharedName,
  approveIp, setRequireApproval, cancelRxDownload,
} from "./api";

type View = "home" | "files" | "receive" | "history" | "devices" | "settings" | "about";

/** Live snapshot of a phone -> PC receive batch (server WS "incoming"). */
interface IncomingBatch {
  total: number;
  completed: number;
  active: number;
  currentName: string;
  bytesTotal: number;
  bytesReceived: number;
}
/** One phone-download row (v48): the PC mirror (WS rx-progress) or the
 *  phone's own list. status: downloading | paused | interrupted |
 *  failed | cancelled — interrupted means the reports stopped, NOT
 *  that bytes are still moving. */
interface RxItem {
  name: string;
  received: number;
  total: number;
  status?: string;
}
const isDesktopApp = () => !!window.odDesktop;
const bridge = () => window.OurDropAndroid;
// Open an external link in the device's default browser — the
// Android bridge on the phone, the Electron main on PC (both
// validate/open natively); a plain new tab as a last resort.
const openLink = (url: string) => {
  const b = bridge();
  if (b?.openExternal) {
    b.openExternal(url);
    return;
  }
  if (window.odDesktop?.openExternal) {
    window.odDesktop.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
};

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 960px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 960px)");
    const fn = () => setWide(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return wide;
}

interface StageItem {
  key: number;
  name: string;
  size: number;
  file?: File;
  path?: string;
  thumb?: string;
}
interface QItem {
  up: ChunkedUpload | OutboxUpload;
  name: string;
  size: number;
  state: "wait" | "active" | "paused" | "done" | "error" | "waiting";
  sent: number;
  verified?: boolean;
  error?: string;
  /** Desktop path sends: the file is OFFERED from its original
   *  location (no copy); delivered flips when the phone has it. */
  offered?: boolean;
  delivered?: boolean;
}

let stageKey = 0;

export default function App() {
  const wide = useWide();
  const [view, setView] = useState<View>("home");
  // Desktop startup intro: the splash identity plays as an overlay
  // over the already-mounted dashboard and leaves with a soft fade +
  // scale — never a separate window or screen swap. The phone keeps
  // its own native splash, so this is desktop-only.
  const [intro, setIntro] = useState<"show" | "leaving" | "done">(() => (isDesktopApp() ? "show" : "done"));
  useEffect(() => {
    if (!isDesktopApp()) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t1 = window.setTimeout(() => setIntro("leaving"), reduce ? 200 : 1500);
    const t2 = window.setTimeout(() => setIntro("done"), reduce ? 450 : 2050);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);
  // Collapsible PC sidebar; the choice persists per device.
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem("od_sidebar") !== "0";
    } catch {
      return true;
    }
  });
  const toggleSide = useCallback(() => {
    setSideOpen((v) => {
      try {
        localStorage.setItem("od_sidebar", v ? "0" : "1");
      } catch {}
      return !v;
    });
  }, []);
  // In-app update popup (v42): the update CHECK still lives in the
  // Electron main (PC) / Android shell (phone) exactly as before —
  // only the presentation moved into the app so both platforms show
  // the same designed popup instead of native dialogs.
  const [upd, setUpd] = useState<{ name: string; notes: string; current: string; apk?: string } | null>(null);
  // v56 (PC only): the update download itself now runs inside the
  // app — Electron main downloads the Setup and reports progress
  // here; the popup stays open showing it instead of closing into a
  // browser trip. Phone downloads stay native (DownloadManager), so
  // this state is only ever driven on desktop.
  const [updDl, setUpdDl] = useState<{ phase: "idle" | "downloading" | "error"; percent: number }>({ phase: "idle", percent: 0 });
  // Manual "Check for Updates" (Settings) state machine.
  const [updCheck, setUpdCheck] = useState<"idle" | "checking" | "uptodate" | "available" | "error">("idle");
  const startCheckUpdates = () => {
    if (updCheck === "checking") return;
    setUpdCheck("checking");
    // Safety net: no result within 12s reads as a failed check.
    setTimeout(() => setUpdCheck((c) => (c === "checking" ? "error" : c)), 12000);
    const b = bridge();
    if (b?.checkForUpdate) {
      b.checkForUpdate();
      return;
    }
    if (window.odDesktop?.checkUpdate) {
      window.odDesktop.checkUpdate();
      return;
    }
    setUpdCheck("error");
  };
  // Mobile slide-out drawer (phone only; the bottom tab bar stays).
  // Render + open are separate states so the close transition can play.
  const [drawerRender, setDrawerRender] = useState(false);
  const [drawerOn, setDrawerOn] = useState(false);
  const drawerTimer = useRef<number | undefined>(undefined);
  const openDrawer = useCallback(() => {
    window.clearTimeout(drawerTimer.current);
    setDrawerRender(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setDrawerOn(true)));
    try {
      window.history.pushState({ odDrawer: 1 }, "");
    } catch {}
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerOn(false);
    window.clearTimeout(drawerTimer.current);
    drawerTimer.current = window.setTimeout(() => setDrawerRender(false), 300);
  }, []);
  useEffect(() => {
    if (!drawerOn) return;
    const onPop = () => closeDrawer();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOn, closeDrawer]);
  // Theme preference: "system" | "light" | "dark" (stored per device).
  // The resolved theme follows the OS live while "system" is selected.
  const [themePref, setThemePref] = useState(() => localStorage.getItem("od_theme") || "dark");
  const [systemLight, setSystemLight] = useState(() => window.matchMedia("(prefers-color-scheme: light)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const fn = () => setSystemLight(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  const theme = themePref === "system" ? (systemLight ? "light" : "dark") : themePref;
  const [displayName, setDisplayName] = useState(() => loadDisplayName());
  useEffect(() => {
    const onName = () => setDisplayName(loadDisplayName());
    window.addEventListener("od-name", onName);
    return () => window.removeEventListener("od-name", onName);
  }, []);
  // ---- Shared display name (PC ⇄ phone) ----
  // ONE name for the pair, held by the PC server; localStorage is only
  // a launch-time cache. Latest timestamp wins — the server arbitrates
  // simultaneous edits and broadcasts the winner over the socket, so
  // both UIs converge on the same name in real time.
  const nameTsRef = useRef<number>(Number(localStorage.getItem("od_display_name_ts") || 0));
  const nameSeededRef = useRef(false);
  const applySharedName = useCallback((n: string, ts: number) => {
    if (!n || ts < nameTsRef.current) return; // an older value never wins
    nameTsRef.current = ts;
    localStorage.setItem("od_display_name_ts", String(ts));
    saveDisplayName(n);
  }, []);
  const changeDisplayName = useCallback(
    (n: string) => {
      const ts = Date.now();
      applySharedName(n, ts); // this UI updates instantly
      postSharedName(n, ts)
        .then((r) => {
          if (!r.ok) applySharedName(r.name, r.ts); // lost a race — converge
        })
        .catch(() => {});
    },
    [applySharedName],
  );
  const [info, setInfo] = useState<Info | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [rxItems, setRxItems] = useState<RxItem[]>([]);
  const [incoming, setIncoming] = useState<IncomingBatch | null>(null);
  /** Phone-only: a burst of auto-received files, grouped into ONE
     in-app indicator (never a system toast). */
  const [rxBurst, setRxBurst] = useState<{ count: number; name: string; at: number }>({ count: 0, name: "", at: 0 });
  const [confirmFilesDeleteAll, setConfirmFilesDeleteAll] = useState(false);
  const localRx = useLocalRx();
  // Sending is only possible while a receiver session is verified
  // active. On the PC that means a connected phone; on the phone this
  // page's own session counts (the PC is the server it is talking to).
  const hasReceiver = peers.some((p) => p.state === "active" || (p.state == null && p.ago <= 45));
  const hasReceiverRef = useRef(false);
  useEffect(() => {
    hasReceiverRef.current = hasReceiver;
  }, [hasReceiver]);
  const NO_RECEIVER_MSG = "Connect your mobile device first.";
  // v54 (phone only): the dashboard opens without a PC session.
  // "Offline" = the Android shell is present, at least one refresh
  // has settled, and there is no live PC session (no info yet, or
  // the connection is down) and no active receiver peer. (The state
  // itself is computed after refresh below, where its inputs live.)
  const [bootTried, setBootTried] = useState(false);
  const [history, setHistory] = useState<HistItem[]>(() => loadHistory());
  const [toast, setToast] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [qr, setQr] = useState("");
  const [staged, setStaged] = useState<StageItem[]>([]);
  const [connUp, setConnUp] = useState(true);
  const [approvals, setApprovals] = useState<Approvals | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toastT = useRef<number>(0);
  const lastOk = useRef<number>(Date.now());

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [i, f, p] = await Promise.all([fetchInfo(), fetchFiles(), fetchPeers()]);
      setInfo(i);
      setFiles(f);
      setPeers(p);
      // Adopt the shared name the server holds (it is the authority);
      // if it holds none yet, seed it once from this device's
      // existing local name so pre-sync names become the shared one.
      if (i.displayName) {
        applySharedName(i.displayName, i.nameTs || 0);
      } else if (!nameSeededRef.current) {
        nameSeededRef.current = true;
        const local = loadDisplayName();
        if (local) changeDisplayName(local);
      }
      lastOk.current = Date.now();
      setConnUp(true);
      if (isDesktopApp()) setApprovals(await fetchApprovals());
    } catch {
      if (Date.now() - lastOk.current > 5000) setConnUp(false);
    }
    setBootTried(true);
  }, [applySharedName, changeDisplayName]);

  const phoneOffline = !!bridge() && bootTried && !hasReceiver && (!info || !connUp);
  const phoneOfflineRef = useRef(false);
  useEffect(() => {
    phoneOfflineRef.current = phoneOffline;
  }, [phoneOffline]);
  const openConnectFlow = useCallback(() => {
    const b = bridge();
    if (b && typeof b.openConnectFlow === "function") b.openConnectFlow();
  }, []);
  // Send-gate feedback: on the phone, when there is no PC session at
  // all, a Send/Receive-type tap opens the native connect flow
  // instead of the dead-end toast. Every other case (PC, or a live
  // session that merely lacks a receiver) keeps the existing toast.
  const gateNotify = useCallback(() => {
    const b = bridge();
    if (phoneOfflineRef.current && b && typeof b.openConnectFlow === "function") {
      b.openConnectFlow();
      return;
    }
    showToast(NO_RECEIVER_MSG);
  }, [showToast]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("od_theme", themePref);
  }, [theme, themePref]);

  // v47: publish the window's focus state for the decorative-motion
  // freeze — styles.css pauses every CSS animation while
  // html[data-focused="false"], and the typewriters below check
  // document.hasFocus() before advancing. (The plasma canvas has its
  // own gate since v46.) Functional timers are never gated.
  useEffect(() => {
    const el = document.documentElement;
    const apply = () => {
      el.dataset.focused = document.hasFocus() ? "true" : "false";
    };
    apply();
    window.addEventListener("focus", apply);
    window.addEventListener("blur", apply);
    return () => {
      window.removeEventListener("focus", apply);
      window.removeEventListener("blur", apply);
    };
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(() => {
      // v43: no UI polling while the window is hidden (e.g. in the
      // tray) — WebSocket events keep arriving regardless, and the
      // visibility listener below refreshes the moment it returns.
      if (!document.hidden) refresh();
    }, 4000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    const onHist = () => setHistory(loadHistory());
    window.addEventListener("od-history", onHist);
    window.__odDlEvent = (name: string, ok: boolean, err?: string) => {
      // Manual-download lifecycle from the Android shell: exactly one
      // completion announcement per download, replacing the earlier
      // "Downloading …" toast on the same single toast surface.
      if (ok) {
        showToast("Downloaded " + name + " → Downloads folder");
        refresh();
      } else {
        showToast(err ? err : "Download failed: " + name);
      }
    };
    window.__odUpdate = (info) => {
      // v52: tolerate the pre-v52 Android shell, which dispatched the
      // payload as a JSON string instead of an object — parse it here
      // so a new PC build also heals phones still running the old APK
      // (their popup showed blank versions and a dead Download button).
      let updInfo: any = info;
      if (typeof updInfo === "string") {
        try {
          updInfo = JSON.parse(updInfo);
        } catch {
          updInfo = null;
        }
      }
      setUpd(updInfo);
      // The Android shell records its once-per-day "shown" mark only
      // on this confirmation that the popup is really on screen.
      bridge()?.updateDisplayed?.();
    };
    window.odDesktop?.onUpdateAvailable?.((info) => {
      setUpd(info);
      setUpdDl({ phase: "idle", percent: 0 });
    });
    // v56: PC in-app update download progress / failure, from main.
    window.odDesktop?.onUpdateProgress?.((s) => {
      if (s.error) setUpdDl((d) => ({ phase: "error", percent: d.percent }));
      else if (typeof s.percent === "number")
        setUpdDl({ phase: "downloading", percent: s.percent });
    });
    // Manual update-check results (Settings button): the phone shell
    // calls __odUpdateResult, the PC main sends od:updateResult.
    const applyUpdResult = (status: string) =>
      setUpdCheck(status === "available" ? "available" : status === "uptodate" ? "uptodate" : "error");
    window.__odUpdateResult = applyUpdResult;
    window.odDesktop?.onUpdateResult?.((r) => applyUpdResult(r.status));
    window.__odReceived = (name: string) => {
      addHistory({ name, size: 0, dir: "received", time: Date.now(), loc: "Downloads (phone)" });
      // Group a burst of arrivals into a single in-app indicator —
      // no per-file toast, and nothing is shown outside the app.
      setRxBurst((b) => ({ count: (Date.now() - b.at < 8000 ? b.count : 0) + 1, name, at: Date.now() }));
      refresh();
    };
    const closeWs = connectWs(
      (e) => {
        if (e.type === "name-changed") applySharedName(e.name, e.ts);
        if (e.type === "files-changed") refresh();
        if (e.type === "outbox-delivered") {
          // The phone finished downloading an offered file — flip its
          // send-panel row to "Received by phone".
          let hit = false;
          for (const i of qRef.current.items) {
            if (i.offered && !i.delivered && i.name === e.name) {
              i.delivered = true;
              hit = true;
            }
          }
          if (hit) force();
          refresh();
        }
        if (e.type === "peer-joined") {
          showToast(`${e.name || "Device"} connected`);
          refresh();
        }
        if (e.type === "peer-left") {
          showToast(`${e.name || "Device"} disconnected`);
          refresh();
        }
        if (e.type === "peer-unresponsive") {
          // The server suspects this device is gone — flip the UI to
          // disconnected immediately instead of waiting for a poll.
          setPeers((prev) => prev.map((p) => (p.ip === e.ip || (p.id && p.id === e.key) ? { ...p, state: "unresponsive" } : p)));
        }
        if (e.type === "peer-active") {
          setPeers((prev) => prev.map((p) => (p.ip === e.ip || (p.id && p.id === e.key) ? { ...p, state: "active" } : p)));
          refresh();
        }
        if (e.type === "approval-needed") {
          if (isDesktopApp()) refresh();
          else showToast("Waiting for approval on the PC…");
        }
        if (e.type === "peer-approved") {
          showToast("This device was approved on the PC");
          refresh();
        }
        if (e.type === "received" && isDesktopApp()) refresh();
        if (e.type === "rx-progress") setRxItems(e.items || []);
        if (e.type === "incoming" && isDesktopApp())
          setIncoming({
            total: e.total || 0,
            completed: e.completed || 0,
            active: e.active || 0,
            currentName: e.currentName || "",
            bytesTotal: e.bytesTotal || 0,
            bytesReceived: e.bytesReceived || 0,
          });
        if (e.type === "incoming-done" && isDesktopApp()) {
          setIncoming(null);
          showToast(`Received ${e.count} file${e.count === 1 ? "" : "s"}`);
        }
      },
      (up) => {
        if (up) {
          lastOk.current = Date.now();
          setConnUp(true);
          refresh();
        }
      }
    );
    return () => {
      window.clearInterval(t);
      window.removeEventListener("od-history", onHist);
      closeWs();
    };
  }, [refresh, showToast]);

  // The receive indicator dismisses itself a few seconds after the
  // last file of a burst arrives.
  useEffect(() => {
    if (!rxBurst.count) return;
    const t = window.setTimeout(() => setRxBurst((b) => ({ ...b, count: 0 })), 4600);
    return () => window.clearTimeout(t);
  }, [rxBurst]);

  useEffect(() => {
    if (info) {
      QRCode.toDataURL(`http://${info.ip}:${info.port}/`, {
        width: 416,
        margin: 1,
        color: { dark: "#10233f", light: "#ffffff" },
      })
        .then(setQr)
        .catch(() => {});
    }
  }, [info]);

  // ---------------- staging (drag & drop / picker → review → send) ----
  const stageFiles = useCallback((list: FileList | File[]) => {
    if (!hasReceiverRef.current) {
      gateNotify();
      return;
    }
    const arr = Array.from(list);
    if (!arr.length) return;
    setStaged((prev) => [
      ...prev,
      ...arr.map((f) => ({
        key: ++stageKey,
        name: f.name,
        size: f.size,
        file: f,
        // In the desktop app a dropped/picked File is disk-backed:
        // capture its real path NOW so the send can offer the file
        // from its original location instead of copying it anywhere.
        path: isDesktopApp() ? window.odDesktop!.getPathForFile(f) || undefined : undefined,
        thumb: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      })),
    ]);
  }, []);
  const stagePaths = useCallback((items: { path: string; name: string; size: number }[]) => {
    if (!hasReceiverRef.current) {
      showToast(NO_RECEIVER_MSG);
      return;
    }
    setStaged((prev) => [
      ...prev,
      ...items.map((i) => ({ key: ++stageKey, name: i.name, size: i.size, path: i.path })),
    ]);
  }, []);
  const unstage = (key: number) =>
    setStaged((prev) => {
      const it = prev.find((s) => s.key === key);
      if (it?.thumb) URL.revokeObjectURL(it.thumb);
      return prev.filter((s) => s.key !== key);
    });

  // ---------------- upload queue (chunked, resumable) ----------------
  const qRef = useRef<{ items: QItem[]; running: boolean }>({ items: [], running: false });
  const [, force] = useReducer((x: number) => x + 1, 0);

  const processNext = useCallback(async () => {
    const q = qRef.current;
    if (q.running) return;
    // Only "wait" items start. A paused item must STAY paused until the
    // user resumes it (resumeItem flips it back to "wait") — picking
    // "paused" here made Pause restart itself instantly.
    const item = q.items.find((i) => i.state === "wait");
    if (!item) {
      force();
      return;
    }
    if (!hasReceiverRef.current) {
      showToast(NO_RECEIVER_MSG);
      force();
      return;
    }
    q.running = true;
    item.state = "active";
    force();
    try {
      const done = await item.up.start((sent) => {
        item.sent = sent;
        force();
      });
      item.state = "done";
      item.sent = item.size;
      item.verified = done.verified;
      addHistory({ name: done.name, size: item.size, dir: "sent", time: Date.now(), verified: done.verified });
      refresh();
    } catch (err: any) {
      if (item.up.state === "paused") {
        item.state = "paused";
      } else if (item.up.state === "cancelled") {
        item.state = "error";
        item.error = "Cancelled";
      } else if (String(err?.message) === "approval_required") {
        item.state = "waiting";
        item.error = "Waiting for approval on the PC";
        showToast("The PC must approve this device first");
      } else if (String(err?.message) === "interrupted") {
        item.state = "error";
        item.error = "Interrupted — connection lost. Retry resumes from where it stopped.";
      } else {
        item.state = "error";
        item.error = "Upload failed — check the connection";
      }
    }
    q.running = false;
    force();
    processNext();
  }, [refresh, showToast]);

  const sendStaged = useCallback(async () => {
    if (!staged.length) return;
    if (!hasReceiverRef.current) {
      gateNotify();
      return;
    }
    const items = staged;
    setStaged([]);
    // Desktop sends NEVER copy the file: anything with a real path
    // (native dialog picks, drag & drop — Electron exposes File.path)
    // is OFFERED from its original location via the server outbox and
    // the phone downloads it from there. Only pathless blobs (the
    // phone's own picker, a plain web browser) use the chunked upload
    // — for the phone that IS the incoming direction to the PC.
    items.forEach((s) => {
      const filePath = s.path || (isDesktopApp() && s.file ? (s.file as any).path || "" : "");
      if (filePath)
        qRef.current.items.push({
          up: new OutboxUpload(filePath, s.name, s.size),
          name: s.name,
          size: s.size,
          state: "wait",
          sent: 0,
          offered: true,
        });
      else if (s.file)
        qRef.current.items.push({
          up: new ChunkedUpload(s.file),
          name: s.name,
          size: s.size,
          state: "wait",
          sent: 0,
        });
    });
    force();
    processNext();
  }, [staged, processNext, showToast]);

  const pickAction = useCallback(async () => {
    if (!hasReceiverRef.current) {
      gateNotify();
      return;
    }
    if (isDesktopApp()) {
      const picked = await window.odDesktop!.pickPaths();
      if (picked.length) stagePaths(picked);
    } else {
      fileInput.current?.click();
    }
  }, [stagePaths]);

  const pauseItem = (item: QItem) => item.up.pause();
  const resumeItem = (item: QItem) => {
    item.state = "wait";
    force();
    processNext();
  };
  const cancelAll = async () => {
    const q = qRef.current;
    for (const i of q.items) {
      if (i.state === "active" || i.state === "paused" || i.state === "wait") await i.up.cancel();
      // An offered file is still "being sent" until the phone takes
      // it — Cancel all withdraws those offers too.
      else if (i.state === "done" && i.offered && !i.delivered) await i.up.cancel();
    }
    q.items = q.items.filter((i) => i.state === "done" && !(i.offered && !i.delivered));
    force();
  };

  // ---------------- drag & drop ----------------
  const onDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return; // text/image drags are not file drops
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files || []);
    if (!dropped.length) return;
    // Dropped files upload through the chunked queue (progress panel,
    // pause/resume, SHA-256 verify) — on desktop too, where a dropped
    // File is disk-backed. Only native-dialog picks arrive as paths.
    stageFiles(dropped);
  };

  const sending = qRef.current.items.some((i) => ["active", "wait", "paused", "waiting"].includes(i.state));
  // On the PC, outgoing offers are managed in the Send panel — the
  // shared-folder lists show only files this PC actually holds. On the
  // phone the same lists ARE the incoming view, offers included.
  const sharedOnly = isDesktopApp() ? files.filter((f) => !f.outbox) : files;
  const nav = (v: View) => setView(v);
  const sendDisabled = !connUp && !isDesktopApp();
  const waitingApproval = !!(info?.approvalRequired && info?.youApproved === false);
  const goView = (v: View) => {
    closeDrawer();
    nav(v);
  };
  const drawerSend = () => {
    closeDrawer();
    if (view !== "home") nav("home");
    window.setTimeout(() => {
      void pickAction();
    }, 90);
  };

  return (
    <>
    <PlasmaBg />
    <div
      className={"shell" + (sideOpen ? "" : " sideClosed")}
      onDragOver={(e) => {
        // Only a REAL file drag (from Explorer/Finder) arms the drop
        // overlay — dragged UI text or images must never trigger it.
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) stageFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <aside className="sidebar">
       <div className="sideInner">
        <div className="brand">
          <img className="brandLogo" src="/logo.png" alt="OurDrop" />
          <div>
            <div className="bname">OurDrop</div>
            <div className="bsub">PC ⇄ Mobile File Sharing</div>
          </div>
          <button className="sideToggle" onClick={toggleSide} aria-label="Collapse sidebar">
            <Icon name="chevL" size={16} />
          </button>
        </div>
        <nav className="snav">
          <SideBtn icon="home" label="Home" on={view === "home"} fn={() => nav("home")} />
          <SideBtn icon="send" label="Send Files" on={false} fn={pickAction} />
          <SideBtn icon="download" label="Receive Files" on={view === "receive"} fn={() => nav("receive")} />
          <SideBtn icon="monitor" label="Devices" on={view === "devices"} fn={() => nav("devices")} />
          <SideBtn icon="clock" label="Transfer History" on={view === "history"} fn={() => nav("history")} />
          <SideBtn icon="sliders" label="Settings" on={view === "settings"} fn={() => nav("settings")} />
          <SideBtn icon="user" label="About Us" on={view === "about"} fn={() => nav("about")} />
        </nav>
        <div className="sideConn">
          <div className="r1" style={{ color: connUp ? "var(--ok)" : "var(--danger)" }}>
            <Icon name="wifi" size={17} /> {connUp ? "Connected" : "Connection lost"}
          </div>
          <div className="r2">Wi-Fi (local network)</div>
        </div>
       </div>
      </aside>

      <main className="main">
        {!wide && (
          <div className="topbar">
            <button className="iconbtn" onClick={openDrawer} aria-label="Open menu">
              <Icon name="menu" size={21} />
            </button>
            <img className="brandLogo" src="/logo.png" alt="OurDrop" />
            <div>
              <div className="tname">OurDrop</div>
              <div className="tsub">PC ⇄ Mobile File Sharing</div>
            </div>
            <div className="sp" />
            <button className="chip" onClick={() => nav("files")} aria-label="Open shared files">
              {files.length} files
            </button>
            <button className="iconbtn" onClick={() => nav("settings")} aria-label="Settings">
              <Icon name="sliders" size={20} />
            </button>
          </div>
        )}

        {!connUp && (
          <div className="connBanner off">
            <Icon name="wifi" size={18} />
            <span className="grow">Connection lost — check that both devices are on the same Wi-Fi. Your transfers are saved and can resume.</span>
            <button className="pill" onClick={() => { lastOk.current = Date.now(); refresh(); }}>
              <Icon name="refresh" size={14} /> Reconnect
            </button>
          </div>
        )}
        {connUp && waitingApproval && (
          <div className="connBanner wait">
            <Icon name="shield" size={18} />
            <span className="grow">This device is not approved yet. Ask the PC owner to approve it in OurDrop — transfers unlock right away.</span>
          </div>
        )}
        {isDesktopApp() && approvals && approvals.required && approvals.pending.length > 0 && (
          <div className="connBanner wait">
            <Icon name="shield" size={18} />
            <span className="grow">
              {approvals.pending[0].name} ({approvals.pending[0].ip}) wants to transfer files.
            </span>
            <button
              className="pill accent"
              onClick={async () => {
                await approveIp(approvals.pending[0].ip);
                showToast("Device approved");
                refresh();
              }}
            >
              Approve
            </button>
          </div>
        )}

        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.24, ease: [0.22, 0.61, 0.36, 1] }}
          >
            {view === "home" && (
              <HomeView
                wide={wide}
                displayName={displayName}
                onNameSave={changeDisplayName}
                info={info}
                files={files}
                peers={peers}
                sending={sending}
                sendDisabled={sendDisabled}
                staged={staged}
                queueItems={qRef.current.items}
                sendPanel={
                  <SendPanel
                    items={qRef.current.items}
                    onPause={pauseItem}
                    onResume={resumeItem}
                    onCancelAll={cancelAll}
                    stalledNames={new Set(rxItems.filter((x) => x.status === "failed" || x.status === "interrupted").map((x) => x.name))}
                  />
                }
                noReceiver={!hasReceiver}
                localRx={localRx}
                rxItems={rxItems}
                onSend={pickAction}
                onReceive={() => nav("receive")}
                onDevices={() => nav("devices")}
                onHistory={() => nav("history")}
                onPick={pickAction}
                onUnstage={unstage}
                onSendStaged={sendStaged}
                onClearStaged={() => setStaged([])}
                offline={phoneOffline}
                onConnect={openConnectFlow}
              />
            )}
            {view === "files" && (
              <>
                <div className="sectionHead" style={{ margin: "4px 2px 12px" }}>
                  <h2 className="viewTitle" style={{ margin: 0, flex: 1 }}>Shared Files</h2>
                  <span style={{ display: "flex", gap: 8 }}>
                    <button className="pill" onClick={refresh}>
                      <Icon name="refresh" size={14} /> Refresh
                    </button>
                    {sharedOnly.length > 0 && (
                      <button className="pill dangerPill" onClick={() => setConfirmFilesDeleteAll(true)}>
                        <Icon name="trash" size={14} /> Delete All
                      </button>
                    )}
                  </span>
                </div>
                {confirmFilesDeleteAll && (
                  <ConfirmModal
                    message={`Are you sure you want to delete all ${sharedOnly.length} file${sharedOnly.length === 1 ? "" : "s"} from the shared folder?`}
                    confirmLabel="Delete All"
                    onCancel={() => setConfirmFilesDeleteAll(false)}
                    onConfirm={async () => {
                      setConfirmFilesDeleteAll(false);
                      try {
                        const r = await deleteAllFiles();
                        showToast(
                          r.failed
                            ? `Deleted ${r.deleted} file(s); ${r.failed} could not be deleted (in use)`
                            : `Deleted ${r.deleted} file(s) from the shared folder`
                        );
                      } catch {
                        showToast("Delete All failed — please try again");
                      }
                      refresh();
                    }}
                  />
                )}
                <FileList files={sharedOnly} onChanged={refresh} showToast={showToast} />
              </>
            )}
            {view === "receive" && (
              <ReceiveView info={info} files={sharedOnly} onChanged={refresh} showToast={showToast} rxItems={rxItems} localRx={localRx} incoming={incoming} />
            )}
            {view === "history" && <HistoryView history={history} info={info} showToast={showToast} />}
            {view === "devices" && (
              <DevicesView info={info} peers={peers} files={files} qr={qr} approvals={approvals} refresh={refresh} showToast={showToast} />
            )}
            {view === "settings" && (
              <SettingsView theme={themePref} setTheme={setThemePref} info={info} refresh={refresh} showToast={showToast} displayName={displayName} onNameSave={changeDisplayName} updCheck={updCheck} onCheckUpdates={startCheckUpdates} />
            )}
            {view === "about" && <AboutView />}
          </motion.div>
        </AnimatePresence>
      </main>

      {!wide && (
        <nav className="bottomnav">
          <TabBtn icon="home" label="Home" on={view === "home"} fn={() => nav("home")} />
          <TabBtn icon="files" label="Files" on={view === "files"} fn={() => nav("files")} />
          <TabBtn icon="clock" label="History" on={view === "history"} fn={() => nav("history")} />
          <TabBtn icon="monitor" label="Devices" on={view === "devices"} fn={() => nav("devices")} />
        </nav>
      )}

      {!wide && drawerRender && (
        <div className={"drawerRoot" + (drawerOn ? " open" : "")}>
          <div className="drawerShade" onClick={closeDrawer} />
          <aside className="drawer" aria-label="Menu">
            <div className="drawerHead">
              <img className="brandLogo" src="/logo.png" alt="OurDrop" />
              <div>
                <div className="tname">OurDrop</div>
                <div className="tsub">PC ⇄ Mobile File Sharing</div>
              </div>
              <div className="sp" />
              <button className="iconbtn" onClick={closeDrawer} aria-label="Close menu">
                <Icon name="x" size={19} />
              </button>
            </div>
            <nav className="drawerNav">
              <button className={view === "home" ? "on" : ""} onClick={() => goView("home")}>
                <Icon name="home" size={19} /> Home
              </button>
              <button onClick={drawerSend}>
                <Icon name="send" size={19} fill /> Send Files
              </button>
              <button className={view === "receive" ? "on" : ""} onClick={() => goView("receive")}>
                <Icon name="download" size={19} /> Receive Files
              </button>
              <button className={view === "files" ? "on" : ""} onClick={() => goView("files")}>
                <Icon name="files" size={19} /> Shared Files
              </button>
              <button className={view === "devices" ? "on" : ""} onClick={() => goView("devices")}>
                <Icon name="monitor" size={19} /> Devices
              </button>
              <button className={view === "history" ? "on" : ""} onClick={() => goView("history")}>
                <Icon name="clock" size={19} /> Transfer History
              </button>
              <button className={view === "settings" ? "on" : ""} onClick={() => goView("settings")}>
                <Icon name="sliders" size={19} /> Settings
              </button>
              <button className={view === "about" ? "on" : ""} onClick={() => goView("about")}>
                <Icon name="user" size={19} /> About Us
              </button>
            </nav>
            <div className="sideConn drawerConn">
              <div className="r1" style={{ color: connUp ? "var(--ok)" : "var(--danger)" }}>
                <Icon name="wifi" size={17} /> {connUp ? "Connected" : "Connection lost"}
              </div>
              <div className="r2">Wi-Fi (local network)</div>
            </div>
          </aside>
        </div>
      )}

      {dragOver && (
        <div className="dropOverlay">
          <div className="box">
            <Icon name="upload" size={34} />
            <div style={{ marginTop: 10 }}>Drop files to add them</div>
          </div>
        </div>
      )}
      {bridge() && (localRx.length > 0 || rxBurst.count > 0) && (
        <button
          className="rxPill"
          onClick={() => {
            setRxBurst((b) => ({ ...b, count: 0 }));
            nav("receive");
          }}
        >
          <span className="rxDot">
            <Icon name={localRx.length > 0 ? "download" : "check"} size={16} />
          </span>
          <span className="rxTxt">
            {localRx.length > 0 ? (
              <>
                <div className="fn">Receiving {localRx[0].name}</div>
                <div className="rxBar">
                  <span style={{ width: (localRx[0].total > 0 ? Math.min(100, Math.round((localRx[0].received / localRx[0].total) * 100)) : 0) + "%" }} />
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{rxBurst.count === 1 ? "File received" : `${rxBurst.count} files received`}</div>
                <div className="fn" style={{ fontSize: 12.5, color: "var(--muted)", display: "block" }}>
                  {rxBurst.name}
                </div>
              </>
            )}
          </span>
        </button>
      )}
      {toast && <div className="toast">{toast}</div>}
      {upd && (
        <UpdatePopup
          info={upd}
          dl={isDesktopApp() ? updDl : undefined}
          onLater={() => setUpd(null)}
          onDownload={() => {
            if (isDesktopApp()) {
              // v56: main downloads the Setup inside the app and
              // launches it — no browser, no Drive page. The popup
              // stays open and shows the progress (updDl).
              setUpdDl({ phase: "downloading", percent: 0 });
              window.odDesktop?.updateAction?.("download");
            } else if (upd.apk) {
              // v56: the phone downloads the APK natively
              // (DownloadManager) and opens the install prompt when
              // it lands — the user never leaves the app. Shells
              // older than v56 have no downloadUpdate bridge method;
              // they keep the old openExternal behaviour, never crash.
              const b = bridge();
              if (b && typeof b.downloadUpdate === "function") b.downloadUpdate(upd.apk);
              else b?.openExternal?.(upd.apk);
              setUpd(null);
            }
          }}
        />
      )}
    </div>
    {wide && !sideOpen && (
      <button className="sideFab" onClick={toggleSide} aria-label="Open sidebar" title="OurDrop">
        <Icon name="panel" size={19} />
      </button>
    )}
    {intro !== "done" && (
      <div className={"splashWrap introOverlay" + (intro === "leaving" ? " leaving" : "")} aria-hidden="true">
        <img className="splashLogo" src="/logo.png" alt="" />
        <div className="splashName">OURDROP</div>
        <div className="splashSub">PC ⇄ Mobile File Sharing</div>
        <div className="introWaves">
          <span />
          <span className="w2" />
        </div>
      </div>
    )}
    </>
  );
}

/* Full-app animated plasma background (PC + mobile): flowing
   luminous ribbons — cyan through violet to magenta — drawn on ONE
   canvas fixed behind the shell. It is translucent, so the body
   gradient, glows and bottom wave still composite beneath it, and
   the existing hero/splash waves are untouched. Deliberately NOT
   pointer-reactive (v39, user's call): no pointer listeners, no
   glow pass, no per-point distance math — just the flowing
   animation, kept light so low-end devices do not pay CPU/memory
   for interaction effects. Single rAF loop, DPR capped (lower on
   touch devices), fewer ribbons on narrow screens, pauses while
   hidden, one static frame under prefers-reduced-motion, full
   cleanup on unmount. If a 2D context is unavailable the body
   background simply remains. */
function PlasmaBg() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    // Adaptive render quality (v43, Phase 5): the plasma LOOK is
    // unchanged, but weaker devices draw fewer ribbons on a coarser
    // mesh, at a capped frame rate and on a smaller backing store —
    // the v42 benchmark showed the full-rate full-size raster eating
    // the idle main thread at desktop sizes (202 long tasks / 30 s).
    // Strong devices (tier 2) keep the exact v39 rendering.
    const cores = navigator.hardwareConcurrency || 4;
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory || 4;
    const tier = cores >= 8 && mem >= 8 ? 2 : cores <= 2 || mem <= 2 ? 0 : 1;
    const scale = tier === 2 ? 1 : tier === 1 ? 0.85 : 0.7;
    const frameMs = tier === 2 ? 0 : tier === 1 ? 1000 / 30 : 1000 / 24;
    let w = 0;
    let h = 0;
    const dpr = Math.min(coarse ? 1 : 1.25, window.devicePixelRatio || 1) * scale;
    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (t: number) => {
      const light = document.documentElement.dataset.theme === "light";
      const N = tier === 2 ? (w < 640 ? 12 : 16) : tier === 1 ? (w < 640 ? 10 : 12) : w < 640 ? 8 : 9;
      const step = tier === 2 ? (w < 640 ? 14 : 10) : tier === 1 ? (w < 640 ? 16 : 12) : w < 640 ? 20 : 16;
      ctx.clearRect(0, 0, w, h);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      if (light) {
        g.addColorStop(0, "rgba(206,216,250,0.34)");
        g.addColorStop(1, "rgba(238,242,255,0.42)");
      } else {
        g.addColorStop(0, "rgba(43,18,92,0.52)");
        g.addColorStop(0.55, "rgba(16,14,58,0.55)");
        g.addColorStop(1, "rgba(5,10,32,0.66)");
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.lineCap = "round";
      for (let i = 0; i < N; i++) {
        const f = i / (N - 1);
        const hue = 188 + f * 128;
        const baseY = h * (0.16 + 0.68 * f) + Math.sin(t * 0.11 + i * 0.9) * h * 0.012;
        const a1 = h * 0.05;
        const a2 = h * 0.022;
        const ph = i * 0.62;
        const pts: number[] = [];
        for (let x = -10; x <= w + 10; x += step) {
          const y =
            baseY +
            Math.sin(x * ((Math.PI * 2) / (w * 0.92)) + t * 0.34 + ph) * a1 +
            Math.sin(x * ((Math.PI * 2) / (w * 0.36)) - t * 0.21 + ph * 1.7) * a2;
          pts.push(y);
        }
        const strokePts = () => {
          ctx.beginPath();
          let x = -10;
          for (let k = 0; k < pts.length; k++) {
            if (k === 0) ctx.moveTo(x, pts[k]);
            else ctx.lineTo(x, pts[k]);
            x += step;
          }
          ctx.stroke();
        };
        ctx.strokeStyle = `hsla(${hue}, 95%, ${light ? 52 : 64}%, ${light ? 0.05 : 0.055})`;
        ctx.lineWidth = 7;
        strokePts();
        ctx.strokeStyle = `hsla(${hue}, 95%, ${light ? 48 : 66}%, ${light ? 0.13 : 0.17})`;
        ctx.lineWidth = 1.3;
        strokePts();
      }
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(0);
      return () => {
        window.removeEventListener("resize", resize);
      };
    }
    let raf = 0;
    let tAcc = 0;
    let lastTs = performance.now();
    let lastDraw = 0;
    const loop = (now: number) => {
      tAcc += Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;
      if (!frameMs || now - lastDraw >= frameMs) {
        lastDraw = now;
        draw(tAcc);
      }
      raf = requestAnimationFrame(loop);
    };
    // v46: the loop also pauses while the window is not focused (the
    // v45 full-test report §4: a visible-but-unfocused window still
    // cost ~18% CPU on the owner's PC — all of it this raster). Same
    // stop/start pattern as the hidden pause: the last drawn frame
    // simply stays on screen, and motion resumes from it on return —
    // no reload, no black flash. On the phone, focus agrees with
    // visibility, so behaviour there is unchanged.
    let focused = document.hasFocus();
    const syncGate = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && focused) {
        lastTs = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    syncGate();
    const onVis = () => syncGate();
    const onFocus = () => {
      focused = true;
      syncGate();
    };
    const onBlur = () => {
      focused = false;
      syncGate();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return <canvas ref={ref} className="plasmaBg" aria-hidden="true" />;
}

function SideBtn({ icon, label, on, fn }: { icon: string; label: string; on: boolean; fn: () => void }) {
  return (
    <button className={on ? "on" : ""} onClick={fn}>
      <Icon name={icon} size={19} fill={icon === "send"} />
      {label}
    </button>
  );
}
function TabBtn({ icon, label, on, fn }: { icon: string; label: string; on: boolean; fn: () => void }) {
  return (
    <button className={on ? "on" : ""} onClick={fn}>
      <Icon name={icon} size={21} />
      {label}
    </button>
  );
}

/* ================= STAGING ================= */
function StagePanel({
  staged,
  onUnstage,
  onSend,
  onClear,
  disabled,
}: {
  staged: StageItem[];
  onUnstage: (k: number) => void;
  onSend: () => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const total = staged.reduce((a, s) => a + s.size, 0);
  return (
    <div className="card stagePanel">
      <div className="caps" style={{ marginBottom: 6 }}>
        Ready to send — {staged.length} file(s) • {fmtSize(total)}
      </div>
      {staged.map((s) => (
        <div className="stageRow" key={s.key}>
          {s.thumb ? (
            <img className="thumb" src={s.thumb} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="thumbIcon">
              <FileTypeIcon name={s.name} size={22} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fn" style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
            <div className="fm" style={{ fontSize: 12, color: "var(--muted)" }}>{fmtSize(s.size)}</div>
          </div>
          <button className="xbtn" onClick={() => onUnstage(s.key)} aria-label="Remove">
            <Icon name="x" size={15} />
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <button className="btn send sm" onClick={onSend} disabled={disabled}>
          <Icon name="send" size={16} fill /> Send {staged.length} file(s)
        </button>
        <button className="btn ghost sm" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}

/* ================= SEND PANEL ================= */
function SendPanel({
  items,
  onPause,
  onResume,
  onCancelAll,
  stalledNames,
}: {
  items: QItem[];
  onPause: (i: QItem) => void;
  onResume: (i: QItem) => void;
  onCancelAll: () => void;
  /** v48: offered files whose phone-side download failed or stalled —
   *  their rows offer a genuine Re-send (a fresh offer). */
  stalledNames?: Set<string>;
}) {
  const visible = items.filter((i) => i.state !== "done" || items.length <= 6).slice(-6);
  const total = items.reduce((a, i) => a + i.size, 0);
  const loaded = items.reduce((a, i) => a + (i.state === "done" ? i.size : i.sent), 0);
  const pct = total ? Math.floor((loaded / total) * 100) : 0;
  const anyActive = items.some((i) => i.state === "active");
  // v48: while an upload is active, re-render once a second so a
  // stalled transfer can label itself "Reconnecting…" — during a
  // network outage no progress callbacks arrive to drive renders.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!anyActive) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [anyActive]);
  const anyPaused = items.some((i) => i.state === "paused");
  const C = 465;
  return (
    <div className="card sendPanel">
      <div className="ringWrap">
        <svg width="176" height="176" viewBox="0 0 176 176">
          <circle cx="88" cy="88" r="74" fill="none" stroke="var(--card2)" strokeWidth="11" />
          <circle
            cx="88"
            cy="88"
            r="74"
            fill="none"
            stroke="url(#ringG)"
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C - (C * pct) / 100}
            style={{ transition: "stroke-dashoffset .25s" }}
          />
          <defs>
            <linearGradient id="ringG" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#38BDF8" />
              <stop offset="1" stopColor="#2F7BFF" />
            </linearGradient>
          </defs>
        </svg>
        <div className="ringPct">
          <div className="p">{pct}%</div>
          <div className="l">{anyPaused ? "Paused" : anyActive ? "Sending…" : "Transfers"}</div>
        </div>
      </div>
      <div className="sendMeta">
        {fmtSize(loaded)} of {fmtSize(total)}
      </div>
      <div>
        {visible.map((i, k) => (
          <div className="frow" key={k}>
            <span className="fic">
              <FileTypeIcon name={i.name} size={19} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fn" title={i.name}>{i.name}</div>
              <div className="fm">
                {fmtSize(i.size)} •{" "}
                {i.state === "done" && i.offered
                  ? i.delivered
                    ? "Received by phone"
                    : stalledNames?.has(i.name)
                      ? "Download interrupted on the phone"
                      : "On your phone — waiting for download"
                  : i.state === "done"
                  ? "Sent"
                  : i.state === "active"
                  ? "lastActivity" in i.up && (i.up as ChunkedUpload).lastActivity > 0 && Date.now() - (i.up as ChunkedUpload).lastActivity > 12000
                    ? "Reconnecting… • " + Math.floor((i.sent / Math.max(1, i.size)) * 100) + "%"
                    : Math.floor((i.sent / Math.max(1, i.size)) * 100) + "%"
                  : i.state === "paused"
                  ? `Paused — ${fmtSize(i.sent)} sent, resume keeps the rest`
                  : i.state === "waiting"
                  ? "Waiting for PC approval"
                  : i.state === "error"
                  ? i.error || "Failed"
                  : "Waiting"}
              </div>
            </div>
            {i.state === "done" &&
              (i.offered ? (
                i.delivered ? (
                  <span style={{ color: "var(--ok)" }}>
                    <Icon name="check" size={18} />
                  </span>
                ) : stalledNames?.has(i.name) ? (
                  <button className="pill accent" onClick={() => onResume(i)}>
                    <Icon name="play" size={13} /> Re-send
                  </button>
                ) : null
              ) : i.verified ? (
                <span className="verifiedTag">
                  <Icon name="shield" size={14} /> Verified
                </span>
              ) : (
                <span style={{ color: "var(--ok)" }}>
                  <Icon name="check" size={18} />
                </span>
              ))}
            {i.state === "active" && (
              <button className="pill" onClick={() => onPause(i)}>
                <Icon name="pause" size={13} /> Pause
              </button>
            )}
            {(i.state === "paused" || i.state === "error" || i.state === "waiting") && (
              <button className="pill accent" onClick={() => onResume(i)}>
                <Icon name="play" size={13} /> {i.state === "paused" ? "Resume" : "Retry"}
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="sendBtns">
        <button className="btn danger sm" onClick={onCancelAll}>
          <Icon name="x" size={16} /> Cancel all
        </button>
      </div>
      <div className="sendMeta">Pause keeps the partial file on the PC — Resume continues from the same byte. SHA-256 verifies every finished file.</div>
    </div>
  );
}

/* ================= UPDATE POPUP (v42) =================
   One designed popup for PC + phone, replacing the native update
   dialogs. Detection/download logic is untouched — this component
   only renders what the shell detected and reports the taps. */
function UpdatePopup(p: {
  info: { name: string; notes: string; current: string };
  // v56 (PC only): in-app download state, driven by main's progress
  // events. Absent on the phone — its download is native and the
  // popup closes on tap exactly as before.
  dl?: { phase: "idle" | "downloading" | "error"; percent: number };
  onLater: () => void;
  onDownload: () => void;
}) {
  const dlBusy = p.dl?.phase === "downloading";
  const dlLabel =
    p.dl?.phase === "error"
      ? "Download failed — Retry"
      : dlBusy
        ? p.dl && p.dl.percent >= 0
          ? `Downloading… ${Math.floor(p.dl.percent)}%`
          : "Downloading…"
        : null;
  return (
    <div className="updWrap" onClick={p.onLater}>
      <div className="updStage" onClick={(e) => e.stopPropagation()}>
        <div className="updGlow" aria-hidden="true" />
        <div className="updCard" role="dialog" aria-modal="true" aria-label="OurDrop update">
          <div className="updHead">
            <span className="updHeadIcon">
              <Icon name="download" size={16} />
            </span>
            <span className="updHeadTitle">OurDrop Update</span>
            <button className="updX" onClick={p.onLater} aria-label="Close">
              <Icon name="x" size={15} />
            </button>
          </div>
          <div className="updBody">
            <div className="updLogoTile">
              <img src="/logo.png" alt="" />
              <span className="updBadge">
                <Icon name="refresh" size={12} />
              </span>
            </div>
            <div className="updText">
              <div className="updTitle">A new version is available!</div>
              <div className="updSub">OurDrop {p.info.name} is ready to download.</div>
              {p.info.notes && <div className="updNotes">{p.info.notes}</div>}
              <div className="updChips">
                <span className="updChip">Current: {p.info.current}</span>
                <span className="updArrow">→</span>
                <span className="updChip updChipNew">Available: {p.info.name}</span>
              </div>
            </div>
          </div>
          <div className="updBtns">
            <button className="updBtnLater" onClick={p.onLater}>
              Later
            </button>
            <button className="updBtnDl" onClick={p.onDownload} disabled={dlBusy}>
              <Icon name="download" size={16} /> {dlLabel ?? "Download Update"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= CONFIRM MODAL ================= */
function ConfirmModal(p: {
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modalWrap" onClick={p.onCancel}>
      <div className="modalCard" onClick={(e) => e.stopPropagation()}>
        <div className="modalMsg">{p.message}</div>
        <div className="modalBtns">
          <button className="btn ghost sm" onClick={p.onCancel}>
            Cancel
          </button>
          <button className="btn danger sm" onClick={p.onConfirm}>
            {p.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Dashboard welcome with a fast typewriter reveal when a display name
   is set (Settings → Your Display Name; purely optional). With no name
   it is a plain static "Welcome". Re-runs when the name changes; the
   heading keeps its natural height so the layout never shifts. */
/**
 * Phone-only dashboard name pill, directly under the header (the
 * user's design reference): the shared display name in a compact
 * rounded field with a user icon. The name types in exactly like the
 * PC welcome title (42 ms per character); the effect re-runs only
 * when the name value itself changes, so ordinary refreshes never
 * restart it. (No blinking caret after the name — removed in v36 at
 * the user's request; the typing animation stays.)
 * Tapping turns the pill into an inline editor — saving syncs the
 * new name to both devices via onSave.
 */
function NamePill({ name, onSave }: { name: string; onSave: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (editing) return;
    setTyped(0);
    if (!name) return;
    const t = window.setInterval(() => {
      if (!document.hasFocus()) {
        // v51: on the phone's first open the WebView keeps reporting
        // hasFocus() = false until the user taps something, which
        // froze the pill at its first letter ("A"). Unfocused means
        // "no animation" (v47), not "stay stuck" — show the final
        // state at once; the typewriter still runs normally whenever
        // the document does have focus.
        setTyped(name.length);
        window.clearInterval(t);
        return;
      }
      setTyped((v) => {
        if (v >= name.length) {
          window.clearInterval(t);
          return v;
        }
        return v + 1;
      });
    }, 42);
    return () => window.clearInterval(t);
  }, [name, editing]);
  const commit = () => {
    const v = draft.trim();
    setEditing(false);
    if (v && v !== name) onSave(v);
  };
  if (editing) {
    return (
      <div className="namePill editing">
        <Icon name="user" size={17} />
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="Your name"
          maxLength={40}
        />
      </div>
    );
  }
  return (
    <button
      className="namePill"
      onClick={() => {
        setDraft(name);
        setEditing(true);
      }}
      aria-label="Edit display name"
    >
      <Icon name="user" size={17} />
      <span className="npName">{name ? name.slice(0, Math.max(1, typed)) : "Add your name"}</span>
    </button>
  );
}

function WelcomeTitle({ name }: { name: string }) {
  const full = name ? `Welcome, ${name}` : "Welcome";
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!name) {
      setN(full.length);
      return;
    }
    setN(0);
    const t = window.setInterval(() => {
      if (!document.hasFocus()) return; // v47: typewriter waits while unfocused
      setN((v) => {
        if (v >= full.length) {
          window.clearInterval(t);
          return v;
        }
        return v + 1;
      });
    }, 42);
    return () => window.clearInterval(t);
  }, [full, name]);
  return <h1 aria-label={full}>{full.slice(0, Math.max(1, n))}</h1>;
}

/* Rotating tagline under the desktop welcome heading: a new short
   message every ~5.5 s with a soft fade. Fixed height — no layout
   shift. With reduced-motion enabled it stays on the first message. */
const WELCOME_MSGS = [
  "Share files instantly.",
  "No internet required.",
  "Fast. Secure. Local.",
  "Connect your PC and mobile.",
  "Your files, transferred effortlessly.",
  "Simple sharing with OurDrop.",
];
function RotatingLine() {
  const [i, setI] = useState(0);
  const [show, setShow] = useState(true);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let swap: number | undefined;
    const hold = window.setInterval(() => {
      if (!document.hasFocus()) return; // v47: rotation waits while unfocused
      setShow(false);
      swap = window.setTimeout(() => {
        setI((v) => (v + 1) % WELCOME_MSGS.length);
        setShow(true);
      }, 450);
    }, 5500);
    return () => {
      window.clearInterval(hold);
      if (swap) window.clearTimeout(swap);
    };
  }, []);
  return (
    <div className="rotLine" style={{ opacity: show ? 1 : 0 }} aria-hidden={false}>
      {WELCOME_MSGS[i]}
    </div>
  );
}

/* Open a received file that lives in this phone's Downloads, through the
   Android bridge (secure content:// URI, system app per file type). A
   missing bridge capability is reported, never silent. */
function openReceivedFile(name: string, showToast: (m: string) => void) {
  const b = bridge() as any;
  if (!b) return;
  if (typeof b.previewFile !== "function") {
    showToast("Update the OurDrop app on this phone to open files by tapping");
    return;
  }
  const r = b.previewFile(name);
  if (r === "notfound") showToast("That file is no longer on this phone");
  else if (r === "noapp") showToast("No app on this phone can open this file");
}

/* Open a file from Files / Transfer History: on the PC it opens in
   OurDrop's own preview window (images/videos/PDF) or its default app;
   on the phone it uses the Android bridge viewers. */
function openFileSmart(name: string, showToast: (m: string) => void) {
  if (isDesktopApp()) {
    window
      .odDesktop!.previewFile(name)
      .then((r) => {
        if (r === "notfound") showToast("That file is no longer in the shared folder");
      })
      .catch(() => {});
  } else {
    openReceivedFile(name, showToast);
  }
}

/* ================= HOME ================= */
const TAG_PHRASES = [
  "PC \u21c4 Mobile \u2022 Fast \u2022 Local \u2022 Secure",
  "No cables \u2022 No cloud \u2022 No sign-up",
  "Straight over your Wi-Fi",
  "Nothing leaves your home network",
];

/**
 * Typewriter for the hero tagline: types, dwells and deletes through
 * a few short phrases, always returning to the original tagline. The
 * line height is fixed so the card never shifts; under
 * prefers-reduced-motion the original tagline simply stays put.
 */
function TypeTag() {
  const [text, setText] = useState(TAG_PHRASES[0]);
  useEffect(() => {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    let cancelled = false;
    const dwell = (ms: number, fn: () => void) => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        // v47: while the window is unfocused the typewriter waits —
        // no state changes, no repaints; it resumes mid-phrase.
        if (!document.hasFocus()) {
          dwell(250, fn);
          return;
        }
        fn();
      }, ms);
    };
    const typeFrom = (p: number, n: number) => {
      const full = TAG_PHRASES[p];
      setText(full.slice(0, n));
      if (n < full.length) dwell(45, () => typeFrom(p, n + 1));
      else dwell(2600, () => eraseFrom(p, full.length));
    };
    const eraseFrom = (p: number, n: number) => {
      const full = TAG_PHRASES[p];
      setText(full.slice(0, n));
      if (n > 0) dwell(22, () => eraseFrom(p, n - 1));
      else dwell(350, () => typeFrom((p + 1) % TAG_PHRASES.length, 1));
    };
    dwell(3000, () => eraseFrom(0, TAG_PHRASES[0].length));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div className="tag typeTag" aria-label={TAG_PHRASES[0]}>
      <span aria-hidden="true">{text}</span>
      <span className="caret" aria-hidden="true" />
    </div>
  );
}

function HomeView(p: {
  wide: boolean;
  displayName: string;
  onNameSave: (n: string) => void;
  info: Info | null;
  files: FileItem[];
  peers: Peer[];
  sending: boolean;
  sendDisabled: boolean;
  staged: StageItem[];
  queueItems: QItem[];
  sendPanel: React.ReactNode;
  noReceiver: boolean;
  localRx: RxItem[];
  rxItems: RxItem[];
  onSend: () => void;
  onReceive: () => void;
  onDevices: () => void;
  onHistory: () => void;
  onPick: () => void;
  onUnstage: (k: number) => void;
  onSendStaged: () => void;
  onClearStaged: () => void;
  /** v54: phone is showing the dashboard with no PC session. */
  offline: boolean;
  onConnect: () => void;
}) {
  // v54: the ONLY new visual element — a slim not-connected banner
  // on Home (phone, offline dashboard), styled with the existing
  // connBanner classes.
  const offlineBanner = p.offline ? (
    <div className="connBanner off">
      <Icon name="wifi" size={18} />
      <span className="grow">Not connected — connect to your PC to send and receive files.</span>
      <button className="pill accent" onClick={p.onConnect}>
        Connect
      </button>
    </div>
  ) : null;
  const recent = p.files.slice(0, p.wide ? 4 : 3);
  const stage = p.staged.length > 0 && (
    <StagePanel staged={p.staged} onUnstage={p.onUnstage} onSend={p.onSendStaged} onClear={p.onClearStaged} disabled={p.sendDisabled} />
  );
  const heroBtns = (
    <div className="btnrow">
      <button
        className={"btn send" + (p.noReceiver ? " btnOff" : "")}
        onClick={p.onSend}
        disabled={p.sendDisabled}
        title={p.noReceiver ? "Connect your mobile device first." : undefined}
      >
        <Icon name="send" size={19} fill /> Send
      </button>
      <button className="btn ghost" onClick={p.onReceive}>
        <Icon name="download" size={19} /> Receive
      </button>
    </div>
  );
  const hero = p.sending ? (
    p.sendPanel
  ) : (
    <div className={(p.wide ? "hero heroDesk" : "hero") + " animIn"} style={{ animationDelay: "70ms" }}>
      <div className="heroWaves" aria-hidden="true">
        <span className="w1" />
        <span className="w2" />
      </div>
      <div>
        <HeroScene />
        <h2>Share Files</h2>
        <TypeTag />
      </div>
      {heroBtns}
    </div>
  );
  const connected = (
    <button className="rowcard" onClick={p.onDevices}>
      <span style={{ color: "var(--ok)" }}>
        <Icon name="wifi" size={24} />
      </span>
      <span className="grow">
        <span className="t">Connected</span>
        <div className="s">Connected to {p.info?.device || "…"}</div>
      </span>
      <span className="checkDot">
        <Icon name="check" size={18} />
      </span>
    </button>
  );
  const myDevice = (
    <button className="rowcard" onClick={p.onDevices}>
      <Icon name="monitor" size={24} />
      <span className="grow">
        <span className="t">My Device</span>
        <div className="s">{p.info?.device || "…"}</div>
      </span>
      <Icon name="chevR" size={19} />
    </button>
  );
  const recentCard = (
    <div>
      <div className="sectionHead">
        <span className="caps">{p.wide ? "Recent Transfers" : "Active Transfers"}</span>
        <button className="linkBtn" onClick={p.onHistory}>
          View All →
        </button>
      </div>
      <div className="card" style={{ padding: "6px 8px" }}>
        {recent.length === 0 && <div className="empty">No transfers yet</div>}
        {recent.map((f) => (
          <div className="frow" key={f.name}>
            <span className="fic">
              <FileTypeIcon name={f.name} size={19} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fn" title={f.name}>{f.name}</div>
              <div className="fm">
                {fmtSize(f.size)} • {new Date(f.mtime * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </div>
            </div>
            <span style={{ color: "var(--ok)" }}>
              <Icon name="check" size={18} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  if (!p.wide) {
    return (
      <div className="homeGrid">
        {bridge() && <NamePill name={p.displayName || (p.offline ? "OurDrop" : "")} onSave={p.onNameSave} />}
        {offlineBanner}
        {stage}
        {hero}
        <RxCards localRx={p.localRx} rxItems={p.rxItems} />
        {connected}
        {myDevice}
        {/* v55: no drag-&-drop zone on the phone (bridge) UI — phones
            use the Send picker. Desktop (no bridge) renders it as before. */}
        {!bridge() && (
          <button className="dropzone" onClick={p.onPick}>
            <Icon name="upload" size={26} />
            <div className="t">Drag &amp; drop files here</div>
            <div className="s">or tap Send — photos, videos, PDF, ZIP, APK, anything</div>
          </button>
        )}
        {recentCard}
      </div>
    );
  }
  return (
    <div>
      {offlineBanner}
      <div className="welcomeRow animIn">
        <div>
          <WelcomeTitle name={p.displayName} />
          <div className="sub">Share files between your PC and mobile</div>
          <RotatingLine />
        </div>
        <span className="avatar">{(p.displayName || "O").charAt(0).toUpperCase()}</span>
      </div>
      {stage}
      <div className="homeGrid">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {hero}
          <RxCards localRx={p.localRx} rxItems={p.rxItems} />
          {/* v55: hidden in the phone (bridge) UI only; desktop unchanged. */}
          {!bridge() && (
            <button className="dropzone" onClick={p.onPick}>
              <Icon name="download" size={24} />
              <div className="t">Drag &amp; drop files here to send</div>
              <div className="s">JPG, MP4, PDF, ZIP, APK — any file type</div>
            </button>
          )}
        </div>
        <div className="homeRight">
          <div className="card miniCard">
            <div className="caps">This Device</div>
            <div className="v">{p.info?.device || "…"}</div>
            <div className="v2 allowSelect">{p.info?.ip || ""}</div>
          </div>
          <div className="card miniCard">
            <div className="caps">Nearby Devices</div>
            {p.peers.length === 0 && <div className="peerSub" style={{ marginTop: 6 }}>No device connected yet</div>}
            {p.peers.map((pe) => (
              <div key={pe.ip}>
                <div className="peer">{pe.name || "Android device"}</div>
                <div className="peerSub">Connected — {pe.ip}</div>
              </div>
            ))}
          </div>
          <div className="card miniCard">
            <div className="caps">Shared Files</div>
            <div className="peer">
              {p.files.length} file(s) <span className="peerSub">in the shared folder</span>
            </div>
          </div>
          <div className="card miniCard">
            <div className="caps">Quick Connect</div>
            <div className="qcTiles">
              <button onClick={p.onDevices}>
                <Icon name="qr" size={21} /> Scan QR Code
              </button>
              <button onClick={p.onDevices}>
                <Icon name="link" size={21} /> Use Address
              </button>
            </div>
          </div>
        </div>
      </div>
      {recentCard}
    </div>
  );
}

/* ================= FILE LIST ================= */
function FileList({
  files,
  onChanged,
  showToast,
}: {
  files: FileItem[];
  onChanged: () => void;
  showToast: (m: string) => void;
}) {
  if (!files.length) return <div className="card empty">No files shared yet</div>;
  return (
    <div className="card" style={{ padding: "6px 8px" }}>
      {files.map((f) => {
        const onPhone = bridge()?.isDownloaded(f.name, f.size);
        const preview = () => openFileSmart(f.name, showToast);
        return (
          <div className="frow" key={f.name} onClick={preview} style={bridge() || isDesktopApp() ? { cursor: "pointer" } : undefined}>
            <span className="fic">
              <FileTypeIcon name={f.name} size={19} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fn" title={f.name}>{f.name}</div>
              <div className="fm">
                {fmtSize(f.size)} • {new Date(f.mtime * 1000).toLocaleDateString()}
              </div>
            </div>
            {onPhone ? (
              <span className="pill" style={{ color: "var(--ok)" }}>
                <Icon name="check" size={14} /> On this device
              </span>
            ) : bridge()?.downloadFile ? (
              <button
                className="pill accent"
                onClick={(e) => {
                  e.stopPropagation();
                  addHistory({ name: f.name, size: f.size, dir: "received", time: Date.now(), loc: "Downloads (phone)" });
                  showToast("Downloading " + f.name);
                  // v50: the native shell runs the download itself —
                  // the <a download> + DownloadListener chain left
                  // this tap dead on some WebViews.
                  try {
                    bridge()?.downloadFile?.(f.name);
                  } catch {
                    showToast("Download failed: " + f.name);
                  }
                }}
              >
                <Icon name="download" size={14} /> Download
              </button>
            ) : (
              <a
                className="pill accent"
                href={"/api/download/" + encodeURIComponent(f.name)}
                download={f.name}
                onClick={(e) => {
                  e.stopPropagation();
                  addHistory({ name: f.name, size: f.size, dir: "received", time: Date.now(), loc: "Downloads (phone)" });
                  showToast("Downloading " + f.name);
                }}
              >
                <Icon name="download" size={14} /> Download
              </a>
            )}
            <button
              className="pill"
              aria-label="Delete"
              onClick={async (e) => {
                e.stopPropagation();
                if (confirm(`Remove "${f.name}" for everyone?`)) {
                  await deleteFile(f.name);
                  onChanged();
                }
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ================= LIVE RECEIVE PROGRESS ================= */
// Polls the Android bridge (inside the app) for DownloadManager
// progress; on the PC the same cards are fed by the phone's reports.
function useLocalRx() {
  const [localRx, setLocalRx] = useState<RxItem[]>([]);
  useEffect(() => {
    const b = bridge() as any;
    if (!b?.getReceiveProgress) return;
    const id = setInterval(() => {
      try {
        setLocalRx(JSON.parse(b.getReceiveProgress()));
      } catch {}
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return localRx;
}

function RxCards(p: {
  localRx: RxItem[];
  rxItems: RxItem[];
}) {
  const samplesRef = useRef<Map<string, { t: number; bytes: number }[]>>(new Map());
  const live = p.localRx.length ? p.localRx : p.rxItems;
  if (!live.length) return null;
  const onPhone = p.localRx.length > 0;
  const cancel = (name: string) => {
    if (onPhone) {
      try {
        bridge()?.cancelReceive?.(name);
      } catch {}
    } else {
      cancelRxDownload(name);
    }
  };
  const now = Date.now();
  const withSpeed = live.map((it) => {
    // v48: rolling ~6 s window rate — the honest average throughput
    // of the last few seconds, replacing the per-report delta that
    // swung wildly (1 MB/s one report, 18 MB/s the next).
    let arr = samplesRef.current.get(it.name) || [];
    if (!arr.length || arr[arr.length - 1].bytes !== it.received) arr.push({ t: now, bytes: it.received });
    while (arr.length > 2 && now - arr[0].t > 6000) arr.shift();
    samplesRef.current.set(it.name, arr);
    let speed = 0;
    if (arr.length >= 2) {
      const dt = (arr[arr.length - 1].t - arr[0].t) / 1000;
      if (dt >= 1.2) speed = Math.max(0, (arr[arr.length - 1].bytes - arr[0].bytes) / dt);
    }
    return { ...it, speed };
  });
  return (
    <div className="card" style={{ padding: "6px 8px", marginBottom: 14 }}>
      <div className="caps" style={{ padding: "8px 10px 4px" }}>
        {p.localRx.length ? "Receiving on this phone" : "Downloading on your phone"}
      </div>
      {withSpeed.map((it) => {
        const pct = it.total > 0 ? Math.min(100, Math.round((it.received / it.total) * 100)) : 0;
        const st = it.status || "downloading";
        const base =
          it.total > 0
            ? `${fmtSize(it.received)} of ${fmtSize(it.total)} • ${pct}%`
            : `${fmtSize(it.received)} received`;
        const line =
          st === "interrupted"
            ? `${base} • Interrupted — waiting for the phone`
            : st === "paused"
              ? `${base} • Paused on the phone`
              : st === "failed"
                ? `Download failed on the phone — send the file again to retry`
                : st === "cancelled"
                  ? `Cancelled`
                  : `${base}${it.speed > 0 ? ` • ${fmtSize(it.speed)}/s` : ""}`;
        return (
          <div className="frow" key={it.name}>
            <span className="fic">
              <FileTypeIcon name={it.name} size={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fn" title={it.name}>{it.name}</div>
              <div
                className="fm"
                style={
                  st === "interrupted" || st === "paused"
                    ? { color: "var(--warn, #f5b04c)" }
                    : st === "failed"
                      ? { color: "var(--bad, #fb7185)" }
                      : undefined
                }
              >
                {line}
              </div>
              <div className="rxbar">
                <span style={{ width: pct + "%" }} />
              </div>
            </div>
            <div className="rxPct">{pct}%</div>
            {(st === "downloading" || st === "paused" || st === "interrupted" || st === "failed") && (
              <button className="pill" onClick={() => cancel(it.name)}>
                <Icon name="x" size={13} /> Cancel
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ================= RECEIVE ================= */
/** Consolidated progress for a phone -> PC receive batch: ONE card for
   the whole batch (current file, overall bytes, remaining count)
   instead of any per-file popups. */
function IncomingCard({ incoming }: { incoming: IncomingBatch }) {
  const pct = incoming.bytesTotal > 0 ? Math.min(100, Math.round((incoming.bytesReceived / incoming.bytesTotal) * 100)) : 0;
  const ordinal = Math.min(incoming.total, incoming.completed + (incoming.active > 0 ? 1 : 0));
  const remaining = Math.max(0, incoming.total - incoming.completed);
  return (
    <div className="card" style={{ padding: "14px 16px", marginBottom: 14 }}>
      <div className="caps">
        Receiving {ordinal} of {incoming.total} files
      </div>
      {incoming.currentName ? (
        <div className="fn" title={incoming.currentName} style={{ marginTop: 6 }}>
          {incoming.currentName}
        </div>
      ) : null}
      <div className="rxbar">
        <span style={{ width: pct + "%" }} />
      </div>
      <div className="fm" style={{ marginTop: 6 }}>
        {fmtSize(incoming.bytesReceived)} of {fmtSize(incoming.bytesTotal)} • {pct}% • {remaining} remaining
      </div>
    </div>
  );
}

function ReceiveView({
  info,
  files,
  onChanged,
  showToast,
  rxItems,
  localRx,
  incoming,
}: {
  info: Info | null;
  files: FileItem[];
  onChanged: () => void;
  showToast: (m: string) => void;
  rxItems: RxItem[];
  localRx: RxItem[];
  incoming: IncomingBatch | null;
}) {
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  return (
    <div>
      {incoming && <IncomingCard incoming={incoming} />}
      <RxCards localRx={localRx} rxItems={rxItems} />
      <div className="sectionHead">
        <span className="caps">In the shared folder</span>
        <span style={{ display: "flex", gap: 8 }}>
          <button className="pill" onClick={onChanged}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
          {files.length > 0 && (
            <button className="pill dangerPill" onClick={() => setConfirmDeleteAll(true)}>
              <Icon name="trash" size={14} /> Delete All
            </button>
          )}
        </span>
      </div>
      {confirmDeleteAll && (
        <ConfirmModal
          message="Are you sure you want to delete all files from the shared folder?"
          confirmLabel="Delete All"
          onCancel={() => setConfirmDeleteAll(false)}
          onConfirm={async () => {
            setConfirmDeleteAll(false);
            try {
              const r = await deleteAllFiles();
              showToast(
                r.failed
                  ? `Deleted ${r.deleted} file(s); ${r.failed} could not be deleted (in use)`
                  : `Deleted ${r.deleted} file(s) from the shared folder`
              );
            } catch {
              showToast("Delete All failed — please try again");
            }
            onChanged();
          }}
        />
      )}
      <FileList files={files} onChanged={onChanged} showToast={showToast} />
    </div>
  );
}

/* ================= HISTORY ================= */
function HistoryView({ history, info, showToast }: { history: HistItem[]; info: Info | null; showToast: (m: string) => void }) {
  const [confirmClear, setConfirmClear] = useState(false);
  const locate = (h: HistItem) => {
    if (isDesktopApp()) window.odDesktop!.showInFolder(h.name);
    else if (bridge()) bridge()!.openDownloads();
    else showToast(h.loc || info?.folder || "");
  };
  return (
    <div>
      <div className="sectionHead histHead" style={{ marginTop: 0 }}>
        <h2 className="viewTitle" style={{ margin: 0 }}>Transfer History</h2>
        {history.length > 0 && (
          <button className="pill dangerPill" onClick={() => setConfirmClear(true)}>
            <Icon name="trash" size={14} /> Clear History
          </button>
        )}
      </div>
      {confirmClear && (
        <ConfirmModal
          message="Are you sure you want to clear all transfer history? Your files will not be deleted."
          confirmLabel="Clear History"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            clearHistory();
            showToast("History cleared");
          }}
        />
      )}
      <div className="card" style={{ padding: "6px 8px" }}>
        {history.length === 0 && <div className="empty">No transfers yet</div>}
        {history.map((h, i) => (
          <div
            className="frow"
            key={i}
            onClick={() => openFileSmart(h.name, showToast)}
            style={bridge() || isDesktopApp() ? { cursor: "pointer" } : undefined}
          >
            <span className="fic">
              <FileTypeIcon name={h.name} size={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fn" title={h.name}>{h.name}</div>
              <div className="fm">
                {h.dir === "sent" ? "Sent" : "Received"}
                {h.size ? ` • ${fmtSize(h.size)}` : ""} • {new Date(h.time).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                {h.verified ? (
                  <>
                    {" "}• <span className="verifiedTag"><Icon name="shield" size={12} /> SHA-256 verified</span>
                  </>
                ) : null}
                <br />
                Saved in: {h.loc || info?.folder || "shared folder"}
              </div>
            </div>
            <button
              className="pill"
              onClick={(e) => {
                e.stopPropagation();
                locate(h);
              }}
            >
              <Icon name="locate" size={14} /> Locate
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= DEVICES ================= */
function DevicesView({
  info,
  peers,
  files,
  qr,
  approvals,
  refresh,
  showToast,
}: {
  info: Info | null;
  peers: Peer[];
  files: FileItem[];
  qr: string;
  approvals: Approvals | null;
  refresh: () => void;
  showToast: (m: string) => void;
}) {
  const url = info ? `http://${info.ip}:${info.port}` : "";
  const copyAddr = () => {
    navigator.clipboard?.writeText(url);
    showToast("Address copied — paste it in the phone app");
  };
  return (
    <div>
      <div className="sectionHead" style={{ margin: "4px 2px 12px" }}>
        <h2 className="viewTitle" style={{ margin: 0, flex: 1 }}>Devices</h2>
        <button className="pill" onClick={refresh}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </div>
      {/* v55: the QR card is a PC-side feature (it encodes this
          device's address for a phone to scan) — hidden in the phone
          (bridge) UI only; desktop renders it exactly as before. */}
      {!bridge() && (
        <>
          <div className="card qrBox">
            <div className="caps">Scan with the OurDrop app</div>
            {qr ? <img src={qr} alt="QR code" style={{ marginTop: 12 }} /> : <div className="empty">Loading…</div>}
            <div className="addrRow">
              <span className="addr">{url}</span>
              <button className="pill" onClick={copyAddr}>
                <Icon name="copy" size={14} /> Copy
              </button>
            </div>
          </div>
          <div style={{ height: 14 }} />
        </>
      )}
      <div className="card miniCard">
        <div className="caps">This Device</div>
        <div className="v">{info?.device || "…"}</div>
        <div className="v2 allowSelect">{info?.ip || ""}</div>
        <div className="peerSub" style={{ marginTop: 4 }}>
          {files.length} file(s) in the shared folder
        </div>
      </div>
      <div style={{ height: 14 }} />
      <div className="card miniCard">
        <div className="caps">Nearby Devices</div>
        {peers.length === 0 && <div className="peerSub" style={{ marginTop: 6 }}>No device connected yet — devices on the same Wi-Fi appear here automatically</div>}
        {peers.map((pe) => (
          <div key={pe.ip}>
            <div className="peer">{pe.name || "Android device"}</div>
            <div className="peerSub">Connected — {pe.ip}</div>
          </div>
        ))}
      </div>
      {isDesktopApp() && approvals && (
        <>
          <div style={{ height: 14 }} />
          <div className="card miniCard">
            <div className="caps">Pairing approvals</div>
            {approvals.pending.length === 0 && <div className="peerSub" style={{ marginTop: 6 }}>No pending requests</div>}
            {approvals.pending.map((pd) => (
              <div key={pd.ip} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <div style={{ flex: 1 }}>
                  <div className="peer" style={{ marginTop: 0 }}>{pd.name}</div>
                  <div className="peerSub">{pd.ip}</div>
                </div>
                <button
                  className="pill accent"
                  onClick={async () => {
                    await approveIp(pd.ip);
                    showToast("Device approved");
                    refresh();
                  }}
                >
                  Approve
                </button>
              </div>
            ))}
            {approvals.approved.length > 0 && (
              <div className="peerSub" style={{ marginTop: 8 }}>
                Approved: {approvals.approved.join(", ")}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ================= SETTINGS ================= */
function NameField({
  current,
  showToast,
  onSave,
}: {
  current: string;
  showToast: (m: string) => void;
  onSave: (n: string) => void;
}) {
  const [val, setVal] = useState(current);
  useEffect(() => setVal(current), [current]);
  const trimmed = val.trim();
  const canSave = trimmed.length > 0 && trimmed !== current;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
      <input
        className="modalInput"
        style={{ flex: 1, minWidth: 180, marginTop: 0 }}
        value={val}
        placeholder="Enter your name"
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSave) {
            onSave(trimmed);
            showToast("Display name updated");
          }
        }}
      />
      <button
        className="btn send sm"
        disabled={!canSave}
        onClick={() => {
          onSave(trimmed);
          showToast("Display name updated");
        }}
      >
        Save
      </button>
    </div>
  );
}

/* ================= ABOUT US DATA (v44) =================
   Only the social platforms actually provided are listed per
   developer — never invent a profile URL. Projects are data-driven
   so more can be added by appending one entry. Zynox facts were
   verified from its GitHub repository README on 2026-11-11. */
const ABOUT_DEVS = [
  {
    name: "Ali Emam Rabbi",
    photo: "/dev-photo.jpg",
    degree: "B.Sc. in Computer Science & Engineering",
    university: "First Capital University of Bangladesh",
    socials: [
      { net: "facebook", label: "Facebook", url: "https://www.facebook.com/aliemam.rabby" },
      { net: "linkedin", label: "LinkedIn", url: "https://www.linkedin.com/in/aliemamrabbi/" },
      { net: "github", label: "GitHub", url: "https://github.com/Ali-Emam-Rabbi" },
      { net: "portfolio", label: "Portfolio", url: "https://aliemamportfolio.netlify.app/" },
    ],
  },
  {
    name: "Sadhin Khan",
    photo: "/dev-photo-2.jpg",
    degree: "B.Sc. in Computer Science & Engineering",
    university: "First Capital University of Bangladesh",
    socials: [
      { net: "facebook", label: "Facebook", url: "https://www.facebook.com/zboy404" },
      { net: "github", label: "GitHub", url: "https://github.com/Sadhin404" },
      { net: "instagram", label: "Instagram", url: "https://www.instagram.com/sadhin.404/" },
    ],
  },
];

const PROJECTS = [
  {
    name: "Zynox Download Manager",
    icon: "/project-zynox.png",
    status: "Released · Mobile v81 · PC v8.3.0",
    desc: "Download videos and audio from YouTube, TikTok, Facebook, Instagram and 1000+ other sites. Pick exactly the quality you want — up to 8K video or MP3 at 320 kbps — and it downloads in the background with live progress.",
    features: [
      "Up to 8K video & MP3 at 320 kbps",
      "TikTok downloads without watermark",
      "Pause & resume — even from the notification",
      "Private-video support with encrypted login",
    ],
    tech: ["Android 8.0+", "Windows 10/11", "yt-dlp engine"],
    github: "https://github.com/Sadhin404/Projects/tree/main/Zynox%20Download%20Manager",
    downloads: [
      { label: "Android", url: "https://github.com/Sadhin404/Projects/releases/tag/zynox-mobile-v81" },
      { label: "Windows", url: "https://github.com/Sadhin404/Projects/releases/tag/zynox-pc-v8.3.0" },
    ],
  },
  {
    name: "Breast Ultrasound AI",
    icon: "/project-breast-ai.png",
    status: "Live Website · Thesis Project",
    desc: "An explainable AI second reader for breast ultrasound — it classifies a scan as Normal, Benign or Malignant, and with Grad-CAM it shows exactly which region drove the decision, so a doctor can verify every prediction.",
    features: [
      "EfficientNet-B0 deep-learning model (PyTorch)",
      "Grad-CAM heatmap explains every prediction",
      "Test accuracy 92.31% · Macro F1 92.46%",
      "Web app — prediction, probabilities & PDF report",
    ],
    tech: ["Python", "PyTorch", "EfficientNet-B0", "Grad-CAM"],
    github: "https://github.com/Sadhin404/Ai-ML-Deep-Learning-Project/tree/main/Breast%20Ultrasound%20Classification",
    downloads: [
      { label: "Live Website", url: "https://sadhin404-breast-ultrasound-ai.static.hf.space" },
    ],
  },
  {
    name: "Artistre",
    icon: "/project-artistre.png",
    status: "Released · Android v1.9.2",
    desc: "Turn your imagination into art — Artistre floats any photo over your phone's live camera, so you can trace it line by line onto real paper.",
    features: [
      "Live camera overlay — trace onto real paper",
      "Opacity 5–100%, pinch-zoom & rotation",
      "Pro adjustments — brightness, contrast, saturation",
      "4 drawing modes, incl. Outline for tracing",
    ],
    tech: ["Android 8.0+", "Camera2"],
    github: "https://github.com/Sadhin404/Projects/tree/main/Artistre",
    downloads: [
      { label: "Android", url: "https://github.com/Sadhin404/Projects/releases/tag/artistre-v1.9.2" },
    ],
  },
];

/* ============ ABOUT US VIEW (v45) ============
   Its own page since v45 (sidebar / drawer -> About Us).
   The content is the v44 About section, unchanged. */
function AboutView() {
  return (
      <div className="card setGroup">
        <h3>About OurDrop</h3>
        <p className="aboutIntro">
          <strong>OurDrop</strong> is a simple, fast, and secure Wi-Fi-based file-sharing
          application designed to make transferring files between PC and mobile devices
          effortless.
        </p>
        <p className="aboutIntro">
          Built by two Computer Science &amp; Engineering students of First Capital
          University of Bangladesh, OurDrop aims to provide a smooth, reliable, and
          user-friendly file-sharing experience without depending on the internet.
        </p>
        <div className="aboutTag">OurDrop — Share Freely. Connect Seamlessly.</div>

        <div className="caps aboutCaps">Meet the Developers</div>
        <div className="devGrid">
          {ABOUT_DEVS.map((dev) => (
            <div className="devProfile" key={dev.name}>
              <div className="devPhoto">
                <img src={dev.photo} alt={dev.name} />
              </div>
              <div className="devName">{dev.name}</div>
              <div className="devLine">
                <BrandIcon name="graduation-cap" size={15} />
                <span>{dev.degree}</span>
              </div>
              <div className="devLine">
                <BrandIcon name="landmark" size={13} />
                <span>{dev.university}</span>
              </div>
              <div className="devSocials">
                {dev.socials.map((s) => (
                  <button
                    key={s.net}
                    className="socBtn"
                    aria-label={`${dev.name} on ${s.label}`}
                    title={s.label}
                    onClick={() => openLink(s.url)}
                  >
                    <BrandIcon name={s.net} size={15} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <button className="telegramBtn" onClick={() => openLink("https://t.me/technest404")}>
          <BrandIcon name="telegram" size={17} />
          Join Us on Telegram
        </button>

        <div className="caps aboutCaps">Our Projects</div>
        <p className="aboutSub">Explore the applications and digital solutions we&apos;re building.</p>
        <div className="projGrid">
          {PROJECTS.map((pr) => (
            <div className="projCard" key={pr.name}>
              <div className="projHead">
                <img className="projIcon" src={pr.icon} alt="" />
                <div>
                  <div className="projName">{pr.name}</div>
                  <div className="projStatus">{pr.status}</div>
                </div>
              </div>
              <p className="projDesc">{pr.desc}</p>
              <ul className="projFeats">
                {pr.features.map((f) => (
                  <li key={f}>
                    <Icon name="check" size={13} /> {f}
                  </li>
                ))}
              </ul>
              <div className="projChips">
                {pr.tech.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <div className="projBtns">
                <button className="projBtn primary" onClick={() => openLink(pr.github)}>
                  <BrandIcon name="github" size={14} /> View on GitHub
                </button>
                {pr.downloads.map((d) => (
                  <button key={d.label} className="projBtn" onClick={() => openLink(d.url)}>
                    <Icon name="download" size={14} /> {d.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
  );
}

function SettingsView({
  theme,
  setTheme,
  info,
  refresh,
  showToast,
  displayName,
  onNameSave,
  updCheck,
  onCheckUpdates,
}: {
  theme: string;
  setTheme: (t: string) => void;
  info: Info | null;
  refresh: () => void;
  showToast: (m: string) => void;
  displayName: string;
  onNameSave: (n: string) => void;
  updCheck: "idle" | "checking" | "uptodate" | "available" | "error";
  onCheckUpdates: () => void;
}) {
  const desktop = isDesktopApp();
  const [appSet, setAppSet] = useState<{ minimizeToTray: boolean; startWithWindows: boolean } | null>(null);
  useEffect(() => {
    if (desktop) window.odDesktop!.getAppSettings().then(setAppSet).catch(() => {});
  }, [desktop]);
  // Phone only: is the system limiting OurDrop's background running?
  // (That limit is what silently kills the connection ~1 min after the
  // app is left.) Re-checked whenever the app regains focus, so the
  // card disappears once the user grants the exemption.
  const [battExempt, setBattExempt] = useState<boolean | null>(null);
  useEffect(() => {
    if (desktop) return;
    const check = () => {
      try {
        setBattExempt(window.OurDropAndroid?.isBatteryExempt ? window.OurDropAndroid.isBatteryExempt() : null);
      } catch {
        setBattExempt(null);
      }
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [desktop]);
  return (
    <div>
      <h2 className="viewTitle">Settings</h2>
      <div className="card setGroup">
        <h3>Your Display Name</h3>
        <div className="d">Shown in your dashboard welcome message. Saved only on this device.</div>
        <NameField current={displayName} showToast={showToast} onSave={onNameSave} />
      </div>
      <div className="card setGroup">
        <h3>Appearance</h3>
        <div className="d">Choose the app theme. System follows your device's light/dark appearance automatically.</div>
        <div className="seg">
          <button className={theme === "system" ? "on" : ""} onClick={() => setTheme("system")}>
            <Icon name="monitor" size={15} /> System
          </button>
          <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>
            <Icon name="sun" size={15} /> Light
          </button>
          <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}>
            <Icon name="moon" size={15} /> Dark
          </button>
        </div>
      </div>
      {!desktop && battExempt === false && (
        <div className="card setGroup">
          <h3>Background connection</h3>
          <div className="d">
            Your phone is limiting OurDrop in the background, so the connection drops about a minute after you leave the
            app — even though the notification still shows. Allow OurDrop to run in the background to keep it connected.
          </div>
          <button className="btn send sm" onClick={() => window.OurDropAndroid?.openBatterySettings?.()}>
            Allow background running
          </button>
        </div>
      )}
      <div className="card setGroup">
        <h3>Storage location</h3>
        <div className="d">
          {desktop
            ? "Received files are saved in this folder on the PC."
            : "Files you receive are saved in the phone's Downloads folder. Files sent to the PC are saved here:"}
        </div>
        <div className="pathTxt">{info?.folder || "…"}</div>
        {info?.protectedFolder && (
          <div className="d" style={{ color: "#f0b35e", marginTop: 8 }}>
            This is a Windows-protected folder (Controlled Folder Access). If receiving fails, allow OurDrop in
            Windows Security → Virus &amp; threat protection → Ransomware protection → “Allow an app through
            Controlled folder access” — or choose a different folder.
          </div>
        )}
        {desktop && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn send sm"
              onClick={async () => {
                const f = await window.odDesktop!.pickFolder();
                if (f?.error) {
                  showToast(f.error);
                } else if (f?.path) {
                  showToast(
                    f.warning === "protected"
                      ? "Storage updated — Windows may block saving here; see the note above the folder path"
                      : "Storage location updated",
                  );
                  refresh();
                }
              }}
            >
              <Icon name="folder" size={15} /> Change folder…
            </button>
            <button className="btn ghost sm" onClick={() => window.odDesktop!.openFolder()}>
              <Icon name="folder" size={15} /> Open folder
            </button>
          </div>
        )}
      </div>
      {desktop && (
        <div className="card setGroup">
          <h3>Device pairing</h3>
          <div className="d">When on, a new device must be approved on this PC before it can send or download files. Your own phone only needs approval once.</div>
          <div className="seg">
            <button
              className={info?.approvalRequired ? "on" : ""}
              onClick={async () => {
                await setRequireApproval(true);
                showToast("Pairing approval on");
                refresh();
              }}
            >
              <Icon name="shield" size={15} /> Approval on
            </button>
            <button
              className={!info?.approvalRequired ? "on" : ""}
              onClick={async () => {
                await setRequireApproval(false);
                showToast("Pairing approval off");
                refresh();
              }}
            >
              Off
            </button>
          </div>
        </div>
      )}
      {desktop && appSet && (
        <div className="card setGroup">
          <h3>Desktop app</h3>
          <div className="d">OurDrop keeps sharing in the background from the system tray.</div>
          <div className="seg" style={{ marginBottom: 10 }}>
            <button
              className={appSet.minimizeToTray ? "on" : ""}
              onClick={async () => {
                await window.odDesktop!.setAppSetting("minimizeToTray", !appSet.minimizeToTray);
                setAppSet({ ...appSet, minimizeToTray: !appSet.minimizeToTray });
              }}
            >
              Minimize to tray: {appSet.minimizeToTray ? "On" : "Off"}
            </button>
          </div>
          <div className="seg">
            <button
              className={appSet.startWithWindows ? "on" : ""}
              onClick={async () => {
                await window.odDesktop!.setAppSetting("startWithWindows", !appSet.startWithWindows);
                setAppSet({ ...appSet, startWithWindows: !appSet.startWithWindows });
              }}
            >
              Start with Windows: {appSet.startWithWindows ? "On" : "Off"}
            </button>
          </div>
        </div>
      )}
      <div className="card setGroup">
        <h3>Updates</h3>
        <div className="d">
          OurDrop also checks for updates automatically when it starts — or check
          right now:
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn" onClick={onCheckUpdates} disabled={updCheck === "checking"}>
            {updCheck === "checking" ? "Checking…" : "Check for Updates"}
          </button>
          {updCheck === "uptodate" && <span className="updStatus ok">You&apos;re up to date.</span>}
          {updCheck === "available" && <span className="updStatus">A new version is available!</span>}
          {updCheck === "error" && <span className="updStatus err">Couldn&apos;t check — please try again.</span>}
        </div>
      </div>
      <div className="card setGroup">
        <h3>About</h3>
        <div className="d" style={{ marginBottom: 0 }}>
          OurDrop v60 — React, Electron, Capacitor and Node.js. Resumable transfers with
          SHA-256 verification, live WebSocket status and mDNS discovery. Files move only
          inside your own Wi-Fi network; received files are never opened automatically.
        </div>
      </div>
    </div>
  );
}
