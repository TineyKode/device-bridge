import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { WebSocket } from "ws";
import { createRelay } from "../server.js";

const require = createRequire(import.meta.url);
const { deriveKey, encryptJson, decryptJson, encryptBytes, decryptBytes, roomHash } = require("../../extension/crypto.js");

async function listen(relay) {
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  return relay.server.address().port;
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
  const messages = [];
  const waiters = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (!waiters[index].predicate(message)) continue;
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    ready,
    next(predicate, timeout = 3000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a relay message")), timeout);
        waiters.push({ predicate, resolve, timer });
      });
    }
  };
}

async function join(client, room, deviceId, name) {
  await client.ready;
  client.ws.send(JSON.stringify({ type: "join", room, deviceId, name }));
  return client.next((message) => message.type === "joined");
}

test("text survives a late join and is stored encrypted", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-bridge-"));
  const relay = createRelay({ dataDir });
  const port = await listen(relay);
  try {
    const code = "correct-horse";
    const room = await roomHash(code);
    const key = await deriveKey(code);
    const mac = connect(port);
    await join(mac, room, "mac-device-1", "Mac");
    const envelope = await encryptJson(key, { kind: "text", text: "hello from mac", at: 1 });
    mac.ws.send(JSON.stringify({ type: "publish", id: "text-message-1", envelope }));
    await mac.next((message) => message.type === "ack" && message.id === "text-message-1");
    await relay.flush();

    const windows = connect(port);
    await windows.ready;
    const itemPromise = windows.next((message) => message.type === "item");
    windows.ws.send(JSON.stringify({ type: "join", room, deviceId: "win-device-1", name: "Windows" }));
    await windows.next((message) => message.type === "joined");
    const item = await itemPromise;
    assert.equal(item.fromName, "Mac");
    assert.equal(JSON.stringify(item).includes("hello from mac"), false);
    assert.deepEqual(await decryptJson(key, item.envelope), { kind: "text", text: "hello from mac", at: 1 });
    assert.equal(fs.readFileSync(path.join(dataDir, "state.json"), "utf8").includes("hello from mac"), false);
    mac.ws.close();
    windows.ws.close();
  } finally {
    await relay.close();
  }
});

test("a live peer receives a file announcement and the ciphertext round-trips", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-bridge-"));
  const relay = createRelay({ dataDir, maxFileBytes: 1024 * 1024 });
  const port = await listen(relay);
  try {
    const room = await roomHash("shared-code-1");
    const key = await deriveKey("shared-code-1");
    const mac = connect(port);
    const windows = connect(port);
    await join(mac, room, "mac-device-2", "Mac");
    await join(windows, room, "win-device-2", "Windows");
    const peers = await mac.next((message) => message.type === "peers");
    assert.equal(peers.peers.some((peer) => peer.name === "Windows"), true);

    const original = crypto.getRandomValues(new Uint8Array(1500));
    const encrypted = await encryptBytes(key, original, 32);
    const transferId = "file-transfer-1";
    const uploaded = await fetch(`http://127.0.0.1:${port}/v1/files/${transferId}`, {
      method: "PUT",
      headers: { "x-room": room, "content-type": "application/octet-stream" },
      body: Buffer.from(encrypted)
    });
    assert.equal(uploaded.status, 201);

    const envelope = await encryptJson(key, {
      kind: "file",
      transferId,
      name: "notes.txt",
      size: original.length,
      mime: "text/plain",
      at: 2
    });
    mac.ws.send(JSON.stringify({ type: "publish", id: "file-message-1", envelope }));
    const item = await windows.next((message) => message.type === "item" && message.id === "file-message-1");
    const payload = await decryptJson(key, item.envelope);
    assert.equal(payload.name, "notes.txt");

    const downloaded = await fetch(`http://127.0.0.1:${port}/v1/files/${transferId}`, { headers: { "x-room": room } });
    assert.equal(downloaded.status, 200);
    const plain = await decryptBytes(key, new Uint8Array(await downloaded.arrayBuffer()));
    assert.deepEqual(plain, original);

    const wrongRoom = "a".repeat(64);
    const hidden = await fetch(`http://127.0.0.1:${port}/v1/files/${transferId}`, { headers: { "x-room": wrongRoom } });
    assert.equal(hidden.status, 404);
    mac.ws.close();
    windows.ws.close();
  } finally {
    await relay.close();
  }
});

test("oversized and expired files are rejected", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-bridge-"));
  const relay = createRelay({ dataDir, maxFileBytes: 32, fileTtlMs: 0 });
  const port = await listen(relay);
  try {
    const room = "b".repeat(64);
    const tooBig = await fetch(`http://127.0.0.1:${port}/v1/files/file-too-big01`, {
      method: "PUT",
      headers: { "x-room": room },
      body: Buffer.alloc(64, 1)
    });
    assert.equal(tooBig.status, 413);

    const kept = await fetch(`http://127.0.0.1:${port}/v1/files/file-kept-0001`, {
      method: "PUT",
      headers: { "x-room": room },
      body: Buffer.from("abc")
    });
    assert.equal(kept.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 10));
    relay.sweep();
    const gone = await fetch(`http://127.0.0.1:${port}/v1/files/file-kept-0001`, { headers: { "x-room": room } });
    assert.equal(gone.status, 404);
  } finally {
    await relay.close();
  }
});

test("backlog is still there after a relay restart", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-bridge-"));
  const first = createRelay({ dataDir });
  const port = await listen(first);
  const room = await roomHash("restart-code");
  const client = connect(port);
  await join(client, room, "mac-device-3", "Mac");
  const envelope = await encryptJson(await deriveKey("restart-code"), { kind: "text", text: "still here", at: 3 });
  client.ws.send(JSON.stringify({ type: "publish", id: "text-message-3", envelope }));
  await client.next((message) => message.type === "ack" && message.id === "text-message-3");
  await first.flush();
  client.ws.close();
  await first.close();

  const second = createRelay({ dataDir });
  const nextPort = await listen(second);
  try {
    const again = connect(nextPort);
    await join(again, room, "win-device-3", "Windows");
    const item = await again.next((message) => message.type === "item");
    assert.equal((await decryptJson(await deriveKey("restart-code"), item.envelope)).text, "still here");
    again.ws.close();
  } finally {
    await second.close();
  }
});
