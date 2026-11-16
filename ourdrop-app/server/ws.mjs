// Minimal WebSocket (RFC 6455) server for OurDrop live events.
// Text frames only (our events are small JSON). The server pings every
// 2.5s; browsers auto-pong, and ANY frame (pong/text/ping) counts as
// connection activity so a live socket keeps its peer entry fresh —
// which is what makes fast, reliable disconnect detection possible.
import crypto from "node:crypto";

export function attachWebSocket(server, onClientMessage, onActivity, onClose) {
  const clients = new Set();
  const lastActivity = new Map(); // socket -> timestamp

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const s of clients) {
      if (now - (lastActivity.get(s) || 0) > 15000) {
        try {
          s.destroy();
        } catch {}
        clients.delete(s);
        lastActivity.delete(s);
        continue;
      }
      sendFrame(s, 9, Buffer.alloc(0)); // ping
    }
  }, 2500);
  pingTimer.unref?.();

  server.on("upgrade", (req, socket) => {
    if (!req.url.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket._odIp = (socket.remoteAddress || "").replace("::ffff:", "");
    clients.add(socket);
    lastActivity.set(socket, Date.now());

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        let payload = buf.subarray(off, off + len);
        if (masked) {
          const mask = buf.subarray(maskOff, maskOff + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(off + len);
        lastActivity.set(socket, Date.now());
        if (onActivity) {
          try {
            onActivity(socket);
          } catch {}
        }
        if (op === 9) {
          sendFrame(socket, 10, payload); // ping -> pong
        } else if (op === 8) {
          socket.end();
          clients.delete(socket);
          lastActivity.delete(socket);
          return;
        } else if (op === 1 && fin) {
          try {
            onClientMessage && onClientMessage(socket._odIp, JSON.parse(payload.toString()), socket);
          } catch {}
        }
        // op 10 (pong) and everything else: activity already recorded.
      }
    });
    const drop = () => {
      clients.delete(socket);
      lastActivity.delete(socket);
      if (onClose) {
        try {
          onClose(socket);
        } catch {}
      }
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  function sendFrame(socket, op, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    let head;
    if (data.length < 126) {
      head = Buffer.from([0x80 | op, data.length]);
    } else if (data.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(data.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(data.length), 2);
    }
    try {
      socket.write(Buffer.concat([head, data]));
    } catch {}
  }

  return {
    broadcast(obj) {
      const msg = JSON.stringify(obj);
      for (const s of clients) sendFrame(s, 1, msg);
    },
    count: () => clients.size,
  };
}
