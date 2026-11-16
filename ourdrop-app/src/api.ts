import { sha256OfBlob } from "./sha256";

export interface FileItem {
  name: string;
  size: number;
  mtime: number;
  origin?: string | null;
  outbox?: boolean;
}
export interface Info {
  app: string;
  device: string;
  ip: string;
  folder: string;
  port: number;
  approvalRequired?: boolean;
  youApproved?: boolean;
  /** The shared PC⇄phone display name (the PC hostname stays in `device`). */
  displayName?: string;
  nameTs?: number;
  /** True when the storage folder is one Windows protects with Controlled Folder Access. */
  protectedFolder?: boolean;
}
export interface Peer {
  ip: string;
  name?: string;
  ago: number;
  state?: string;
  id?: string | null;
}
export interface HistItem {
  name: string;
  size: number;
  dir: "sent" | "received";
  time: number;
  loc?: string;
  verified?: boolean;
}

export const fmtSize = (b: number) => {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
};

// persistent device identity (sent on API calls so the PC can name peers)
export function deviceId(): string {
  // On Android the native side owns the identity: the SAME id the
  // ReceiveService uses, so upload origins and the service's
  // own-upload skip compare equal. Adopt it whenever the bridge is up.
  try {
    const native = (window as any).OurDropAndroid?.getDeviceId?.();
    if (typeof native === "string" && native) {
      if (localStorage.getItem("od_device_id") !== native) localStorage.setItem("od_device_id", native);
      return native;
    }
  } catch {}
  let id = localStorage.getItem("od_device_id");
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("od_device_id", id);
  }
  return id;
}
export function deviceName(): string {
  return localStorage.getItem("od_device_name") || "Android device";
}
const H = () => ({ "x-od-device": deviceName(), "x-od-id": deviceId() });

export async function fetchInfo(): Promise<Info> {
  const r = await fetch("/api/info", { headers: H() });
  // v54: an HTTP error (the offline origin, a proxy, a portal)
  // must count as "no session", exactly like a rejected fetch —
  // otherwise the dashboard would treat a dead origin as a live
  // PC and never show the Not connected state.
  if (!r.ok) throw new Error("info failed");
  return r.json();
}
/** Set the shared display name on the PC (latest-update-wins there).
 *  Resolves with the server's verdict — on a lost race, the current
 *  winning name/ts so the caller can converge to it. */
export async function postSharedName(
  name: string,
  ts: number,
): Promise<{ ok: boolean; name: string; ts: number }> {
  const r = await fetch("/api/name", {
    method: "POST",
    headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, ts }),
  });
  return r.json();
}
export async function fetchFiles(): Promise<FileItem[]> {
  const r = await fetch("/api/files", { headers: H() });
  const j = await r.json();
  // v54: the offline dashboard must render with every API call
  // failing — never let a non-array body (e.g. an error JSON from
  // a proxy or portal) reach state and crash the list renders.
  return Array.isArray(j) ? j : [];
}
export async function fetchPeers(): Promise<Peer[]> {
  try {
    const r = await fetch("/api/peers", { headers: H() });
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}
export async function deleteAllFiles(): Promise<{ deleted: number; failed: number }> {
  const r = await fetch("/api/files", { method: "DELETE", headers: H() });
  if (!r.ok) throw new Error("delete-all failed");
  return r.json();
}
export function deleteFile(name: string) {
  return fetch("/api/delete?name=" + encodeURIComponent(name), { method: "DELETE", headers: H() });
}
export async function fetchHash(name: string): Promise<string | null> {
  try {
    const r = await fetch("/api/hash?name=" + encodeURIComponent(name), { headers: H() });
    const j = await r.json();
    return j.sha256 || null;
  } catch {
    return null;
  }
}

// ---- approvals (PC-local UI only; server enforces) ----
export interface Approvals {
  required: boolean;
  pending: { ip: string; name: string }[];
  approved: string[];
}
export async function fetchApprovals(): Promise<Approvals | null> {
  try {
    const r = await fetch("/api/approvals");
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}
export async function approveIp(ip: string) {
  await fetch("/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip }),
  });
}
export async function setRequireApproval(on: boolean) {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ require_approval: on }),
  });
}

