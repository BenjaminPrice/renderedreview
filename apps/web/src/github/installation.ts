// SPDX-License-Identifier: AGPL-3.0-only
// Server only: is the GitHub App installed on a repository? `GET /repos/{owner}/{repo}/installation`
// answers in one request but only for an app JWT, signed here with the app's private key through
// WebCrypto (Node and Workers alike). The key and the JWT never leave the server.

// Answers change only when someone installs or removes the app: a short cache saves a request per write.
const TTL_MS = 5 * 60 * 1000;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
const json64 = (value: object) => b64url(new TextEncoder().encode(JSON.stringify(value)));

// DER tag-length-value.
function der(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  // RSA keys stay far below 64 KiB, so two length bytes are enough.
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return new Uint8Array([tag, ...length, ...content]);
}

/** WebCrypto imports only PKCS#8; GitHub issues PKCS#1 ("RSA PRIVATE KEY"), so wrap it. */
function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY")
    ? der(
        0x30,
        new Uint8Array([
          ...[0x02, 0x01, 0x00], // version 0
          // AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1), NULL parameters
          ...[0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00],
          ...der(0x04, body),
        ]),
      )
    : body;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** A GitHub App JWT: issued a minute early for clock drift, expiring inside GitHub's ten-minute limit. */
export async function appJwt(appId: string, privateKeyPem: string | Promise<CryptoKey>, now = Date.now()) {
  const key = typeof privateKeyPem === "string" ? await importPrivateKey(privateKeyPem) : await privateKeyPem;
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${json64({ alg: "RS256", typ: "JWT" })}.${json64({ iss: appId, iat, exp: iat + 600 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}

export type InstallationCheck = (host: string, owner: string, repo: string) => Promise<boolean>;

export function createInstallationCheck({
  appId,
  privateKey,
  fetch: fetchFn = fetch,
}: {
  appId: string;
  privateKey: string;
  fetch?: typeof fetch;
}): InstallationCheck {
  let key: Promise<CryptoKey> | undefined;
  const cache = new Map<string, { installed: boolean; until: number }>();
  return async (host, owner, repo) => {
    // ponytail: the app lives on github.com (sign-in is github.com only); Enterprise Server needs its own app.
    if (host !== "github.com") return false;
    const cacheKey = `${owner}/${repo}`.toLowerCase();
    const hit = cache.get(cacheKey);
    if (hit && hit.until > Date.now()) return hit.installed;
    key ??= importPrivateKey(privateKey);
    const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "rendered-review",
        authorization: `Bearer ${await appJwt(appId, key)}`,
      },
    });
    if (res.status !== 200 && res.status !== 404)
      throw new Error(`GitHub installation check failed: HTTP ${res.status}`);
    const installed = res.status === 200;
    if (cache.size >= 10_000) cache.clear();
    cache.set(cacheKey, { installed, until: Date.now() + TTL_MS });
    return installed;
  };
}
