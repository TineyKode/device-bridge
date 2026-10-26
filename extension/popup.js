const statusEl = document.querySelector("#status");
const peersEl = document.querySelector("#peers");
const settingsEl = document.querySelector("#settings");
const settingsToggle = document.querySelector("#settings-toggle");
const relayInput = document.querySelector("#relay-url");
const codeInput = document.querySelector("#code");
const nameInput = document.querySelector("#device-name");
const textInput = document.querySelector("#text");
const fileInput = document.querySelector("#files");
const progressEl = document.querySelector("#progress");
const inboxEl = document.querySelector("#inbox");

let latestInbox = [];
let busy = false;
let settingsOpen = false;
let formReady = false;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function safeName(name) {
  const base = String(name || "download").split(/[/\\]/).pop().replace(/[\u0000-\u001f]/g, "").trim();
  return base || "download";
}

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

function setProgress(message, isError) {
  progressEl.textContent = message || "";
  progressEl.classList.toggle("bad", Boolean(isError));
}

function setBusy(next) {
  busy = next;
  for (const id of ["send-text", "send-clip", "send-files", "save"]) {
    document.querySelector(`#${id}`).disabled = next;
  }
}

async function storedSetup() {
  return chrome.storage.local.get({
    relayUrl: "http://127.0.0.1:8787",
    code: "",
    deviceName: ""
  });
}

function renderInbox(items) {
  latestInbox = items || [];
  inboxEl.replaceChildren();
  if (!latestInbox.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing received yet.";
    inboxEl.append(empty);
    return;
  }
  for (const item of latestInbox) {
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "item-top";
    const who = document.createElement("strong");
    who.textContent = item.fromName || "Device";
    const when = document.createElement("span");
    when.className = "meta";
    when.textContent = formatTime(item.at);
    top.append(who, when);

    const preview = document.createElement("p");
    preview.className = "preview";
    if (item.kind === "file") {
      preview.textContent = `${item.name || "File"} · ${formatSize(item.size)}`;
    } else {
      const text = item.text || "";
      preview.textContent = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const main = document.createElement("button");
    main.type = "button";
    main.dataset.action = item.kind === "file" ? "download" : "copy";
    main.dataset.id = item.id;
    main.textContent = item.kind === "file" ? "Download" : "Copy";
    const forget = document.createElement("button");
    forget.type = "button";
    forget.dataset.action = "forget";
    forget.dataset.id = item.id;
    forget.textContent = "Remove";
    actions.append(main, forget);
    li.append(top, preview, actions);
    inboxEl.append(li);
  }
}

function applyState(state) {
  nameInput.placeholder = state.selfName || "Mac";

  statusEl.classList.remove("ok", "bad");
  if (!state.hasCode) {
    statusEl.textContent = "Add a shared code to connect.";
    settingsOpen = true;
  } else if (state.connected) {
    statusEl.textContent = `Connected as ${state.selfName}`;
    statusEl.classList.add("ok");
  } else if (state.lastError) {
    statusEl.textContent = state.lastError;
    statusEl.classList.add("bad");
  } else {
    statusEl.textContent = "Connecting…";
  }

  const others = state.peers || [];
  peersEl.textContent = others.length
    ? `Other browsers online: ${others.map((peer) => peer.name).join(", ")}`
    : "No other browser is connected right now. Sent items wait on the relay.";
  settingsEl.hidden = state.hasCode && !settingsOpen;
  settingsToggle.textContent = settingsEl.hidden ? "Setup" : "Hide setup";
  renderInbox(state.inbox);
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [state, setup] = await Promise.all([sendMessage({ type: "getState" }), storedSetup()]);
    if (!formReady) {
      relayInput.value = setup.relayUrl;
      codeInput.value = setup.code || "";
      nameInput.value = setup.deviceName || "";
      formReady = true;
    }
    applyState(state);
  } finally {
    refreshing = false;
  }
}

