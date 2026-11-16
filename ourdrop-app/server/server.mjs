// OurDrop Node server — HTTP API + chunked resumable uploads + WebSocket
// events + optional pairing approval + mDNS advertisement.
// Plain Node.js (bonjour-service is the only dependency, used for mDNS).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { attachWebSocket } from "./ws.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const PUBLIC = path.join(__dirname, "..", "public");
export const APP_NAME = "OurDrop";
export const DEFAULT_PORT = 8765;

// ---------- settings ----------
export function settingsPath(baseDir) {
  return path.join(baseDir, "ourdrop-settings.json");
}
export function loadSettings(baseDir) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(baseDir), "utf8"));
  } catch {
    return {};
  }
}
export function saveSettings(baseDir, s) {
  try {
    fs.writeFileSync(settingsPath(baseDir), JSON.stringify(s, null, 2));
  } catch {}
}

export function lanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function safeName(raw) {
  let n = decodeURIComponent(String(raw || "file")).replace(/\\/g, "/");
  n = n.split("/").pop().trim();
  if (!n || n === "." || n === "..") n = "file";
  return n;
}
function dedupe(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return p;
}
function sha256File(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(fp);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}
/** Move a file, transparently copying across volumes (a plain rename
 *  throws EXDEV when source and destination live on different drives
 *  — e.g. app data on C: and the storage folder on D:). */
async function moveFile(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (e) {
    if (!e || e.code !== "EXDEV") throw e;
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dest);
      rs.on("error", reject);
      ws.on("error", reject);
      ws.on("finish", resolve);
      rs.pipe(ws);
    });
    await fs.promises.unlink(src).catch(() => {});
  }
}
function moveFileSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (!e || e.code !== "EXDEV") throw e;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}
/** The user-facing message when a save into the storage folder
 *  fails. Permission errors on Windows usually mean Controlled
 *  Folder Access is blocking this (unsigned) app from a protected
 *  folder such as Pictures or Documents — say exactly what the user
 *  can do about it; the app itself cannot and must not bypass it. */
export const CFA_MESSAGE =
  "Windows blocked OurDrop from saving into this folder (Controlled Folder Access). " +
  "Allow OurDrop in Windows Security → Virus & threat protection → Ransomware protection → " +
  "“Allow an app through Controlled folder access”, or choose a different storage folder in Settings.";
export function saveError(res, sendJson, e) {
  const code = (e && e.code) || "";
  if (code === "EACCES" || code === "EPERM") {
    return sendJson(res, { error: CFA_MESSAGE, code }, 500);
  }
  return sendJson(res, { error: "Could not save the file (" + (code || "unknown error") + ").", code }, 500);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".apk": "application/vnd.android.package-archive",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
};

