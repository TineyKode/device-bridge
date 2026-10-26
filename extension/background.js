importScripts("crypto.js");

const DEFAULTS = {
  relayUrl: "http://127.0.0.1:8787",
  code: "",
  deviceName: "",
  inbox: [],
  seenIds: []
};

let socket = null;
let opening = null;
let peers = [];
let connected = false;
let lastError = "";
let backoff = 500;
let generation = 0;
let storageChain = Promise.resolve();
const pendingAcks = new Map();

function defaultName() {
  const agent = navigator.userAgent || "";
  if (agent.includes("Mac")) return "Mac";
  if (agent.includes("Windows")) return "Windows";
  if (agent.includes("Linux")) return "Linux";
  return "Browser";
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  let { deviceId } = await chrome.storage.local.get("deviceId");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  return { ...stored, deviceId };
}

function updateStorage(mutator) {
  const run = storageChain.then(async () => {
    const settings = await loadSettings();
    const patch = await mutator(settings);
    if (patch) await chrome.storage.local.set(patch);
    return patch;
  });
  storageChain = run.then(() => {}, () => {});
  return run;
}

function disconnect() {
  generation += 1;
  const current = socket;
  socket = null;
  connected = false;
  peers = [];
  if (current) {
    current.onclose = null;
    current.close();
  }
}

function scheduleReconnect(gen) {
  const wait = backoff;
  backoff = Math.min(backoff * 2, 15000);
  setTimeout(() => {
    if (gen === generation) ensureConnected();
  }, wait);
}

function relayToSocketUrl(relayUrl) {
  const url = new URL(relayUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Relay URL must start with http:// or https://.");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function ingest(message) {
  const settings = await loadSettings();
  if (!settings.code || message.from === settings.deviceId) return;
  if ((settings.seenIds || []).includes(message.id)) return;
  let payload;
  try {
    const key = await BridgeCrypto.deriveKey(settings.code);
    payload = await BridgeCrypto.decryptJson(key, message.envelope);
  } catch {
    return;
  }
  if (!payload || (payload.kind !== "text" && payload.kind !== "file")) return;
  const item = {
    id: message.id,
    from: message.from,
    fromName: message.fromName || "Device",
    at: message.at || Date.now(),
    kind: payload.kind,
    text: payload.kind === "text" ? String(payload.text || "").slice(0, 100000) : "",
    name: String(payload.name || "").slice(0, 180),
    size: Number(payload.size) || 0,
    mime: String(payload.mime || ""),
    transferId: String(payload.transferId || "")
  };
  await updateStorage((current) => {
    if ((current.seenIds || []).includes(item.id)) return null;
    return {
      inbox: [item, ...(current.inbox || [])].slice(0, 100),
      seenIds: [item.id, ...(current.seenIds || [])].slice(0, 1000)
    };
  });
  const title = item.kind === "file" ? item.name || "File received" : `Text from ${item.fromName}`;
  const body = item.kind === "file" ? "Open Device Bridge to download." : item.text.slice(0, 180);
  chrome.notifications.create(item.id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: body || "Open Device Bridge."
  }).catch(() => {});
}

async function openSocket(settings, gen) {
  let wsUrl;
  try {
    wsUrl = relayToSocketUrl(settings.relayUrl.replace(/\/$/, ""));
  } catch (error) {
    lastError = error.message;
    return;
  }
  const room = await BridgeCrypto.roomHash(settings.code);
  await new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const ws = new WebSocket(wsUrl);
    socket = ws;
    const timeout = setTimeout(finish, 8000);
    ws.onopen = () => {
      if (gen !== generation) {
        ws.close();
        clearTimeout(timeout);
        finish();
        return;
      }
      opened = true;
      backoff = 500;
      ws.send(JSON.stringify({
        type: "join",
        room,
        deviceId: settings.deviceId,
        name: settings.deviceName || defaultName()
      }));
    };
    ws.onmessage = (event) => {
      if (gen !== generation || socket !== ws) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "joined" || message.type === "peers") {
        peers = message.peers || [];
        connected = true;
        lastError = "";
        if (message.type === "joined") {
          clearTimeout(timeout);
          finish();
        }
        return;
      }
      if (message.type === "ack" && pendingAcks.has(message.id)) {
        pendingAcks.get(message.id)();
        return;
      }
      if (message.type === "item") ingest(message);
    };
    ws.onerror = () => {
      if (!opened) lastError = "Relay unreachable.";
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (socket === ws) {
        socket = null;
        connected = false;
        peers = [];
        if (!opened) lastError = "Relay unreachable.";
        if (gen === generation) scheduleReconnect(gen);
      }
      finish();
    };
  });
}