// ---- transfer history ----
const HKEY = "od_history";
export function loadHistory(): HistItem[] {
  try {
    return JSON.parse(localStorage.getItem(HKEY) || "[]");
  } catch {
    return [];
  }
}
export function clearHistory() {
  localStorage.setItem(HKEY, "[]");
  window.dispatchEvent(new Event("od-history"));
}
export function addHistory(h: HistItem) {
  const list = loadHistory();
  list.unshift(h);
  localStorage.setItem(HKEY, JSON.stringify(list.slice(0, 200)));
  window.dispatchEvent(new Event("od-history"));
}

// ---- display name (personalises the dashboard welcome; stored only on
// this device, never sent anywhere) ----
const NAME_KEY = "od_display_name";
export function loadDisplayName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) || "").trim();
  } catch {
    return "";
  }
}
export function saveDisplayName(n: string) {
  localStorage.setItem(NAME_KEY, n.trim());
  window.dispatchEvent(new Event("od-name"));
}

// ---- chunked, resumable upload ----
// Pause = stop sending (partial file stays on the server).
// Resume = ask the server how much it has, continue from there.
// Cancel = tell the server to delete the partial file.
// v48 reliability: sessions survive restarts on BOTH sides — the
// client re-attaches by session id, or by file identity when the id
// was lost (the server persists sessions and rebuilds the offset
// from the partial file). Every request has a timeout; a failed
// chunk retries with backoff after re-syncing to the server's true
// offset, so a Wi-Fi drop self-heals instead of freezing the card.
export class ChunkedUpload {
  id: string | null = null;
  sent = 0;
  hash: string | null = null;
  private ctl: AbortController | null = null;
  state: "idle" | "uploading" | "paused" | "done" | "error" | "cancelled" = "idle";
  /** Last time a chunk was confirmed by the server (UI stall hint). */
  lastActivity = 0;

  constructor(public file: File) {}

  private timedCtl(ms: number) {
    const c = new AbortController();
    this.ctl = c;
    const t = window.setTimeout(() => {
      try {
        c.abort();
      } catch {}
    }, ms);
    return { signal: c.signal, done: () => window.clearTimeout(t) };
  }

  private async syncStatus(): Promise<boolean> {
    if (!this.id) return false;
    try {
      const r = await fetch("/api/upload/status?id=" + this.id, { headers: H() });
      if (!r.ok) return false;
      const j = await r.json();
      this.sent = j.received;
      return true;
    } catch {
      return false;
    }
  }

  private async tryResume(): Promise<boolean> {
    try {
      const r = await fetch("/api/upload/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...H() },
        body: JSON.stringify({ name: this.file.name, size: this.file.size }),
      });
      if (!r.ok) return false;
      const j = await r.json();
      this.id = j.id;
      this.sent = j.received || 0;
      return true;
    } catch {
      return false;
    }
  }

  /** Attach to the server's session for this file: by id when we
   *  still have one, else by identity, else a fresh session. */
  private async attach() {
    if (this.id && (await this.syncStatus())) return;
    this.id = null;
    if (await this.tryResume()) return;
    const r = await fetch("/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...H() },
      body: JSON.stringify({ name: this.file.name, size: this.file.size }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "init failed");
    this.id = j.id;
    this.sent = j.received || 0;
  }

  private async sendRemaining(onProgress: (sent: number) => void) {
    const CHUNK = 4 * 1024 * 1024;
    let failures = 0;
    while (this.sent < this.file.size) {
      if (this.state !== "uploading") throw new Error("paused");
      const end = Math.min(this.sent + CHUNK, this.file.size);
      const blob = this.file.slice(this.sent, end);
      try {
        const { signal, done } = this.timedCtl(25000);
        let r: Response;
        let j: any = {};
        try {
          r = await fetch(`/api/upload/chunk?id=${this.id}&offset=${this.sent}`, {
            method: "POST",
            headers: H(),
            body: blob,
            signal,
          });
          j = await r.json().catch(() => ({}));
        } finally {
          done();
        }
        if (r.status === 409 && typeof j.received === "number") {
          // Our offset disagreed with the server's partial file —
          // adopt the server's truth and continue from there.
          this.sent = j.received;
          failures = 0;
          this.lastActivity = Date.now();
          onProgress(this.sent);
          continue;
        }
        if (r.status === 404) throw new Error("session-gone");
        if (!r.ok) throw new Error(j.error || "chunk failed");
        this.sent = j.received;
        failures = 0;
        this.lastActivity = Date.now();
        onProgress(this.sent);
      } catch (e: any) {
        if (this.state !== "uploading") throw e; // paused / cancelled
        if (e?.message === "session-gone" || e?.message === "approval_required") throw e;
        failures++;
        if (failures > 40) throw new Error("interrupted");
        await new Promise((res) => window.setTimeout(res, Math.min(8000, 500 * 2 ** Math.min(failures, 4))));
        if (this.state !== "uploading") throw new Error("paused");
        // The chunk may or may not have landed — re-sync before
        // retrying so bytes are never double-counted or skipped.
        await this.syncStatus();
      }
    }
  }

  async start(onProgress: (sent: number) => void): Promise<{ name: string; sha256: string | null; verified: boolean }> {
    let rounds = 0;
    for (;;) {
      if (this.state === "cancelled") throw new Error("cancelled");
      await this.attach();
      this.state = "uploading";
      this.lastActivity = Date.now();
      try {
        await this.sendRemaining(onProgress);
      } catch (e: any) {
        if (e?.message === "session-gone" && ++rounds <= 3) {
          this.id = null; // re-attach (resume lookup or fresh) and continue
          continue;
        }
        throw e;
      }
      if (!this.hash) this.hash = await sha256OfBlob(this.file);
      const fr = await fetch("/api/upload/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...H() },
        body: JSON.stringify({ id: this.id }),
      });
      const fj = await fr.json().catch(() => ({}));
      if (fr.ok) {
        this.state = "done";
        return { name: fj.name, sha256: fj.sha256, verified: !!fj.sha256 && fj.sha256 === this.hash };
      }
      if (fj.error === "incomplete" && ++rounds <= 3) continue; // loop sends what is missing
      throw new Error(fj.error || "finalize failed");
    }
  }

  pause() {
    if (this.state === "uploading") {
      this.state = "paused";
      this.ctl?.abort();
    }
  }
  async cancel() {
    this.state = "cancelled";
    this.ctl?.abort();
    if (this.id) {
      try {
        await fetch("/api/upload?id=" + this.id, { method: "DELETE", headers: H() });
      } catch {}
    }
  }
}