async function saveSettings() {
  setBusy(true);
  setProgress("");
  try {
    const state = await sendMessage({
      type: "saveSettings",
      relayUrl: relayInput.value.trim(),
      code: codeInput.value,
      deviceName: nameInput.value.trim()
    });
    applyState(state);
    if (!state.connected) setProgress(state.lastError || "Not connected yet.", true);
    else setProgress("Saved.");
  } catch (error) {
    setProgress(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function publish(payload) {
  const result = await sendMessage({ type: "publish", payload });
  if (!result?.ok) throw new Error(result?.error || "Could not send.");
  return result;
}

async function sendText() {
  const text = textInput.value;
  if (!text) {
    setProgress("Type something first.", true);
    return;
  }
  setBusy(true);
  setProgress("Sending…");
  try {
    await publish({ kind: "text", text, at: Date.now() });
    textInput.value = "";
    setProgress("Text sent.");
  } catch (error) {
    setProgress(error.message, true);
  } finally {
    setBusy(false);
  }
}

function readClipboardFallback() {
  const field = document.createElement("textarea");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.append(field);
  field.focus();
  const ok = document.execCommand("paste");
  const text = field.value;
  field.remove();
  if (!ok) throw new Error("Clipboard blocked. Click the popup and try again.");
  return text;
}

async function sendClipboard() {
  setBusy(true);
  setProgress("Reading clipboard…");
  try {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        const extension = type.split("/")[1] || "png";
        const file = new File([blob], `clipboard.${extension}`, { type });
        await sendFiles([file], { alreadyBusy: true });
        return;
      }
    } catch {
      // Text fallback below covers browsers that block rich clipboard reads.
    }
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = readClipboardFallback();
    }
    if (!text) throw new Error("Clipboard is empty.");
    await publish({ kind: "text", text, at: Date.now() });
    setProgress("Clipboard sent.");
  } catch (error) {
    setProgress(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function sendFiles(files, options = {}) {
  const list = [...files];
  if (!list.length) {
    setProgress("Choose a file first.", true);
    return;
  }
  if (!options.alreadyBusy) setBusy(true);
  try {
    const setup = await storedSetup();
    if (!setup.code || setup.code.trim().length < 8) throw new Error("Set a shared code of at least 8 characters.");
    const key = await BridgeCrypto.deriveKey(setup.code);
    const room = await BridgeCrypto.roomHash(setup.code);
    const base = setup.relayUrl.replace(/\/$/, "");
    for (const file of list) {
      setProgress(`Encrypting ${file.name}… Keep this popup open.`);
      const encrypted = await BridgeCrypto.encryptBytes(key, new Uint8Array(await file.arrayBuffer()));
      const transferId = crypto.randomUUID();
      setProgress(`Uploading ${file.name}… Keep this popup open.`);
      const response = await fetch(`${base}/v1/files/${transferId}`, {
        method: "PUT",
        headers: { "x-room": room, "content-type": "application/octet-stream" },
        body: encrypted
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error || `Upload failed (${response.status}).`);
      }
      await publish({
        kind: "file",
        transferId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        at: Date.now()
      });
    }
    fileInput.value = "";
    setProgress(list.length === 1 ? "File sent." : `${list.length} files sent.`);
  } catch (error) {
    setProgress(error.message, true);
  } finally {
    if (!options.alreadyBusy) setBusy(false);
  }
}

async function copyText(item, button) {
  await navigator.clipboard.writeText(item.text || "");
  const previous = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = previous;
  }, 1200);
}

async function downloadFile(item, button) {
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const setup = await storedSetup();
    const key = await BridgeCrypto.deriveKey(setup.code);
    const room = await BridgeCrypto.roomHash(setup.code);
    const base = setup.relayUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/v1/files/${item.transferId}`, { headers: { "x-room": room } });
    if (response.status === 404) throw new Error("That file expired. Ask the other computer to send it again.");
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    const plain = await BridgeCrypto.decryptBytes(key, new Uint8Array(await response.arrayBuffer()));
    const url = URL.createObjectURL(new Blob([plain], { type: item.mime || "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = safeName(item.name);
    link.click();
    URL.revokeObjectURL(url);
    button.textContent = "Saved";
  } catch (error) {
    button.textContent = "Download";
    setProgress(error.message, true);
  } finally {
    button.disabled = false;
  }
}

settingsToggle.addEventListener("click", () => {
  settingsOpen = settingsEl.hidden;
  settingsEl.hidden = !settingsOpen;
  settingsToggle.textContent = settingsEl.hidden ? "Setup" : "Hide setup";
});

document.querySelector("#generate").addEventListener("click", () => {
  codeInput.value = generateCode();
  codeInput.focus();
  setProgress("Code generated. Save it, then enter the same code on the other browser.");
});

document.querySelector("#copy-code").addEventListener("click", async () => {
  if (!codeInput.value) return;
  await navigator.clipboard.writeText(codeInput.value);
  setProgress("Code copied.");
});

document.querySelector("#save").addEventListener("click", saveSettings);
document.querySelector("#send-text").addEventListener("click", sendText);
document.querySelector("#send-clip").addEventListener("click", sendClipboard);
document.querySelector("#send-files").addEventListener("click", () => sendFiles(fileInput.files));

textInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    sendText();
  }
});

inboxEl.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || busy) return;
  const item = latestInbox.find((entry) => entry.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.action === "copy") {
    copyText(item, button).catch((error) => setProgress(error.message, true));
  } else if (button.dataset.action === "download") {
    downloadFile(item, button);
  } else if (button.dataset.action === "forget") {
    sendMessage({ type: "forget", id: item.id }).then(refresh);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.inbox) renderInbox(changes.inbox.newValue || []);
});

refresh();
setInterval(refresh, 1500);
