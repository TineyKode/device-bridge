# Device Bridge

A Chrome or Edge extension plus a small relay. It sends text, clipboard contents, and files between browsers on Mac and Windows. The other computer can be asleep or on another network: the relay keeps the encrypted item until that browser comes back, for up to 24 hours.

The shared code is the encryption key. The relay stores ciphertext and never sees the text or file bytes.

## Run the relay

```bash
cd relay
npm install
npm start
```

It listens on port 8787. Check it with `curl http://127.0.0.1:8787/health`.

Useful environment variables:

- `PORT` (default `8787`)
- `DATA_DIR` (default `relay/data`)
- `MAX_FILE_MB` (default `100`)
- `FILE_TTL_HOURS` (default `24`)

`npm test` covers encryption, live delivery, late join, restart, and file expiry.

## Load the extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select the `extension` folder.
4. Pin Device Bridge.

Do this on both computers. Chrome and Edge can both load the same folder.

## Connect two browsers

1. On the computer running the relay, open the popup, choose Generate code, and Save and connect. Leave the relay URL as `http://127.0.0.1:8787`.
2. Find that computer's LAN address with `ipconfig getifaddr en0` on Mac, or `ipconfig` on Windows.
3. On the other computer, set the relay URL to `http://THAT-ADDRESS:8787`, paste the same code, and save.

Try it on one machine first with two browser profiles, or Chrome and Edge, both using `http://127.0.0.1:8787`.

If the other computer cannot connect, allow incoming connections for Node on port 8787 in the firewall.

## Send

- Send text, or press Cmd/Ctrl+Enter.
- Send clipboard. Copied text is sent as text. A copied image is sent as a file.
- Choose files and Send files. Leave the popup open until the upload finishes.
- On the other browser, open the popup. Copy puts text on the clipboard. Download saves the file.

Items wait on the relay when the other browser is closed. The extension shows a notification when something arrives. Files stay for 24 hours, then the relay deletes them. Each room keeps the latest 500 messages.

Across the internet, run the relay on a host both machines can reach and use `https://` so the socket is `wss://`. The code still encrypts the contents.

## Limits

Background clipboard watching is not possible in a browser extension. Sending is a button press. A file download also happens from the open popup, because that is where the extension can decrypt the file and hand it to the browser. Text can be copied later from the received list.
