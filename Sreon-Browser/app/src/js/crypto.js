// AES-256-GCM at rest, key derived from the workspace password via PBKDF2.
// Everything stays local — no server, no network call.

(function () {
  "use strict";

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function fromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  async function deriveKey(password, saltB64) {
    const salt = fromB64(saltB64);
    const material = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function newSalt() {
    return toB64(randomBytes(16));
  }

  async function encryptJSON(key, value) {
    const iv = randomBytes(12);
    const plaintext = enc.encode(JSON.stringify(value));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), iv.length);
    return toB64(combined);
  }

  async function decryptJSON(key, blobB64) {
    const combined = fromB64(blobB64);
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return JSON.parse(dec.decode(plain));
  }

  window.SreonCrypto = { deriveKey, newSalt, encryptJSON, decryptJSON, randomBytes, toB64, fromB64 };
})();
