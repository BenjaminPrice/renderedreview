// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { createTokenCipher } from "./token-cipher";

const oldKey = btoa("o".repeat(32));
const newKey = btoa("n".repeat(32));
const token = "ghu_plaintextUserToken123";

describe("createTokenCipher", () => {
  it("round-trips a token through key-tagged AES-GCM ciphertext", async () => {
    const cipher = await createTokenCipher(newKey);
    const stored = await cipher.encrypt(token);
    expect(stored).not.toContain(token);
    expect(stored).toMatch(/^[0-9a-f]{8}:[A-Za-z0-9+/]+=*$/);
    expect(await cipher.encrypt(token)).not.toBe(stored); // fresh IV every time
    expect(await cipher.decrypt(stored)).toBe(token);
  });

  it("rejects tampered ciphertext", async () => {
    const cipher = await createTokenCipher(newKey);
    const stored = await cipher.encrypt(token);
    const [kid, body] = stored.split(":") as [string, string];
    const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 1;
    await expect(cipher.decrypt(`${kid}:${btoa(String.fromCharCode(...bytes))}`)).rejects.toThrow();
  });

  it("decrypts rows written under the previous key and encrypts only with the current one", async () => {
    const stored = await (await createTokenCipher(oldKey)).encrypt(token);
    const rotated = await createTokenCipher(newKey, oldKey);
    expect(await rotated.decrypt(stored)).toBe(token);
    const reencrypted = await rotated.encrypt(token);
    expect(reencrypted.split(":")[0]).not.toBe(stored.split(":")[0]);
    expect(await (await createTokenCipher(newKey)).decrypt(reencrypted)).toBe(token);
    await expect((await createTokenCipher(newKey)).decrypt(stored)).rejects.toThrow(/unknown encryption key/);
  });
});
