// OurDrop desktop — Electron main process.
// Starts the Node server, opens the React UI, bridges native actions,
// adds system tray, native notifications and start-with-Windows.
import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer, loadSettings, saveSettings, lanIp } from "../server/server.mjs";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

// ---- Windows identity: the app must present itself as "OurDrop" (with
// its own icon) in Windows Search, Start Menu, taskbar and shortcuts —
// never as the stock "Electron" binary it is built from.
// Keep the historical userData folder ("ourdrop") so existing users keep
// their settings and transfer history after this rename.
try {
  app.setPath("userData", path.join(app.getPath("appData"), "ourdrop"));
} catch {}
app.setName("OurDrop");
if (process.platform === "win32") {
  try {
    app.setAppUserModelId("com.ourdrop.desktop");
  } catch {}
}

// Create (or repair) a proper Start Menu shortcut on Windows so Search
// finds "OurDrop" with the right icon and AppUserModelID. Zip installs
// have no installer, so the app registers its own shortcut on launch.
function ensureStartMenuShortcut() {
  if (process.platform !== "win32") return;
  try {
    const dir = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
    const linkPath = path.join(dir, "OurDrop.lnk");
    const target = process.execPath;
    let needsWrite = true;
    if (fs.existsSync(linkPath)) {
      try {
        const cur = shell.readShortcutLink(linkPath);
        if (cur && cur.target === target && cur.appUserModelId === "com.ourdrop.desktop") needsWrite = false;
      } catch {}
    }
    if (needsWrite) {
      fs.mkdirSync(dir, { recursive: true });
      shell.writeShortcutLink(linkPath, "create", {
        target,
        cwd: path.dirname(target),
        description: "OurDrop — PC ⇄ Mobile File Sharing",
        icon: target,
        iconIndex: 0,
        appUserModelId: "com.ourdrop.desktop",
      });
    }
  } catch {}
}

// Settings + default shared folder live beside the app (same as v1–v9),
// falling back to userData when that folder is not writable. In the loose
// Electron layout (OurDrop.exe + resources/app) that means beside the .exe.
function appBaseDir() {
  const besideExe = path.dirname(process.execPath);
  let candidate = projectRoot;
  if (fs.existsSync(path.join(besideExe, "resources", "app"))) candidate = besideExe;
  else if (app.isPackaged) candidate = besideExe;
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return candidate;
  } catch {
    return app.getPath("userData");
  }
}

let baseDir, getSharedDir, serverPort, win, tray = null;
let pendingUpdatePc = "";
let pendingUpdateName = "";

// v53: autostart launches pass --hidden — the app starts in the tray
// (server live) without showing the window.
const startHidden = process.argv.includes("--hidden");

/** Start-with-Windows registration. The Settings toggle
 *  (settings.start_with_windows) is the single source of truth; this
 *  helper is the ONLY place the registration is written. Windows and
 *  macOS go through Electron's login-item API — on Windows with the
 *  --hidden arg, so a boot-time start lands in the tray instead of
 *  opening the window. The login-item API does not cover Linux, so
 *  there an XDG autostart entry does the same job. */
function applyAutostart(enabled) {
  try {
    if (process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
    } else if (process.platform === "darwin") {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } else if (process.platform === "linux") {
      const file = path.join(app.getPath("home"), ".config", "autostart", "ourdrop.desktop");
      if (enabled) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file,
          "[Desktop Entry]\n" +
          "Type=Application\n" +
          "Name=OurDrop\n" +
          "Comment=OurDrop — PC ⇄ Mobile File Sharing\n" +
          "Exec=\"" + process.execPath + "\" --hidden\n" +
          "X-GNOME-Autostart-enabled=true\n");
      } else {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  } catch {}
}

/** Surface the ONE main window: un-hide it, un-minimize it, focus it.
 *  Used by every "bring OurDrop back" path (tray click, tray menu,
 *  second-instance, OS activate) so they all behave identically and
 *  never create a second window. */