/** Cancel a phone-side download from the PC transfer card (v48). */
export async function cancelRxDownload(name: string) {
  try {
    await fetch("/api/rx-cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...H() },
      body: JSON.stringify({ name }),
    });
  } catch {}
}

/**
 * Sends a file that exists as a filesystem path (native dialog picks,
 * drag & drop in the desktop app) WITHOUT copying it anywhere: the
 * file is registered in the server's outbox and the phone downloads
 * it straight from its original location. start() resolves once the
 * offer is live — the queue item then waits for the server's
 * "outbox-delivered" event (handled in App) to show delivery.
 * Pause withdraws the offer; Resume re-offers; Cancel withdraws.
 */
export class OutboxUpload {
  id: string | null = null;
  state: "idle" | "uploading" | "paused" | "done" | "error" | "cancelled" = "idle";
  offered = false;

  constructor(public path: string, public name: string, public size: number) {}

  async start(_onProgress: (sent: number) => void): Promise<{ name: string; sha256: string | null; verified: boolean }> {
    const r = await fetch("/api/outbox", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...H() },
      body: JSON.stringify({ items: [{ name: this.name, path: this.path }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Could not offer the file");
    const res = Array.isArray(j.results) ? j.results[0] : null;
    if (!res || !res.ok) throw new Error((res && res.error) || "Could not offer the file");
    this.offered = true;
    this.state = "done";
    return { name: res.name || this.name, sha256: null, verified: false };
  }

  pause() {
    if (this.offered) {
      this.state = "paused";
      this.offered = false;
      fetch("/api/outbox?name=" + encodeURIComponent(this.name), { method: "DELETE", headers: H() }).catch(() => {});
    }
  }

  async cancel() {
    this.state = "cancelled";
    if (this.offered) {
      this.offered = false;
      try {
        await fetch("/api/outbox?name=" + encodeURIComponent(this.name), { method: "DELETE", headers: H() });
      } catch {}
    }
  }
}

// ---- WebSocket live events ----
export type WsEvent = { type: string; [k: string]: any };
export function connectWs(onEvent: (e: WsEvent) => void, onState: (up: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: number = 0;
  const open = () => {
    if (closed) return;
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      onState(true);
      retry = 0;
      ws?.send(JSON.stringify({ device: deviceName(), id: deviceId() }));
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {}
    };
    ws.onclose = () => {
      onState(false);
      schedule();
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {}
    };
  };
  const schedule = () => {
    if (closed) return;
    retry = window.setTimeout(open, Math.min(15000, 1500 + retry * 0 + 2000));
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(retry);
    try {
      ws?.close();
    } catch {}
  };
}