export function startServer({
  baseDir,
  dataDir = null,
  port = DEFAULT_PORT,
  onEvent = () => {},
  advertise = true,
  peerOpts = {},
  includeLocalPeers = false,
  rxStaleMs = 10000,
  rxTerminalMs = 600000,
  rxDropMs = 1800000,
  sessionTtlMs = 24 * 3600 * 1000,
}) {
  const UNRESPONSIVE_MS = peerOpts.unresponsiveMs ?? 6000;
  const GONE_MS = peerOpts.goneMs ?? 20000;
  // v48: a fresh identity for this server process. The phone compares
  // it across polls; a change means the PC app restarted, so any
  // download state tied to the old process (offers are in-memory) is
  // hopeless and gets purged instead of freezing on screen.
  const bootId = crypto.randomBytes(6).toString("hex");

  // ---- diagnostics log (for support, not shown in the UI) ----
  const logPath = path.join(baseDir, "ourdrop.log");
  const dlog = (line) => {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
      if (fs.statSync(logPath).size > 1000000) {
        fs.renameSync(logPath, logPath + ".old");
      }
    } catch {}
  };

  // ---- stable peer sessions ----
  // A device is ONE session, keyed by its persistent device id when it
  // sends one (falling back to IP). HTTP requests, WS hellos and WS
  // ping/pong activity all refresh lastSeen. A silent device first
  // becomes "unresponsive" (no notification), and only after the full
  // grace period is it declared gone — brief network stalls and phone
  // power-saving no longer cause disconnect/reconnect flapping.
  const peerByKey = new Map();
  const peerByIp = new Map();
  const peerById = new Map();
  const GENERIC_NAMES = new Set(["Android device", "Unknown device", ""]);
  const isLocalIp = (ip) => ip === "127.0.0.1" || ip === "::1";

  function notePeer(ip, opts = {}) {
    if (!ip) return null;
    if (isLocalIp(ip) && !includeLocalPeers) return null;
    const id = opts.id || null;
    const now = Date.now();
    let entry = null;
    if (id && peerById.has(id)) entry = peerByKey.get(peerById.get(id));
    if (!entry && peerByIp.has(ip)) entry = peerByKey.get(peerByIp.get(ip));
    if (!entry) {
      const key = id || ip;
      entry = {
        key,
        ids: new Set(id ? [id] : []),
        name: opts.name || "Android device",
        ip,
        firstSeen: now,
        lastSeen: now,
        state: "active",
        goneAt: 0,
      };
      peerByKey.set(key, entry);
      dlog(`peer-joined key=${key} name=${entry.name} ip=${ip} via=${opts.via || "http"}`);
      emit({ type: "peer-joined", key, id, ip, name: entry.name });
    }
    if (id) {
      entry.ids.add(id);
      peerById.set(id, entry.key);
    }
    if (entry.ip !== ip) {
      peerByIp.delete(entry.ip);
      entry.ip = ip;
    }
    peerByIp.set(ip, entry.key);
    if (opts.name && (GENERIC_NAMES.has(entry.name) || !GENERIC_NAMES.has(opts.name))) {
      entry.name = opts.name;
    }
    entry.lastSeen = now;
    if (entry.state === "unresponsive") {
      entry.state = "active";
      dlog(`peer-active key=${entry.key} name=${entry.name} ip=${ip}`);
      emit({ type: "peer-active", key: entry.key, ip, name: entry.name });
    }
    return entry;
  }

  // A PC-initiated send is only allowed while a real receiver session
  // is active. The phone's own uploads are never gated (it IS the peer).
  const hasActiveReceiver = () =>
    [...peerByKey.values()].some(
      (e) => e.state === "active" && (includeLocalPeers || !isLocalIp(e.ip))
    );
  // ---- phone receive-progress lifecycle (v48) ----
  // Reports carry a per-item status and are timestamped here. An item
  // whose reports stop (PC closed mid-download, Wi-Fi drop) flips to
  // "interrupted" after rxStaleMs instead of posing as a live download
  // forever; terminal reports (failed/cancelled) linger only for a
  // grace period; "done" clears at once and completes the delivery.
  const rxByIp = new Map(); // ip -> Map(name -> {name, received, total, status, at})
  const rxSig = new Map(); // ip -> last broadcast snapshot signature
  const rxCancels = new Map(); // ip -> Set(name) the user cancelled on the PC
  const rxSnapshot = (ip) => {
    const m = rxByIp.get(ip);
    if (!m) return [];
    const now = Date.now();
    return [...m.values()].map((e) => ({
      name: e.name,
      received: e.received,
      total: e.total,
      status:
        e.status === "downloading" || e.status === "paused"
          ? now - e.at > rxStaleMs
            ? "interrupted"
            : e.status
          : e.status,
    }));
  };
  const rxBroadcast = (ip) => {
    const items = rxSnapshot(ip);
    rxSig.set(ip, JSON.stringify(items));
    emit({ type: "rx-progress", ip, items });
  };

  const uploads = new Map(); // id -> { name, size, partPath, ip, origin, updatedAt }

  // ---- incoming batch tracking (phone -> PC) ----
  // Powers the PC UI's single consolidated "Receiving X of Y files"
  // progress. A batch stays open while uploads are active and for a
  // few seconds after the last one finishes, so a multi-file send is
  // reported as ONE batch, never as per-file popups.
  let incomingBatch = null;
  let incomingTimer = null;
  let lastIncomingSent = 0;
  function incomingSnapshot() {
    if (!incomingBatch) return null;
    let activeBytes = 0;
    let currentName = "";
    for (const a of incomingBatch.active.values()) {
      activeBytes += a.received;
      currentName = a.name;
    }
    return {
      type: "incoming",
      total: incomingBatch.total,
      completed: incomingBatch.completed,
      active: incomingBatch.active.size,
      currentName,
      bytesTotal: incomingBatch.bytesTotal,
      bytesReceived: incomingBatch.bytesDone + activeBytes,
    };
  }
  function sendIncoming(force = false) {
    const now = Date.now();
    if (!force && now - lastIncomingSent < 400) return;
    lastIncomingSent = now;
    const snap = incomingSnapshot();
    if (snap) emit(snap);
  }
  function maybeEndBatch() {
    if (!incomingBatch || incomingBatch.active.size > 0) return;
    if (incomingTimer) clearTimeout(incomingTimer);
    incomingTimer = setTimeout(() => {
      incomingTimer = null;
      if (incomingBatch && incomingBatch.active.size === 0) {
        if (incomingBatch.completed > 0) {
          emit({ type: "incoming-done", count: incomingBatch.completed, bytes: incomingBatch.bytesDone });
        }
        incomingBatch = null;
      }
    }, 4000);
  }
  function batchAdd(id, name, size) {
    if (!incomingBatch) {
      incomingBatch = { total: 0, completed: 0, bytesTotal: 0, bytesDone: 0, active: new Map() };
    }
    if (incomingTimer) {
      clearTimeout(incomingTimer);
      incomingTimer = null;
    }
    incomingBatch.total++;
    incomingBatch.bytesTotal += size;
    incomingBatch.active.set(id, { name, size, received: 0 });
    sendIncoming(true);
  }
  function batchProgress(id, received) {
    const a = incomingBatch?.active.get(id);
    if (a) {
      a.received = received;
      sendIncoming();
    }
  }
  function batchComplete(id, size) {
    if (!incomingBatch) return;
    incomingBatch.active.delete(id);
    incomingBatch.completed++;
    incomingBatch.bytesDone += size;
    sendIncoming(true);
    maybeEndBatch();
  }
  function batchRemove(id) {
    if (!incomingBatch) return;
    const a = incomingBatch.active.get(id);
    if (a) {
      incomingBatch.active.delete(id);
      incomingBatch.total--;
      incomingBatch.bytesTotal -= a.size;
      sendIncoming(true);
    }
    maybeEndBatch();
  }

  let ws = null;
  let bonjour = null;
  let mdnsService = null;
  let lastLanIp = lanIp();

  const emit = (evt) => {
    try {
      onEvent(evt);
    } catch {}
    if (ws) ws.broadcast(evt);
  };

  const getSharedDir = () => {
    const s = loadSettings(baseDir);
    return s.shared_dir || path.join(baseDir, "OurDrop Files");
  };
  // Stable identity of the CURRENT storage folder, sent to the phone
  // with every /api/files response (x-od-folder header). Changing the
  // storage location changes this id, which tells the phone: "the
  // files you are about to see were already in that folder — they are
  // NOT new sends" (it baselines them instead of auto-downloading).
  const folderId = () =>
    crypto.createHash("sha256").update(path.resolve(getSharedDir())).digest("hex").slice(0, 16);
  // Windows Controlled Folder Access protects these profile folders
  // for untrusted apps: receiving into one can be blocked until the
  // user allows OurDrop in Windows Security. Surfaced via /api/info
  // so Settings can warn before a transfer fails.
  const isProtectedFolder = (dir) => {
    try {
      const home = os.homedir().toLowerCase();
      const resolved = path.resolve(dir).toLowerCase();
      return ["pictures", "documents", "videos", "music", "desktop"].some((n) => {
        const base = path.join(home, n);
        return resolved === base || resolved.startsWith(base + path.sep);
      });
    } catch {
      return false;
    }
  };
  // The shared folder is created LAZILY, only when a file is actually
  // RECEIVED into it — never at startup and never for outgoing sends,
  // so sending PC -> phone leaves no folder and no copy behind.
  const ensureSharedDir = () => {
    const dir = getSharedDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  // Internal app data (upload partials, deleted-file trash, origin
  // maps) lives in the application's own data directory — NEVER in
  // the user's storage folder, which holds ONLY files the user
  // actually received. Electron passes its userData path; standalone
  // runs use a folder beside the app.
  const appDataDir = () => {
    const d = dataDir || path.join(baseDir, ".ourdrop-data");
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const trashDir = () => {
    const d = path.join(appDataDir(), "trash");
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const uploadsDir = () => {
    const d = path.join(appDataDir(), "uploads");
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  // One-time migration: older versions kept .uploads/.trash inside
  // the storage folder. Move their contents into the app data
  // directory (per storage folder, once) and remove the emptied
  // legacy folders, so user folders hold only user files again.
  const migratedFolders = new Set();
  const migrateLegacy = () => {
    try {
      const shared = getSharedDir();
      const key = path.resolve(shared);
      if (migratedFolders.has(key)) return;
      migratedFolders.add(key);
      for (const [name, dest] of [
        [".uploads", uploadsDir()],
        [".trash", trashDir()],
      ]) {
        const legacy = path.join(shared, name);
        if (!fs.existsSync(legacy)) continue;
        for (const n of fs.readdirSync(legacy)) {
          try {
            moveFileSync(path.join(legacy, n), path.join(dest, n));
          } catch {}
        }
        try {
          fs.rmdirSync(legacy);
        } catch {}
      }
    } catch {}
  };
  migrateLegacy();
  // ----- resumable upload sessions, persisted across restarts (v48) --
  // The .part file is the ground truth for bytes received; this index
  // carries only the metadata (name/size/owner) needed to revive a
  // session after the server restarts, so an interrupted phone -> PC
  // upload resumes from its real offset instead of dying on a
  // forgotten session id. Sessions idle past sessionTtlMs are expired
  // by the sweep (partial file deleted) so stale state can never
  // squat on disk or shadow a future upload of the same name.
  const sessionsPath = () => path.join(uploadsDir(), "sessions.json");
  const saveSessions = () => {
    try {
      const obj = {};
      for (const [id, up] of uploads) {
        obj[id] = { name: up.name, size: up.size, ip: up.ip, origin: up.origin, updatedAt: up.updatedAt || 0 };
      }
      fs.writeFileSync(sessionsPath(), JSON.stringify(obj));
    } catch {}
  };
  const loadSessions = () => {
    try {
      const obj = JSON.parse(fs.readFileSync(sessionsPath(), "utf8"));
      for (const [id, s] of Object.entries(obj || {})) {
        if (!/^[0-9a-f]{16}$/.test(id)) continue;
        const partPath = path.join(uploadsDir(), id + ".part");
        if (!fs.existsSync(partPath)) continue;
        uploads.set(id, {
          name: s.name,
          size: s.size,
          partPath,
          ip: s.ip,
          origin: s.origin,
          updatedAt: s.updatedAt || 0,
        });
      }
    } catch {}
  };
  loadSessions();
  // ----- file origins -------------------------------------------------
  // Which device uploaded each file in the CURRENT storage folder.
  // One map per folder (keyed by the folder id), stored in the app
  // data directory — never inside the folder itself. A sender must
  // never auto-receive its own uploads back — the phone's
  // auto-receive compares the origin against its own device id and
  // skips matches.
  const originsPath = () => {
    const p = path.join(appDataDir(), "origins-" + folderId() + ".json");
    try {
      const legacy = path.join(getSharedDir(), ".ourdrop-origins.json");
      if (fs.existsSync(legacy)) {
        if (!fs.existsSync(p)) moveFileSync(legacy, p);
        else fs.unlinkSync(legacy);
      }
    } catch {}
    return p;
  };
  const loadOrigins = () => {
    try {
      return JSON.parse(fs.readFileSync(originsPath(), "utf8")) || {};
    } catch {
      return {};
    }
  };
  const saveOrigins = (map) => {
    try {
      fs.writeFileSync(originsPath(), JSON.stringify(map));
    } catch {}
  };
  const recordOrigin = (name, originId) => {
    if (!name || !originId) return;
    const map = loadOrigins();
    map[name] = originId;
    saveOrigins(map);
  };
  const forgetOrigin = (name) => {
    const map = loadOrigins();
    if (name in map) {
      delete map[name];
      saveOrigins(map);
    }
  };

  // ----- outbox: PC -> phone offers WITHOUT copying -------------------
  // Sending from this PC registers the ORIGINAL file path; the phone
  // downloads the file straight from its real location. Nothing is
  // copied into the shared folder for outgoing files — that folder
  // only ever holds files this PC has RECEIVED.
  const outbox = new Map(); // name -> { path, size, mtime, origin }

  const listFiles = () => {
    migrateLegacy(); // a storage-folder switch may reveal legacy internal dirs
    const origins = loadOrigins();
    const dir = getSharedDir();
    const shared = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .filter((n) => !n.startsWith("."))
      .map((n) => {
        const p = path.join(dir, n);
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) return null;
          return { name: n, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), origin: origins[n] || null, outbox: false };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const sharedNames = new Set(shared.map((f) => f.name));
    const offered = [...outbox.entries()]
      .filter(([n]) => !sharedNames.has(n))
      .map(([n, o]) => ({ name: n, size: o.size, mtime: o.mtime, origin: o.origin, outbox: true, offeredAt: o.offeredAt || 0 }));
    return [...shared, ...offered].sort((a, b) => b.mtime - a.mtime);
  };

  // ---------- pairing approval ----------
  const requireApproval = () => loadSettings(baseDir).require_approval === true;
  const approvedIps = () => loadSettings(baseDir).approved_ips || [];
  const isApproved = (ip) =>
    ip === "127.0.0.1" || ip === "::1" || !requireApproval() || approvedIps().includes(ip);
  const noteApprovalNeeded = (ip) => {
    if (ip && ip !== "127.0.0.1" && requireApproval() && !approvedIps().includes(ip)) {
      const pk = peerByIp.get(ip);
      emit({ type: "approval-needed", ip, name: (pk && peerByKey.get(pk)?.name) || "Unknown device" });
    }
  };

  const sendJson = (res, obj, code = 200) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
  };
  const sendFile = (res, filePath) => {
    try {
      const body = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Content-Length": body.length,
      });
      res.end(body);
    } catch {
      sendJson(res, { error: "not found" }, 404);
    }
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  const server = http.createServer(async (req, res) => {
    const ip = (req.socket.remoteAddress || "").replace("::ffff:", "");
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const isLocal = ip === "127.0.0.1" || ip === "::1";
    if (ip && p.startsWith("/api/")) {
      notePeer(ip, {
        id: req.headers["x-od-id"] || null,
        name: req.headers["x-od-device"] || null,
        via: "http",
      });
    }

    try {
      if (p === "/api/info") {
        const s = loadSettings(baseDir);
        return sendJson(res, {
          app: APP_NAME,
          device: os.hostname(),
          ip: lanIp(),
          folder: getSharedDir(),
          port: server.address().port,
          approvalRequired: requireApproval(),
          youApproved: isApproved(ip),
          // The SHARED display name (one name for the paired PC +
          // phone, stored on the PC). `device` above stays the real
          // Windows hostname — the two are kept separate on purpose.
          displayName: s.display_name || "",
          nameTs: Number(s.display_name_ts) || 0,
          protectedFolder: isProtectedFolder(getSharedDir()),
          bootId,
        });
      }
      // Shared display-name sync: either paired device may set the
      // name; the server accepts only the LATEST update (timestamp
      // rule — on a tie the later arrival wins), persists it, and
      // broadcasts it so both UIs update immediately.
      if (p === "/api/name" && req.method === "POST") {
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const nm = String(j.name || "").trim().slice(0, 40);
        const ts = Number(j.ts) || 0;
        const s = loadSettings(baseDir);
        const curTs = Number(s.display_name_ts) || 0;
        if (nm && ts >= curTs) {
          s.display_name = nm;
          s.display_name_ts = ts;
          saveSettings(baseDir, s);
          emit({ type: "name-changed", name: nm, ts });
          return sendJson(res, { ok: true, name: nm, ts });
        }
        // Stale or empty update: reject and hand back the current
        // winner so the caller converges to it.
        return sendJson(res, { ok: false, name: s.display_name || "", ts: curTs });
      }
      if (p === "/api/rx-progress" && req.method === "POST") {
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const items = Array.isArray(j.items) ? j.items.slice(0, 20) : [];
        let m = rxByIp.get(ip);
        if (!m) {
          m = new Map();
          rxByIp.set(ip, m);
        }
        const now = Date.now();
        for (const it of items) {
          if (!it || !it.name) continue;
          const name = safeName(it.name);
          const status = String(it.status || "downloading");
          if (status === "done") {
            m.delete(name);
            // A completed phone download of an offered file IS the
            // delivery — this also covers range-based downloads,
            // whose completion the byte-counting path cannot see.
            if (outbox.has(name)) {
              outbox.delete(name);
              emit({ type: "outbox-delivered", name });
              emit({ type: "files-changed" });
            }
            continue;
          }
          if (status === "cancelled") {
            // The phone acted on a cancel: clear everything about it.
            m.delete(name);
            const canc = rxCancels.get(ip);
            if (canc) canc.delete(name);
            continue;
          }
          m.set(name, {
            name,
            received: Number(it.received) || 0,
            total: Number(it.total) || 0,
            status: ["downloading", "paused", "failed"].includes(status) ? status : "downloading",
            at: now,
          });
        }
        rxBroadcast(ip);
        return sendJson(res, { ok: true });
      }
      // The PC user cancels a phone-side download from the transfer
      // card: flag it for the phone (delivered on its next /api/files
      // poll via the x-od-cancel header), stop offering the file, and
      // show the card as cancelled right away.
      if (p === "/api/rx-cancel" && req.method === "POST") {
        if (!isLocal) return sendJson(res, { error: "local only" }, 403);
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const name = safeName(j.name);
        for (const [rip, m] of rxByIp) {
          if (m.has(name)) {
            let canc = rxCancels.get(rip);
            if (!canc) {
              canc = new Set();
              rxCancels.set(rip, canc);
            }
            canc.add(name);
            const e = m.get(name);
            m.set(name, { ...e, status: "cancelled", at: Date.now() });
            rxBroadcast(rip);
          }
        }
        if (outbox.delete(name)) emit({ type: "files-changed" });
        return sendJson(res, { ok: true });
      }
      if (p === "/api/peers") {
        const now = Date.now();
        const list = [...peerByKey.values()]
          .filter((e) => includeLocalPeers || !isLocalIp(e.ip))
          .map((e) => ({
            ip: e.ip,
            id: [...e.ids][0] || null,
            name: e.name || "Android device",
            state: e.state,
            ago: Math.round((now - e.lastSeen) / 1000),
          }));
        return sendJson(res, list);
      }
      if (p === "/api/files" && req.method === "GET") {
        res.setHeader("x-od-folder", folderId());
        res.setHeader("x-od-boot", bootId);
        const canc = rxCancels.get(ip);
        if (canc && canc.size) {
          res.setHeader("x-od-cancel", [...canc].map((n) => encodeURIComponent(n)).join(","));
        }
        return sendJson(res, listFiles());
      }
      if (p === "/api/hash") {
        const name = safeName(u.searchParams.get("name"));
        const fp = path.join(getSharedDir(), name);
        if (!fs.existsSync(fp)) return sendJson(res, { error: "not found" }, 404);
        return sendJson(res, { name, sha256: await sha256File(fp) });
      }

      // ----- pairing approval management (PC-local only) -----
      if (p === "/api/approvals" && req.method === "GET") {
        if (!isLocal) return sendJson(res, { error: "local only" }, 403);
        const now = Date.now();
        const pending = [...peerByKey.values()]
          .filter((e) => !isLocalIp(e.ip) && now - e.lastSeen < GONE_MS && !approvedIps().includes(e.ip))
          .map((e) => ({ ip: e.ip, name: e.name || "Unknown device" }));
        return sendJson(res, { required: requireApproval(), pending, approved: approvedIps() });
      }
      if (p === "/api/approve" && req.method === "POST") {
        if (!isLocal) return sendJson(res, { error: "local only" }, 403);
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const s = loadSettings(baseDir);
        s.approved_ips = [...new Set([...(s.approved_ips || []), j.ip])];
        saveSettings(baseDir, s);
        emit({ type: "peer-approved", ip: j.ip });
        return sendJson(res, { ok: true });
      }
      if (p === "/api/settings" && req.method === "POST") {
        if (!isLocal) return sendJson(res, { error: "local only" }, 403);
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const s = loadSettings(baseDir);
        if (typeof j.require_approval === "boolean") s.require_approval = j.require_approval;
        saveSettings(baseDir, s);
        return sendJson(res, { ok: true });
      }

      // ----- outbox: offer local files for the phone to download -----
      // Registration only (localhost): the file stays exactly where it
      // is; /api/download streams it from its original path. Same
      // receiver gate as uploads — offering IS sending.
      if (p === "/api/outbox" && req.method === "POST") {
        if (!isLocal) return sendJson(res, { error: "local only" }, 403);
        if (!hasActiveReceiver()) {
          return sendJson(res, { error: "Connect your mobile device first." }, 409);
        }
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const items = Array.isArray(j.items) ? j.items.slice(0, 200) : [];
        const results = [];
        for (const it of items) {
          const name = safeName(it && it.name);
          try {
            const srcPath = String((it && it.path) || "");
            const st = fs.statSync(srcPath);
            if (!st.isFile()) throw new Error("not a file");
            if (fs.existsSync(path.join(getSharedDir(), name))) {
              throw new Error("A file with this name is already in the shared folder");
            }
            const existing = outbox.get(name);
            if (existing && existing.path !== srcPath) {
              throw new Error("A different file with this name is already being sent");
            }
            outbox.set(name, {
              path: srcPath,
              size: st.size,
              mtime: Math.floor(st.mtimeMs / 1000),
              origin: req.headers["x-od-id"] || null,
              // v48: every (re-)registration is a NEW offer. The phone
              // keys its "already handled" marks to this stamp, so
              // pressing Send again after an interruption genuinely
              // retries — the file's own mtime no longer vetoes it.
              offeredAt: Date.now(),
            });
            results.push({ name, ok: true, size: st.size });
          } catch (e) {
            results.push({ name, ok: false, error: String((e && e.message) || e) });
          }
        }
        if (results.some((r) => r.ok)) emit({ type: "files-changed" });
        return sendJson(res, { results });
      }
      if (p === "/api/outbox" && req.method === "DELETE") {
        if (!isLocal) return sendJson(res, { error: "local only" }, 403);
        const name = safeName(u.searchParams.get("name"));
        const had = outbox.delete(name);
        if (had) emit({ type: "files-changed" });
        return sendJson(res, { ok: true, removed: had });
      }

      // ----- classic raw upload (kept for compatibility) -----
      if (p === "/api/upload" && req.method === "POST") {
        if (isLocalIp(ip) && !hasActiveReceiver()) {
          return sendJson(res, { error: "Connect your mobile device first." }, 409);
        }
        if (!isApproved(ip)) {
          noteApprovalNeeded(ip);
          return sendJson(res, { error: "approval_required" }, 403);
        }
        const name = safeName(u.searchParams.get("name"));
        ensureSharedDir();
        const dest = dedupe(getSharedDir(), name);
        const out = fs.createWriteStream(dest);
        const legacyOrigin = req.headers["x-od-id"] || null;
        const legacyId = "legacy-" + crypto.randomBytes(6).toString("hex");
        batchAdd(legacyId, name, Number(req.headers["content-length"]) || 0);
        let size = 0;
        req.on("data", (c) => {
          size += c.length;
          batchProgress(legacyId, size);
        });
        req.pipe(out);
        out.on("finish", async () => {
          const sha256 = await sha256File(dest).catch(() => null);
          recordOrigin(path.basename(dest), legacyOrigin);
          emit({ type: "received", name: path.basename(dest), size, ip, sha256 });
          emit({ type: "files-changed" });
          batchComplete(legacyId, size);
          sendJson(res, { ok: true, name: path.basename(dest), size, sha256 });
        });
        out.on("error", (e) => {
          batchRemove(legacyId);
          saveError(res, sendJson, e);
        });
        return;
      }

      // ----- chunked resumable uploads -----
      // Resume lookup (v48): a sender whose session id was lost (its
      // app restarted, or this server did and it kept the id but we
      // answer status by id too) finds its surviving session by file
      // identity and continues from the .part file's real size.
      if (p === "/api/upload/resume" && req.method === "POST") {
        if (!isApproved(ip)) {
          noteApprovalNeeded(ip);
          return sendJson(res, { error: "approval_required" }, 403);
        }
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const nm = safeName(j.name);
        const sz = Number(j.size) || 0;
        for (const [id, up] of uploads) {
          if (up.name === nm && up.size === sz) {
            const received = fs.existsSync(up.partPath) ? fs.statSync(up.partPath).size : 0;
            return sendJson(res, { id, received, size: up.size });
          }
        }
        return sendJson(res, { error: "no session" }, 404);
      }
      if (p === "/api/upload/init" && req.method === "POST") {
        if (isLocalIp(ip) && !hasActiveReceiver()) {
          return sendJson(res, { error: "Connect your mobile device first." }, 409);
        }
        if (!isApproved(ip)) {
          noteApprovalNeeded(ip);
          return sendJson(res, { error: "approval_required" }, 403);
        }
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const id = crypto.randomBytes(8).toString("hex");
        const partPath = path.join(uploadsDir(), id + ".part");
        try {
          fs.writeFileSync(partPath, "");
        } catch (e) {
          return saveError(res, sendJson, e);
        }
        uploads.set(id, { name: safeName(j.name), size: Number(j.size) || 0, partPath, ip, origin: req.headers["x-od-id"] || null, updatedAt: Date.now() });
        saveSessions();
        batchAdd(id, safeName(j.name), Number(j.size) || 0);
        return sendJson(res, { id, received: 0 });
      }
      if (p === "/api/upload/status" && req.method === "GET") {
        const up = uploads.get(u.searchParams.get("id"));
        if (!up) return sendJson(res, { error: "unknown upload" }, 404);
        const received = fs.existsSync(up.partPath) ? fs.statSync(up.partPath).size : 0;
        return sendJson(res, { id: u.searchParams.get("id"), received, size: up.size });
      }
      if (p === "/api/upload/chunk" && req.method === "POST") {
        const id = u.searchParams.get("id");
        const up = uploads.get(id);
        if (!up) return sendJson(res, { error: "unknown upload" }, 404);
        const offset = Number(u.searchParams.get("offset") || 0);
        let partSize = 0;
        try {
          partSize = fs.statSync(up.partPath).size;
        } catch {}
        if (offset > partSize) {
          // A gap would silently corrupt the file: refuse and tell
          // the sender where the server actually is, so it resumes
          // from the true offset instead of failing the upload.
          return sendJson(res, { error: "offset-mismatch", received: partSize }, 409);
        }
        // Stream the chunk straight to its position on disk — the
        // whole chunk is never buffered in memory (v48), and the
        // write side applies natural backpressure to the socket.
        const ws = fs.createWriteStream(up.partPath, { flags: "r+", start: offset });
        try {
          await new Promise((resolve, reject) => {
            let settled = false;
            const ok = () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };
            const bad = (e) => {
              if (!settled) {
                settled = true;
                try {
                  ws.destroy();
                } catch {}
                reject(e);
              }
            };
            ws.on("error", bad);
            ws.on("finish", ok);
            req.on("error", bad);
            res.on("close", () => bad(new Error("client gone")));
            req.pipe(ws);
          });
        } catch (e) {
          if (res.destroyed) return;
          return saveError(res, sendJson, e);
        }
        let received = 0;
        try {
          received = fs.statSync(up.partPath).size;
        } catch {}
        up.updatedAt = Date.now();
        batchProgress(id, received);
        return sendJson(res, { received });
      }
      if (p === "/api/upload/finalize" && req.method === "POST") {
        const j = JSON.parse((await readBody(req)).toString() || "{}");
        const up = uploads.get(j.id);
        if (!up) return sendJson(res, { error: "unknown upload" }, 404);
        // Every failure below is ANSWERED, never thrown: an unanswered
        // finalize leaves the sender spinning and the session stuck.
        // On a save failure the session and its partial file are kept,
        // so the user can fix the problem (e.g. allow the app in
        // Windows Security) and simply retry.
        let received;
        try {
          received = fs.statSync(up.partPath).size;
        } catch (e) {
          return saveError(res, sendJson, e);
        }
        if (received !== up.size) {
          return sendJson(res, { error: "incomplete", received, size: up.size }, 400);
        }
        try {
          ensureSharedDir();
          // v49: a re-send of the SAME file (its earlier copy already
          // completed here — e.g. the first finalize's response was
          // lost to an interruption and the sender sent it again) must
          // end as exactly ONE file with the original name, never a
          // "name (1)" twin. Identity is strict: same name AND same
          // size AND same SHA-256. A genuinely different file that
          // merely shares the name still dedupes below, untouched.
          const partSha = await sha256File(up.partPath).catch(() => null);
          const samePath = path.join(getSharedDir(), up.name);
          let identical = false;
          if (partSha && fs.existsSync(samePath) && fs.statSync(samePath).isFile() && fs.statSync(samePath).size === up.size) {
            identical = (await sha256File(samePath).catch(() => null)) === partSha;
          }
          let dest;
          if (identical) {
            dest = samePath;
            try {
              fs.unlinkSync(up.partPath); // supersede: the copy here IS this file
            } catch {}
          } else {
            dest = dedupe(getSharedDir(), up.name);
            await moveFile(up.partPath, dest); // rename, or copy across volumes
          }
          uploads.delete(j.id);
          saveSessions();
          const sha256 = partSha || (await sha256File(dest).catch(() => null));
          const finalName = path.basename(dest);
          recordOrigin(finalName, up.origin);
          emit({ type: "received", name: finalName, size: up.size, ip: up.ip, sha256 });
          emit({ type: "files-changed" });
          batchComplete(j.id, up.size);
          return sendJson(res, { ok: true, name: finalName, size: up.size, sha256 });
        } catch (e) {
          return saveError(res, sendJson, e);
        }
      }
      if (p === "/api/upload" && req.method === "DELETE") {
        const up = uploads.get(u.searchParams.get("id"));
        if (up) {
          try {
            fs.unlinkSync(up.partPath);
          } catch {}
          uploads.delete(u.searchParams.get("id"));
          saveSessions();
          batchRemove(u.searchParams.get("id"));
        }
        return sendJson(res, { ok: true });
      }

      if (p === "/api/delete" && req.method === "DELETE") {
        const name = safeName(u.searchParams.get("name"));
        const src = path.join(getSharedDir(), name);
        if (fs.existsSync(src)) {
          try {
            moveFileSync(src, dedupe(trashDir(), name));
          } catch (e) {
            return saveError(res, sendJson, e);
          }
          forgetOrigin(name);
          emit({ type: "files-changed" });
          return sendJson(res, { ok: true });
        }
        // An outgoing offer is withdrawn — the original file is NEVER
        // touched; it simply stops being offered for download.
        if (outbox.delete(name)) {
          emit({ type: "files-changed" });
          return sendJson(res, { ok: true, unoffered: true });
        }
        return sendJson(res, { error: "not found" }, 404);
      }
      if (p === "/api/files" && req.method === "DELETE") {
        // Delete All: move every shared file to .trash (same recoverable
        // semantics as single delete). Only top-level files inside the
        // shared folder are touched — never directories, never anything
        // outside it, and in-progress .part uploads live in .uploads.
        let deleted = 0;
        let failed = 0;
        if (fs.existsSync(getSharedDir())) {
          for (const n of fs.readdirSync(getSharedDir())) {
            if (n.startsWith(".")) continue; // internal state (.ourdrop-origins.json) is never user data
            const fp = path.join(getSharedDir(), n);
            try {
              if (!fs.statSync(fp).isFile()) continue;
              moveFileSync(fp, dedupe(trashDir(), n));
              deleted++;
            } catch {
              failed++;
            }
          }
        }
        if (deleted) saveOrigins({});
        // A remote caller's Files list also contains outgoing offers;
        // clearing it there withdraws the offers (originals untouched).
        // The PC's own Delete All never withdraws its outgoing offers.
        let unoffered = 0;
        if (!isLocal && outbox.size) {
          unoffered = outbox.size;
          outbox.clear();
        }
        if (deleted || unoffered) emit({ type: "files-changed" });
        dlog(`delete-all deleted=${deleted} failed=${failed} unoffered=${unoffered} by=${ip}`);
        return sendJson(res, { ok: true, deleted, failed, unoffered });
      }
      if (p.startsWith("/api/download/")) {
        if (!isApproved(ip)) {
          noteApprovalNeeded(ip);
          return sendJson(res, { error: "approval_required" }, 403);
        }
        const name = safeName(p.slice("/api/download/".length));
        let fp = path.join(getSharedDir(), name);
        const offer = outbox.get(name);
        if (!fs.existsSync(fp)) {
          // Outgoing offer: stream from the file's original location.
          if (offer && fs.existsSync(offer.path)) fp = offer.path;
          else return sendJson(res, { error: "not found" }, 404);
        }
        const fst = fs.statSync(fp);
        const size = fst.size;
        // A stable validator for THIS version of the file: a resumable
        // downloader (Android DownloadManager) can tell the file did
        // not change under it, and an If-Range that no longer matches
        // gets a fresh full download instead of corrupt spliced bytes.
        const etag = `"${size}-${Math.floor(fst.mtimeMs)}"`;
        let start = 0,
          end = size - 1,
          code = 200;
        const range = req.headers.range;
        const ifRange = req.headers["if-range"];
        if (range && range.startsWith("bytes=") && (!ifRange || ifRange === etag)) {
          const [s, e] = range.slice(6).split("-", 2);
          start = s ? parseInt(s) : 0;
          end = e ? Math.min(parseInt(e), size - 1) : size - 1;
          code = 206;
        }
        const headers = {
          "Content-Type": MIME[path.extname(name).toLowerCase()] || "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          ETag: etag,
          "Last-Modified": fst.mtime.toUTCString(),
        };
        if (code === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        res.writeHead(code, headers);
        // 1 MB read chunks (up from the 64 KB default): far fewer
        // syscalls on large files; pipe() still applies backpressure.
        const stream = fs.createReadStream(fp, { start, end, highWaterMark: 1024 * 1024 });
        if (offer && code === 200) {
          // A complete, uncut download of an offered file = delivered:
          // withdraw the offer and tell every client.
          let gotBytes = 0;
          let closedEarly = false;
          stream.on("data", (c) => (gotBytes += c.length));
          res.on("close", () => {
            if (!res.writableFinished) closedEarly = true;
          });
          res.on("finish", () => {
            if (!closedEarly && gotBytes >= size && outbox.get(name) === offer) {
              outbox.delete(name);
              emit({ type: "outbox-delivered", name });
              emit({ type: "files-changed" });
            }
          });
        }
        stream.pipe(res);
        return;
      }
      if (p === "/dev-photo.jpg") return sendFile(res, path.join(PUBLIC, "dev-photo.jpg"));
      if (p === "/dev-photo-2.jpg") return sendFile(res, path.join(PUBLIC, "dev-photo-2.jpg"));
      if (p === "/manifest.webmanifest" || p === "/manifest.json") {
        res.writeHead(200, { "Content-Type": "application/manifest+json" });
        return res.end(
          JSON.stringify({
            name: "OurDrop",
            short_name: "OurDrop",
            start_url: "/",
            display: "standalone",
            background_color: "#0B1526",
            theme_color: "#2F7BFF",
            icons: [
              { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
              { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
            ],
          })
        );
      }
      const rel = p === "/" ? "index.html" : p.slice(1);
      const fp = path.join(DIST, rel);
      if (fp.startsWith(DIST) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        return sendFile(res, fp);
      }
      if (p === "/icon-192.png" || p === "/icon-512.png") {
        return sendFile(res, path.join(PUBLIC, p.slice(1)));
      }
      return sendFile(res, path.join(DIST, "index.html"));
    } catch (e) {
      return sendJson(res, { error: String(e && e.message || e) }, 500);
    }
  });

  // Peer state machine: active -> unresponsive (grace) -> gone.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const entry of [...peerByKey.values()]) {
      const silent = now - entry.lastSeen;
      if (entry.state === "active" && silent > UNRESPONSIVE_MS) {
        entry.state = "unresponsive";
        dlog(`peer-unresponsive key=${entry.key} name=${entry.name} ip=${entry.ip} silentMs=${silent}`);
        emit({ type: "peer-unresponsive", key: entry.key, ip: entry.ip, name: entry.name, silentMs: silent });
      }
      if (silent > GONE_MS) {
        peerByKey.delete(entry.key);
        if (peerByIp.get(entry.ip) === entry.key) peerByIp.delete(entry.ip);
        for (const id of entry.ids) peerById.delete(id);
        dlog(`peer-left key=${entry.key} name=${entry.name} ip=${entry.ip} silentMs=${silent}`);
        emit({ type: "peer-left", key: entry.key, ip: entry.ip, name: entry.name, silentMs: silent });
      }
    }
    // v48: receive-progress lifecycle. Entries whose reports stopped
    // flip to "interrupted" in the snapshot by themselves (see
    // rxSnapshot); here we only broadcast those flips and drop state
    // that can never move again — terminal entries after a grace
    // period, anything once its phone has been gone a while, and
    // ancient entries unconditionally. A transfer card must never
    // outlive its transfer.
    for (const [ip, m] of [...rxByIp]) {
      let dropped = false;
      for (const [name, e] of [...m]) {
        const age = now - e.at;
        const terminal = e.status === "failed" || e.status === "cancelled";
        if ((terminal && age > rxTerminalMs) || age > rxDropMs || (!peerByIp.has(ip) && age > 60000)) {
          m.delete(name);
          dropped = true;
        }
      }
      if (!m.size) {
        rxByIp.delete(ip);
        rxSig.delete(ip);
        if (dropped) emit({ type: "rx-progress", ip, items: [] });
      } else {
        const sig = JSON.stringify(rxSnapshot(ip));
        if (sig !== rxSig.get(ip)) {
          rxSig.set(ip, sig);
          emit({ type: "rx-progress", ip, items: rxSnapshot(ip) });
        }
      }
    }
    // v48: expire resumable-upload sessions idle past the TTL — the
    // partial file is deleted and the batch card released, so stale
    // sessions cannot pile up or block a future same-name upload.
    for (const [id, up] of [...uploads]) {
      if (up.updatedAt && now - up.updatedAt > sessionTtlMs) {
        try {
          fs.unlinkSync(up.partPath);
        } catch {}
        uploads.delete(id);
        batchRemove(id);
        saveSessions();
        dlog(`upload-expired id=${id} name=${up.name}`);
      }
    }
    // If the PC's LAN address changed (DHCP, sleep/wake, network switch),
    // re-announce on mDNS so phones find the PC at its new address.
    if (bonjour && mdnsService) {
      const ip = lanIp();
      if (ip !== lastLanIp) {
        const old = lastLanIp;
        lastLanIp = ip;
        dlog(`network-change ${old} -> ${ip}; re-announcing mDNS`);
        try {
          mdnsService.stop(() => {
            try {
              mdnsService = bonjour.publish({
                name: `OurDrop-${os.hostname()}`,
                type: "ourdrop",
                port: server.address().port,
                txt: { device: os.hostname(), app: "OurDrop" },
              });
            } catch {}
          });
        } catch {}
      }
    }
  }, 1000);
  sweep.unref?.();

  return new Promise((resolve, reject) => {
    const tryPort = (pt) => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && pt < port + 10) tryPort(pt + 1);
        else reject(e);
      });
      server.listen(pt, "0.0.0.0", async () => {
        dlog(`server-started port=${pt} ip=${lanIp()} device=${os.hostname()}`);
        const socketPeer = new Map(); // ws socket -> peer key
        ws = attachWebSocket(
          server,
          (ip, msg, socket) => {
            if (!ip) return;
            const entry = notePeer(ip, { id: msg?.id || null, name: msg?.device || null, via: "ws" });
            if (entry && socket) socketPeer.set(socket, entry.key);
          },
          (socket) => {
            // Any WS frame (incl. auto-pong) keeps the session fresh.
            const key = socketPeer.get(socket);
            const entry = key ? peerByKey.get(key) : null;
            if (entry) {
              entry.lastSeen = Date.now();
              if (entry.state === "unresponsive") {
                entry.state = "active";
                dlog(`peer-active key=${entry.key} name=${entry.name} ip=${entry.ip} via=ws`);
                emit({ type: "peer-active", key: entry.key, ip: entry.ip, name: entry.name });
              }
            }
          },
          (socket) => {
            // The socket closed (OS-level event): if this peer has also
            // been silent on every other channel for a few seconds, it
            // is gone RIGHT NOW — do not wait for the sweep threshold.
            // (A WebView reload closes its socket too, but then the
            // phone's HTTP polls keep lastSeen fresh and this no-ops.)
            const key = socketPeer.get(socket);
            socketPeer.delete(socket);
            const entry = key ? peerByKey.get(key) : null;
            if (entry && entry.state === "active" && Date.now() - entry.lastSeen > 3000) {
              entry.state = "unresponsive";
              dlog(`peer-unresponsive key=${entry.key} name=${entry.name} ip=${entry.ip} via=ws-close`);
              emit({ type: "peer-unresponsive", key: entry.key, ip: entry.ip, name: entry.name, silentMs: Date.now() - entry.lastSeen });
            }
          }
        );
        if (advertise) {
          try {
            const { Bonjour } = await import("bonjour-service");
            bonjour = new Bonjour();
            mdnsService = bonjour.publish({
              name: `OurDrop-${os.hostname()}`,
              type: "ourdrop",
              port: pt,
              txt: { device: os.hostname(), app: "OurDrop" },
            });
          } catch {}
        }
        resolve({ server, port: pt, getSharedDir, ws });
      });
    };
    tryPort(port);
  });
}

// Standalone run: `node server/server.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const baseDir = path.join(__dirname, "..");
  startServer({ baseDir }).then(({ port }) => {
    console.log(`\n  ${APP_NAME} is running!`);
    console.log(`  On this PC : http://127.0.0.1:${port}`);
    console.log(`  On mobile  : http://${lanIp()}:${port}   (same Wi-Fi)\n`);
  });
}