async function ensureConnected() {
  if (opening) return opening;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  const gen = generation;
  opening = (async () => {
    const settings = await loadSettings();
    if (!settings.code || settings.code.trim().length < 8) {
      lastError = "Set a shared code of at least 8 characters.";
      connected = false;
      return;
    }
    await openSocket(settings, gen);
  })().finally(() => {
    opening = null;
  });
  return opening;
}

function publicState(settings) {
  return {
    ok: true,
    connected,
    lastError,
    peers: peers.filter((peer) => peer.deviceId !== settings.deviceId),
    selfName: settings.deviceName || defaultName(),
    relayUrl: settings.relayUrl,
    hasCode: Boolean(settings.code && settings.code.trim().length >= 8),
    inbox: settings.inbox || []
  };
}

async function publish(payload) {
  await ensureConnected();
  if (!socket || socket.readyState !== WebSocket.OPEN) return { ok: false, error: lastError || "Not connected." };
  const settings = await loadSettings();
  if (!settings.code || settings.code.trim().length < 8) return { ok: false, error: "Set a shared code of at least 8 characters." };
  if (!payload || (payload.kind !== "text" && payload.kind !== "file")) return { ok: false, error: "Bad message." };
  if (payload.kind === "text" && !String(payload.text || "").length) return { ok: false, error: "Nothing to send." };
  if (payload.kind === "file" && (!payload.transferId || !payload.name)) return { ok: false, error: "File is missing a name." };
  const key = await BridgeCrypto.deriveKey(settings.code);
  const envelope = await BridgeCrypto.encryptJson(key, payload);
  if (envelope.data.length > 200000) return { ok: false, error: "Text is too long. Send it as a file." };
  const id = crypto.randomUUID();
  const acked = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(id);
      resolve(false);
    }, 8000);
    pendingAcks.set(id, () => {
      clearTimeout(timer);
      pendingAcks.delete(id);
      resolve(true);
    });
  });
  socket.send(JSON.stringify({ type: "publish", id, envelope }));
  if (!await acked) return { ok: false, error: "Relay did not confirm the send." };
  await updateStorage((current) => ({ seenIds: [id, ...(current.seenIds || [])].slice(0, 1000) }));
  return { ok: true, id };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "getState") {
      await ensureConnected();
      return publicState(await loadSettings());
    }
    if (message?.type === "saveSettings") {
      await updateStorage((previous) => {
        const patch = {};
        if (typeof message.relayUrl === "string" && message.relayUrl.trim()) patch.relayUrl = message.relayUrl.trim();
        if (typeof message.code === "string") patch.code = message.code;
        if (typeof message.deviceName === "string") patch.deviceName = message.deviceName.trim().slice(0, 40);
        const codeChanged = typeof patch.code === "string" && patch.code !== previous.code;
        return codeChanged ? { ...patch, inbox: [], seenIds: [] } : patch;
      });
      disconnect();
      await ensureConnected();
      return publicState(await loadSettings());
    }
    if (message?.type === "publish") return publish(message.payload);
    if (message?.type === "forget") {
      await updateStorage((current) => ({ inbox: (current.inbox || []).filter((item) => item.id !== message.id) }));
      return { ok: true };
    }
    return { ok: false, error: "Unknown message." };
  })().then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || "Something went wrong." }));
  return true;
});

chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => ensureConnected());
ensureConnected();