function showMainWindow() {
  try {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch {}
}
const fmtSize = (b) =>
  b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB"
  : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB"
  : b >= 1024 ? (b / 1024).toFixed(0) + " KB"
  : b + " B";

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: path.join(projectRoot, "public", "icon-512.png") });
    n.on("click", () => {
      if (win) {
        win.show();
        win.focus();
      }
    });
    n.show();
  } catch {}
}

// Notification policy: brief stalls must never reach the user. The
// server only emits peer-left after a long verified silence; here we
// additionally suppress join notifications for quick rejoins and dedupe
// repeated events for the same device.
const lastLeftAt = new Map();
const lastJoinNotify = new Map();
const lastLeftNotify = new Map();
function onServerEvent(evt) {
  if (!evt || typeof evt !== "object") return;
  const who = evt.name && evt.name !== "Android device" ? evt.name : "A device";
  const key = evt.key || evt.ip || who;
  const now = Date.now();
  // "received" (a file arrived) is deliberately NEVER notified: during
  // a multi-file receive, one Windows toast + sound per file is exactly
  // the irritation to avoid. Progress and completion are shown inside
  // the app instead (Receive view batch card + in-app status).
  if (evt.type === "peer-joined") {
    const leftAt = lastLeftAt.get(key) || 0;
    if (now - leftAt < 10 * 60000) return; // silent rejoin — it was never really gone for the user
    if (now - (lastJoinNotify.get(key) || 0) < 10 * 60000) return;
    lastJoinNotify.set(key, now);
    notify("OurDrop — device connected", `${who} (${evt.ip}) connected`);
  } else if (evt.type === "peer-left") {
    lastLeftAt.set(key, now);
    if (now - (lastLeftNotify.get(key) || 0) < 5 * 60000) return;
    lastLeftNotify.set(key, now);
    notify("OurDrop — device disconnected", `${who} (${evt.ip}) disconnected`);
  } else if (evt.type === "approval-needed") {
    notify("OurDrop — approval needed", `${who} (${evt.ip}) wants to transfer files. Open OurDrop to approve.`);
  }
  // peer-unresponsive / peer-active: internal states — never notified.
}

