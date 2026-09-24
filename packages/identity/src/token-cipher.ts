// SPDX-License-Identifier: AGPL-3.0-only
// Application-layer encryption for persisted provider tokens: AES-256-GCM through Web Crypto.
// Stored form is `<key id>:<base64(iv || ciphertext+tag)>`. The key id (first 4 bytes of the
// key's SHA-256, hex) tells decrypt which key wrote a row, so a rotated-out key keeps working.

export interface TokenCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(stored: string): Promise<string>;
}

const IV_BYTES = 12;
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function importKey(base64: string) {
  const raw = fromBase64(base64);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const id = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { id, key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
}

/** `key` encrypts and decrypts; `previousKey` (being rotated out) only decrypts. Both base64 of 32 bytes. */
export async function createTokenCipher(key: string, previousKey?: string): Promise<TokenCipher> {
  const current = await importKey(key);
  const keys = new Map([[current.id, current.key]]);
  if (previousKey) {
    const previous = await importKey(previousKey);
    keys.set(previous.id, previous.key);
  }
  return {
    async encrypt(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, current.key, new TextEncoder().encode(plaintext)),
      );
      const out = new Uint8Array(IV_BYTES + sealed.length);
      out.set(iv);
      out.set(sealed, IV_BYTES);
      return `${current.id}:${toBase64(out)}`;
    },
    async decrypt(stored) {
      const [id = "", body = ""] = stored.split(":");
      const key = keys.get(id);
      // Never echo the stored value: it is ciphertext, but keep token material out of errors entirely.
      if (!key) throw new Error(`Token was encrypted with an unknown encryption key (${id || "no key id"})`);
      const bytes = fromBase64(body);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
        key,
        bytes.slice(IV_BYTES),
      );
      return new TextDecoder().decode(plain);
    },
  };
}
