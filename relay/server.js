import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const ROOM_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store"
  });
  res.end(data);
}

function readLimited(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > max) {
        req.pause();
        finish(reject, fail(413, "File is too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(resolve, Buffer.concat(chunks)));
    req.on("error", (error) => finish(reject, error.status ? error : fail(400, "Upload failed.")));
  });
}

export function createRelay(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error("dataDir is required.");
  const maxFileBytes = options.maxFileBytes ?? 100 * 1024 * 1024;
  const fileTtlMs = options.fileTtlMs ?? 24 * 60 * 60 * 1000;
  const maxLog = options.maxLog ?? 500;
  const maxEnvelope = options.maxEnvelope ?? 256 * 1024;
  const maxFiles = options.maxFiles ?? 100;

  const statePath = path.join(dataDir, "state.json");
  const filesDir = path.join(dataDir, "files");
  fs.mkdirSync(dataDir, { recursive: true });

  const rooms = new Map();
  const sockets = new Map();
  let saveTimer = null;
  let pending = null;
  let writeChain = Promise.resolve();

  function snapshot() {
    const roomsOut = {};
    for (const [room, record] of rooms) {
      roomsOut[room] = {
        log: record.log.map((item) => ({
          id: item.id,
          from: item.from,
          fromName: item.fromName,
          envelope: { iv: item.envelope.iv, data: item.envelope.data },
          at: item.at
        })),
        files: [...record.files.values()].map((file) => ({
          id: file.id,
          size: file.size,
          createdAt: file.createdAt
        }))
      };
    }
    return JSON.stringify({ rooms: roomsOut });
  }

  function scheduleSave() {
    pending = snapshot();
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const data = pending;
      pending = null;
      if (data == null) return;
      writeChain = writeChain.then(() => fs.promises.writeFile(statePath, data));
    }, 40);
    saveTimer.unref?.();
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      const data = pending;
      pending = null;
      if (data != null) writeChain = writeChain.then(() => fs.promises.writeFile(statePath, data));
    }
    return writeChain;
  }

  function load() {
    if (!fs.existsSync(statePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      return;
    }
    for (const [room, record] of Object.entries(parsed.rooms || {})) {
      if (!ROOM_RE.test(room)) continue;
      const files = new Map();
      for (const file of record.files || []) {
        if (!file || !ID_RE.test(file.id)) continue;
        const filePath = path.join(filesDir, room, file.id);
        if (!fs.existsSync(filePath)) continue;
        files.set(file.id, { id: file.id, size: file.size, createdAt: file.createdAt, path: filePath });
      }
      const log = Array.isArray(record.log)
        ? record.log.filter((item) => item && ID_RE.test(item.id) && item.envelope?.iv && item.envelope?.data)
        : [];
      rooms.set(room, { log, files });
    }
  }

  function getRoom(room) {
    let record = rooms.get(room);
    if (!record) {
      record = { log: [], files: new Map() };
      rooms.set(room, record);
    }
    return record;
  }

  function peerList(room) {
    const map = sockets.get(room);
    if (!map) return [];
    return [...map.values()].map((client) => ({ deviceId: client.deviceId, name: client.name }));
  }

  function sendPeers(room, except) {
    const map = sockets.get(room);
    if (!map) return;
    const payload = JSON.stringify({ type: "peers", peers: peerList(room) });
    for (const client of map.values()) {
      if (client !== except && client.ws.readyState === 1) client.ws.send(payload);
    }
  }

  function sweep() {
    const now = Date.now();
    let changed = false;
    for (const [, record] of rooms) {
      for (const [id, file] of record.files) {
        if (now - file.createdAt <= fileTtlMs) continue;
        fs.rmSync(file.path, { force: true });
        record.files.delete(id);
        changed = true;
      }
    }
    if (!fs.existsSync(filesDir)) {
      if (changed) scheduleSave();
      return;
    }
    for (const roomName of fs.readdirSync(filesDir)) {
      const dir = path.join(filesDir, roomName);
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const id of names) {
        if (rooms.get(roomName)?.files.has(id)) continue;
        fs.rmSync(path.join(dir, id), { force: true });
      }
    }
    if (changed) scheduleSave();
  }

  load();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (parts[0] === "v1" && parts[1] === "files" && parts.length === 3) {
        const room = headerRoom(req);
        const id = parts[2];
        if (!ID_RE.test(id)) throw fail(400, "Bad file id.");
        if (req.method === "PUT") {
          const record = getRoom(room);
          if (record.files.has(id)) throw fail(409, "File already exists.");
          if (record.files.size >= maxFiles) throw fail(429, "Too many pending files.");
          const body = await readLimited(req, maxFileBytes);
          if (body.length === 0) throw fail(400, "Empty file.");
          const dir = path.join(filesDir, room);
          await fs.promises.mkdir(dir, { recursive: true });
          const filePath = path.join(dir, id);
          await fs.promises.writeFile(filePath, body);
          record.files.set(id, { id, size: body.length, createdAt: Date.now(), path: filePath });
          scheduleSave();
          sendJson(res, 201, { transferId: id, size: body.length });
          return;
        }
        if (req.method === "GET") {
          const file = rooms.get(room)?.files.get(id);
          if (!file || !fs.existsSync(file.path)) throw fail(404, "File not found.");
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": file.size,
            "cache-control": "no-store"
          });
          fs.createReadStream(file.path).pipe(res);
          return;
        }
      }
      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      const status = error.status || 500;
      if (!error.status) console.error(error);
      sendJson(res, status, { error: error.status ? error.message : "Relay error." });
      if (status === 413) req.destroy();
    }
  });

  function headerRoom(req) {
    const room = req.headers["x-room"];
    if (typeof room !== "string" || !ROOM_RE.test(room)) throw fail(400, "Missing room.");
    return room;
  }

  const wss = new WebSocketServer({ server, path: "/v1/ws", maxPayload: maxEnvelope + 4096 });

  wss.on("connection", (ws) => {
    let current = null;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!current) {
        if (message.type !== "join") return;
        if (!ROOM_RE.test(message.room) || !ID_RE.test(message.deviceId)) {
          ws.close(1008, "bad join");
          return;
        }
        const name = String(message.name || "Device").slice(0, 40) || "Device";
        let map = sockets.get(message.room);
        if (!map) {
          map = new Map();
          sockets.set(message.room, map);
        }
        const previous = map.get(message.deviceId);
        current = { ws, name, room: message.room, deviceId: message.deviceId };
        map.set(message.deviceId, current);
        if (previous && previous.ws !== ws) previous.ws.close(4000, "replaced");
        ws.send(JSON.stringify({ type: "joined", peers: peerList(message.room) }));
        const record = rooms.get(message.room);
        if (record) {
          for (const item of record.log) ws.send(JSON.stringify({ type: "item", ...item }));
        }
        sendPeers(message.room, current);
        return;
      }
      if (message.type !== "publish") return;
      if (!ID_RE.test(message.id)) return;
      const envelope = message.envelope;
      if (!envelope || typeof envelope.iv !== "string" || typeof envelope.data !== "string") return;
      if (envelope.iv.length > 64 || envelope.data.length > maxEnvelope) return;
      const record = getRoom(current.room);
      if (record.log.some((item) => item.id === message.id)) {
        ws.send(JSON.stringify({ type: "ack", id: message.id }));
        return;
      }
      const item = {
        id: message.id,
        from: current.deviceId,
        fromName: current.name,
        envelope: { iv: envelope.iv, data: envelope.data },
        at: Date.now()
      };
      record.log.push(item);
      if (record.log.length > maxLog) record.log.splice(0, record.log.length - maxLog);
      scheduleSave();
      ws.send(JSON.stringify({ type: "ack", id: message.id }));
      const payload = JSON.stringify({ type: "item", ...item });
      const map = sockets.get(current.room);
      if (!map) return;
      for (const client of map.values()) {
        if (client.deviceId !== current.deviceId && client.ws.readyState === 1) client.ws.send(payload);
      }
    });

    ws.on("close", () => {
      if (!current) return;
      const map = sockets.get(current.room);
      if (!map) return;
      const still = map.get(current.deviceId);
      if (!still || still.ws !== ws) return;
      map.delete(current.deviceId);
      if (map.size === 0) sockets.delete(current.room);
      else sendPeers(current.room);
    });
  });

  const sweepTimer = setInterval(sweep, 60 * 1000);
  sweepTimer.unref?.();
  const pingTimer = setInterval(() => {
    for (const map of sockets.values()) {
      for (const client of map.values()) {
        if (client.ws.readyState === 1) client.ws.ping();
      }
    }
  }, 30000);
  pingTimer.unref?.();

  async function close() {
    clearInterval(sweepTimer);
    clearInterval(pingTimer);
    for (const map of sockets.values()) {
      for (const client of map.values()) client.ws.close();
    }
    await new Promise((resolve) => wss.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await flush();
  }

  return { server, sweep, flush, close };
}

function start() {
  const port = Number(process.env.PORT || 8787);
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  const relay = createRelay({
    dataDir,
    maxFileBytes: Number(process.env.MAX_FILE_MB || 100) * 1024 * 1024,
    fileTtlMs: Number(process.env.FILE_TTL_HOURS || 24) * 60 * 60 * 1000
  });
  relay.server.listen(port, "0.0.0.0", () => {
    console.log(`Device Bridge relay listening on ${port}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start();