async function boot() {
  baseDir = appBaseDir();
  // v60: sweep stale update installers left by earlier updates
  // (including the one whose install just replaced this copy).
  cleanupUpdateInstallers();
  ensureStartMenuShortcut();

  const s0 = loadSettings(baseDir);
  // v53: autostart defaults to ON for fresh installs; an existing
  // stored preference is respected and never overridden.
  if (s0.start_with_windows === undefined) {
    s0.start_with_windows = true;
    saveSettings(baseDir, s0);
  }
  applyAutostart(s0.start_with_windows === true);

  const started = await startServer({ baseDir, dataDir: app.getPath("userData"), onEvent: onServerEvent });
  getSharedDir = started.getSharedDir;
  serverPort = started.port;

  // v50: the Files list's Download button is a plain <a download>;
  // Electron silently drops those unless a will-download handler
  // gives the item a save path. Save into the OS Downloads folder
  // like a browser would, de-duping the name if a copy is there.
  session.defaultSession.on("will-download", (e, item) => {
    try {
      const dir = app.getPath("downloads");
      const fn = item.getFilename();
      const ext = path.extname(fn);
      const stem = ext ? fn.slice(0, -ext.length) : fn;
      let target = path.join(dir, fn);
      for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
      item.setSavePath(target);
    } catch {}
  });

  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 380,
    minHeight: 560,
    show: false,
    title: "OurDrop — PC ⇄ Mobile File Transfer",
    icon: path.join(projectRoot, "build", "icon.ico"),
    autoHideMenuBar: true,
    backgroundColor: "#0B1526",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  // No separate splash window anymore: the window appears as soon as
  // the app is ready, and the intro animation plays INSIDE the app as
  // an overlay over the already-mounted dashboard, fading out in
  // place — no window swap, no size jump, no abrupt switch.
  win.once("ready-to-show", () => {
    // v53: an autostart launch (--hidden) stays in the tray — the
    // server is live but no window appears (and the in-app intro
    // never flashes) until the user opens OurDrop.
    if (startHidden) return;
    if (win && !win.isDestroyed()) win.show();
  });
  win.on("close", (e) => {
    const s = loadSettings(baseDir);
    if (s.minimize_to_tray !== false && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  console.log(`OurDrop desktop: http://${lanIp()}:${serverPort} (phone URL)`);
  const updTimer = setTimeout(() => { checkForUpdatePc(); }, 3000);
  if (updTimer.unref) updTimer.unref();

  // ---- system tray ----
  try {
    tray = new Tray(path.join(projectRoot, "public", "icon-192.png"));
    tray.setToolTip("OurDrop");
    const menu = Menu.buildFromTemplate([
      { label: "Open OurDrop", click: () => showMainWindow() },
      { label: "Open Shared Folder", click: () => shell.openPath(getSharedDir()) },
      { type: "separator" },
      { label: "Quit OurDrop", click: () => { tray.destroy(); tray = null; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    // A single click on the tray icon restores the window (this was
    // missing — only double-click was wired, and even that did not
    // un-minimize, so the app looked dead from the tray).
    tray.on("click", () => showMainWindow());
    tray.on("double-click", () => showMainWindow());
  } catch {
    tray = null;
  }
}

ipcMain.handle("od:pickPaths", async () => {
  // Reopen the picker in the folder the user last picked files from
  // (persisted in the app settings, so it survives restarts). If that
  // folder no longer exists, fall back to the OS default.
  const s = loadSettings(baseDir);
  const opts = {
    properties: ["openFile", "multiSelections"],
    title: "Choose files to send",
  };
  if (s.last_pick_dir && fs.existsSync(s.last_pick_dir)) {
    opts.defaultPath = s.last_pick_dir;
  }
  const r = await dialog.showOpenDialog(opts);
  if (r.canceled) return [];
  if (r.filePaths.length) {
    const dir = path.dirname(r.filePaths[0]);
    if (dir !== s.last_pick_dir) {
      s.last_pick_dir = dir;
      saveSettings(baseDir, s);
    }
  }
  return r.filePaths
    .map((p) => {
      try {
        const st = fs.statSync(p);
        return st.isFile() ? { path: p, name: path.basename(p), size: st.size } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
});
ipcMain.handle("od:pickFolder", async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose where received files are saved",
  });
  if (r.canceled || !r.filePaths.length) return null;
  const dir = r.filePaths[0];
  try {
    // Validate before saving: the folder must exist/be creatable and
    // writable — otherwise keep the previous location.
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { error: "That folder can't be used — OurDrop can't write to it. Your previous storage location was kept." };
  }
  // Real write probe: Windows Controlled Folder Access lets a folder
  // LOOK writable (the check above passes) yet blocks this app's
  // actual writes at receive time. Probe with a real file so the
  // user gets the warning NOW, not at the first failed transfer.
  // The folder is still saved — once the user allows OurDrop in
  // Windows Security, receiving there works.
  let warning = null;
  const probe = path.join(dir, ".ourdrop-probe-" + Date.now());
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch {
    warning = "protected";
  }
  const s = loadSettings(baseDir);
  s.shared_dir = dir;
  saveSettings(baseDir, s);
  return { path: dir, warning };
});
ipcMain.handle("od:getSettings", () => {
  const s = loadSettings(baseDir);
  return { folder: getSharedDir(), shared_dir: s.shared_dir || null };
});
ipcMain.handle("od:openFolder", () => shell.openPath(getSharedDir()));
ipcMain.handle("od:showInFolder", (_e, name) => {
  const p = path.join(getSharedDir(), String(name || ""));
  if (fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(getSharedDir());
});
ipcMain.handle("od:getAppSettings", () => {
  const s = loadSettings(baseDir);
  return {
    minimizeToTray: s.minimize_to_tray !== false,
    startWithWindows: s.start_with_windows === true,
  };
});
// ---- File preview (Files / History clicks on the PC) ----
// Images and videos open in OurDrop's own preview window; PDFs in the
// built-in viewer; everything else goes straight to the file's default
// application via shell.openPath. The generic Windows "Open With"
// chooser is never used for the common formats.
const PREVIEW_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const PREVIEW_VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"]);
let previewWin = null;
let previewData = null;

function openPreviewWindow(data) {
  previewData = data;
  if (previewWin && !previewWin.isDestroyed()) {
    if (data.kind === "pdf") previewWin.loadURL(pathToFileURL(data.file).href);
    else previewWin.loadFile(path.join(projectRoot, "dist", "preview.html"));
    previewWin.show();
    previewWin.focus();
    return;
  }
  previewWin = new BrowserWindow({
    width: 1020,
    height: 740,
    minWidth: 420,
    minHeight: 320,
    title: "OurDrop — Preview",
    backgroundColor: "#050B16",
    icon: path.join(projectRoot, "build", "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preview-preload.cjs"),
    },
  });
  previewWin.on("closed", () => {
    previewWin = null;
    previewData = null;
  });
  if (data.kind === "pdf") {
    previewWin.loadURL(pathToFileURL(data.file).href).catch(() => {
      shell.openPath(data.file).catch(() => {});
    });
  } else {
    previewWin.loadFile(path.join(projectRoot, "dist", "preview.html")).catch(() => {});
  }
}

ipcMain.handle("od:previewData", () => previewData);

ipcMain.handle("od:previewOpenDefault", async (_e, p) => {
  try {
    const dir = path.resolve(getSharedDir());
    const fp = path.resolve(String(p));
    if (!fp.startsWith(dir + path.sep)) return "denied";
    await shell.openPath(fp);
    return "opened";
  } catch {
    return "error";
  }
});

ipcMain.handle("od:previewFile", async (_e, name) => {
  try {
    if (!name || typeof name !== "string" || name.includes("/") || name.includes("\\")) return "notfound";
    const dir = getSharedDir();
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return "notfound";
    const ext = path.extname(name).toLowerCase();
    if (PREVIEW_IMAGE_EXTS.has(ext)) {
      let images = [];
      try {
        images = fs
          .readdirSync(dir)
          .filter((f) => PREVIEW_IMAGE_EXTS.has(path.extname(f).toLowerCase()))
          .sort((a, b) => a.localeCompare(b));
      } catch {}
      if (!images.includes(name)) images = [name];
      openPreviewWindow({
        kind: "image",
        name,
        file: fp,
        images: images.map((f) => path.join(dir, f)),
        index: images.indexOf(name),
      });
      return "opened";
    }
    if (PREVIEW_VIDEO_EXTS.has(ext)) {
      openPreviewWindow({ kind: "video", name, file: fp });
      return "opened";
    }
    if (ext === ".pdf") {
      openPreviewWindow({ kind: "pdf", name, file: fp });
      return "opened";
    }
    await shell.openPath(fp);
    return "external";
  } catch {
    return "notfound";
  }
});

ipcMain.handle("od:setAppSetting", (_e, key, value) => {
  const s = loadSettings(baseDir);
  if (key === "minimizeToTray") s.minimize_to_tray = !!value;
  if (key === "startWithWindows") {
    s.start_with_windows = !!value;
    applyAutostart(!!value);
  }
  saveSettings(baseDir, s);
});

// ---- Update check (v40): read the small version.json notice file
// from the public GitHub repo; if it names a newer release than this
// install, offer it once per day per version. Silent on ANY failure
// (offline, timeout, bad JSON). OURDROP_UPDATE_URL overrides the
// source for testing.
async function checkForUpdatePc(manual = false) {
  // Manual checks (the Settings button) report their outcome back to
  // the renderer; the automatic check stays silent exactly as before.
  const report = (status) => {
    if (manual && win && !win.isDestroyed()) win.webContents.send("od:updateResult", { status });
  };
  try {
    const url = process.env.OURDROP_UPDATE_URL ||
      "https://raw.githubusercontent.com/Ali-Emam-Rabbi/ourdrop/main/version.json";
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { report("error"); return; }
    const j = await res.json();
    const latest = Number(j.latest || 0);
    const mine = parseInt(app.getVersion().split(".")[0], 10) || 0;
    if (!latest || latest <= mine) { report("uptodate"); return; }
    const dayKey = `${latest}:${new Date().toISOString().slice(0, 10)}`;
    const s = loadSettings(baseDir);
    if (!manual && s.update_prompted === dayKey) return;
    s.update_prompted = dayKey;
    saveSettings(baseDir, s);
    console.log(`[update] OurDrop ${j.name || "v" + latest} available`);
    if (!win || win.isDestroyed()) { report("error"); return; }
    // v42: the designed in-app popup replaces the native dialog.
    // Detection, comparison and the once-per-day record above are
    // unchanged — main only hands the payload to the renderer now.
    pendingUpdatePc = typeof j.pc === "string" ? j.pc : "";
    pendingUpdateName = j.name || `v${latest}`;
    win.webContents.send("od:updateAvailable", {
      name: j.name || `v${latest}`,
      notes: typeof j.notes === "string" ? j.notes : "",
      current: `v${mine}`,
    });
    report("available");
  } catch {
    report("error");
    // offline or unreachable — stay silent (automatic check)
  }
}

// Manual "Check for Updates" from Settings: same detection as the
// automatic check, but it always runs and reports its result.
ipcMain.on("od:checkUpdate", () => { checkForUpdatePc(true); });

// ---- v56: the update popup's Download button downloads the Setup
// INSIDE the app. Until v55 it handed the Drive link to the browser
// and the user had to fetch and run the installer by hand; the user
// ordered that gone (2026-11-16): no Drive page, no browser, ever —
// a failed download surfaces as an error state in the popup with a
// Retry, never as a browser fallback.
//
// The version.json "pc" link is a PUBLIC Google Drive view link, and
// the resolution below is deliberately account-agnostic: a plain
// anonymous fetch — no sign-in, no cookies, nothing from anyone's
// Google account — so it works identically for every user.
//   /file/d/<id>/view → drive.usercontent.google.com/download?id=<id>&export=download&confirm=t
// Large Drive files can first answer with an HTML "can't scan this
// file" warning page carrying a one-time uuid; when the response is
// HTML we extract the warning form's real download URL and retry
// once with it. The payload is accepted only when it is a genuine
// PE executable — "MZ" header, non-HTML content type, and a byte
// count matching Content-Length when one was sent — so an error
// page can never be saved as the Setup .exe.
function driveDirectUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)google\.com$/.test(u.hostname) || u.hostname === "drive.usercontent.google.com") {
      const m = u.pathname.match(/\/file\/d\/([^/]+)/) || u.search.match(/[?&]id=([^&]+)/);
      if (m) {
        return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
      }
    }
  } catch {}
  return url;
}

function sendUpdateProgress(s) {
  if (win && !win.isDestroyed()) win.webContents.send("od:updateProgress", s);
}

let updateDlRunning = false;

// ---- v60: update-installer cleanup. Every in-app update downloads
// a ~116 MB Setup into userData/updates, and until now nothing ever
// deleted it — one stale installer piled up per update, forever.
// This sweep removes ONLY OurDrop-Setup-*.exe installers and their
// *.part leftovers inside that one folder. It runs at app startup
// and again right before a new update download begins. It does NOT
// try to remove the installer that was just launched in the same
// session: Windows locks a running installer, and this process quits
// right after launching it anyway — the next launch's startup sweep
// is the designed cleanup point for that file. The sweep never runs
// while a download is in progress, touches nothing outside the
// updates folder, and every failure is swallowed: cleanup must
// never surface an error to the user.
function cleanupUpdateInstallers() {
  if (updateDlRunning) return;
  try {
    const dir = path.join(app.getPath("userData"), "updates");
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // no updates folder yet — nothing to clean
    }
    for (const name of names) {
      if (!name.startsWith("OurDrop-Setup-")) continue;
      if (!/\.exe$/i.test(name) && !/\.part$/i.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
    }
  } catch {}
}

async function downloadPcUpdate() {
  if (updateDlRunning || !pendingUpdatePc) return;
  // Sweep stale installers from earlier updates before this download
  // adds another one (the guard inside keeps it out of any download
  // already in progress).
  cleanupUpdateInstallers();
  updateDlRunning = true;
  const ctrl = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    // A download that moves nothing for 60 s is dead — fail it so
    // the popup offers Retry instead of spinning forever.
    idleTimer = setTimeout(() => ctrl.abort(), 60000);
  };
  try {
    sendUpdateProgress({ percent: 0 });
    let url = driveDirectUrl(pendingUpdatePc);
    let res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    if (!res.ok) throw new Error("http " + res.status);
    let type = (res.headers.get("content-type") || "").toLowerCase();
    if (type.includes("text/html")) {
      // Drive's large-file warning page: its form carries the real
      // (uuid-bearing) download URL. Parse it out and retry once.
      const html = await res.text();
      const form = html.match(/<form[^>]+action="([^"]+)"/i);
      const uuid = html.match(/name="uuid"[^>]*value="([^"]+)"/i) || html.match(/[?&]uuid=([0-9a-fA-F-]{36})/);
      let retry = null;
      if (form) {
        retry = form[1].replace(/&amp;/g, "&");
        if (retry.startsWith("/")) retry = new URL(url).origin + retry;
        if (uuid && !/[?&]uuid=/.test(retry)) retry += (retry.includes("?") ? "&" : "?") + "uuid=" + uuid[1];
      } else if (uuid) {
        retry = url + (url.includes("?") ? "&" : "?") + "uuid=" + uuid[1];
      }
      if (!retry) throw new Error("drive-warning-unparsed");
      res = await fetch(retry, { redirect: "follow", signal: ctrl.signal });
      if (!res.ok) throw new Error("http " + res.status);
      type = (res.headers.get("content-type") || "").toLowerCase();
      if (type.includes("text/html")) throw new Error("drive-served-html");
    }
    const total = Number(res.headers.get("content-length") || 0);
    const dir = path.join(app.getPath("userData"), "updates");
    fs.mkdirSync(dir, { recursive: true });
    const safeName = String(pendingUpdateName || "latest").replace(/[^A-Za-z0-9._-]/g, "");
    const dest = path.join(dir, `OurDrop-Setup-${safeName}.exe`);
    const tmp = dest + ".part";
    const out = fs.createWriteStream(tmp);
    const reader = res.body.getReader();
    let received = 0;
    let lastSent = -1;
    armIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      received += value.length;
      out.write(Buffer.from(value));
      const pct = total > 0 ? Math.floor((received / total) * 100) : -1;
      if (pct !== lastSent) {
        lastSent = pct;
        sendUpdateProgress({ percent: pct });
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    clearTimeout(idleTimer);
    if (total > 0 && received !== total) throw new Error("short-download");
    // Genuine-Windows-executable check before anything is launched.
    const fd = fs.openSync(tmp, "r");
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head[0] !== 0x4d || head[1] !== 0x5a) throw new Error("not-an-exe");
    fs.renameSync(tmp, dest);
    console.log(`[update] downloaded ${dest} (${received} bytes) — launching installer`);
    sendUpdateProgress({ percent: 100 });
    // Hand over to the installer, then quit so it can replace the
    // app's files (it also closes a running copy itself, per v53).
    await shell.openPath(dest);
    setTimeout(() => app.quit(), 600);
  } catch (e) {
    clearTimeout(idleTimer);
    console.log("[update] in-app download failed:", e && e.message ? e.message : e);
    sendUpdateProgress({ error: true });
  } finally {
    updateDlRunning = false;
  }
}

ipcMain.on("od:updateAction", (_e, action) => {
  if (action === "download") downloadPcUpdate();
});

// About-section external links (social profiles, Telegram, project
// pages): only https URLs are opened, in the default browser.
ipcMain.on("od:openExternal", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
});

// ---- Single instance: a second launch must never spawn a second
// server, tray icon or window. It exits immediately and the running
// instance surfaces its window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    // A second autostart-style launch must not pop the window either;
    // a normal relaunch (shortcut, Start menu) surfaces it as always.
    if (Array.isArray(argv) && argv.includes("--hidden")) return;
    showMainWindow();
  });
  app.whenReady().then(boot);
}
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
app.on("activate", () => showMainWindow());
