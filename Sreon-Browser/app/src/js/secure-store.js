// Hands out the AES-GCM key for a workspace's encrypted data. With a
// workspace password set, the key only exists in memory while unlocked.
// Without one, a device-local secret is used instead — data is still
// encrypted at rest, just not gated behind something only you know.

(function () {
  "use strict";

  const DEVICE_SECRET_KEY = "sreon:device-secret";
  const SALT_PREFIX = "sreon:wskeysalt:"; // per-workspace PBKDF2 salt, safe to store in the clear

  const memKeys = new Map(); // wsId -> CryptoKey (password-derived, cleared on lock/quit)
  const deviceKeys = new Map(); // wsId -> CryptoKey (device-secret-derived, cached for the process lifetime)

  function getDeviceSecret() {
    let secret = localStorage.getItem(DEVICE_SECRET_KEY);
    if (!secret) {
      secret = SreonCrypto.toB64(SreonCrypto.randomBytes(32));
      localStorage.setItem(DEVICE_SECRET_KEY, secret);
    }
    return secret;
  }

  function saltFor(wsId) {
    const key = SALT_PREFIX + wsId;
    let salt = localStorage.getItem(key);
    if (!salt) {
      salt = SreonCrypto.newSalt();
      localStorage.setItem(key, salt);
    }
    return salt;
  }

  async function deviceKeyFor(wsId) {
    if (deviceKeys.has(wsId)) return deviceKeys.get(wsId);
    const key = await SreonCrypto.deriveKey(getDeviceSecret() + ":" + wsId, saltFor(wsId));
    deviceKeys.set(wsId, key);
    return key;
  }

  async function unlockWithPassword(wsId, password) {
    const key = await SreonCrypto.deriveKey(password, saltFor(wsId));
    memKeys.set(wsId, key);
    return key;
  }

  async function deriveKeyForPassword(wsId, password) {
    return SreonCrypto.deriveKey(password, saltFor(wsId));
  }

  function lock(wsId) {
    memKeys.delete(wsId);
  }

  function isUnlockedWithPassword(wsId) {
    return memKeys.has(wsId);
  }

  async function keyFor(wsId, requiresPassword) {
    if (requiresPassword) {
      if (!memKeys.has(wsId)) throw new Error("workspace-locked");
      return memKeys.get(wsId);
    }
    return deviceKeyFor(wsId);
  }

  window.SecureStore = {
    unlockWithPassword,
    deriveKeyForPassword,
    lock,
    isUnlockedWithPassword,
    keyFor,
  };
})();
