// Shared by the extension and the Node tests.
// The salt is fixed so both browsers derive the same key. The shared code is the secret.
(function (root) {
  const PBKDF2_ITERATIONS = 100000;
  const SALT = "device-bridge-v1";
  const ROOM_PREFIX = "device-bridge:";
  const keyCache = new Map();
  const roomCache = new Map();

  function bytesToB64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    const step = 0x8000;
    for (let offset = 0; offset < u8.length; offset += step) {
      binary += String.fromCharCode(...u8.subarray(offset, offset + step));
    }
    return btoa(binary);
  }

  function b64ToBytes(value) {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  }

  function roomHash(code) {
    const normalized = String(code || "");
    if (!roomCache.has(normalized)) {
      roomCache.set(normalized, crypto.subtle.digest("SHA-256", new TextEncoder().encode(ROOM_PREFIX + normalized)).then((digest) => {
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      }));
    }
    return roomCache.get(normalized);
  }

  function deriveKey(code) {
    const normalized = String(code || "");
    if (!keyCache.has(normalized)) {
      keyCache.set(normalized, (async () => {
        const material = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(normalized),
          "PBKDF2",
          false,
          ["deriveKey"]
        );
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: new TextEncoder().encode(SALT), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
      })());
    }
    return keyCache.get(normalized);
  }

  async function encryptJson(key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    return { iv: bytesToB64(iv), data: bytesToB64(ciphertext) };
  }

  async function decryptJson(key, envelope) {
    const iv = b64ToBytes(envelope.iv);
    const ciphertext = b64ToBytes(envelope.data);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  async function encryptBytes(key, bytes, chunkSize = 1024 * 1024) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const records = [];
    const sliceCount = Math.max(1, Math.ceil(input.length / chunkSize) || 1);
    for (let index = 0; index < sliceCount; index += 1) {
      const start = index * chunkSize;
      const slice = input.subarray(start, Math.min(start + chunkSize, input.length));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, slice));
      const record = new Uint8Array(12 + ciphertext.length);
      record.set(iv, 0);
      record.set(ciphertext, 12);
      records.push(record);
    }
    const total = 8 + records.reduce((sum, record) => sum + 4 + record.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set([0x44, 0x42, 0x52, 0x31], 0);
    view.setUint32(4, records.length);
    let offset = 8;
    for (const record of records) {
      view.setUint32(offset, record.length);
      offset += 4;
      out.set(record, offset);
      offset += record.length;
    }
    return out;
  }

  async function decryptBytes(key, bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (
      input.length < 8 ||
      input[0] !== 0x44 ||
      input[1] !== 0x42 ||
      input[2] !== 0x52 ||
      input[3] !== 0x31
    ) {
      throw new Error("Not a Device Bridge file.");
    }
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const count = view.getUint32(4);
    if (count < 1 || count > 200000) throw new Error("Bad file.");
    const parts = [];
    let offset = 8;
    for (let index = 0; index < count; index += 1) {
      if (offset + 4 > input.length) throw new Error("Bad file.");
      const length = view.getUint32(offset);
      offset += 4;
      if (length < 28 || offset + length > input.length) throw new Error("Bad file.");
      const iv = input.subarray(offset, offset + 12);
      const ciphertext = input.subarray(offset + 12, offset + length);
      parts.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)));
      offset += length;
    }
    if (offset !== input.length) throw new Error("Bad file.");
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let written = 0;
    for (const part of parts) {
      out.set(part, written);
      written += part.length;
    }
    return out;
  }

  const api = { roomHash, deriveKey, encryptJson, decryptJson, encryptBytes, decryptBytes };
  root.BridgeCrypto = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
