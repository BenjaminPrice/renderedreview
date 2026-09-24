// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { encodeAnnotation, extractAnnotation, MAX_ENCODED_LENGTH } from "./envelope.js";
import { sampleAnnotation } from "./fixtures.js";

const withExact = (exact: string) => {
  const a = sampleAnnotation();
  a.target.selectors[0] = { type: "TextQuoteSelector", exact };
  return a;
};

/** Marker around an arbitrary payload, for damaged-envelope tests. */
const marker = (payload: string, version = "1") => `<!-- rendered-review:v${version}:${payload} -->`;
const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const utf8Base64 = (text: string) => base64([...new TextEncoder().encode(text)]);

describe("encodeAnnotation", () => {
  it("wraps compact JSON as single-line standard Base64 in an HTML comment", () => {
    const encoded = encodeAnnotation(sampleAnnotation());
    expect(encoded).toMatch(/^<!-- rendered-review:v1:[A-Za-z0-9+/]+={0,2} -->$/);
    const payload = encoded.slice("<!-- rendered-review:v1:".length, -" -->".length);
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    expect(json).toBe(JSON.stringify(sampleAnnotation()));
  });

  it("rejects an annotation that fails the schema", () => {
    expect(() => encodeAnnotation(withExact(""))).toThrow(TypeError);
  });

  it("rejects an annotation whose encoding exceeds the size limit", () => {
    expect(() => encodeAnnotation(withExact("x".repeat(MAX_ENCODED_LENGTH)))).toThrow(RangeError);
  });
});

describe("extractAnnotation", () => {
  it.each([
    ["ASCII", "retries failed requests"],
    ["accents and CJK", "Déjà vu — 重试策略"],
    ["emoji and astral characters", "ship it 🚢👩🏽‍💻 𝔘𝔫𝔦𝔠𝔬𝔡𝔢"],
    ["right-to-left and combining marks", "שלום é"],
    ["quotes, HTML and comment delimiters", `"<!-- -->" & 'x' </script>`],
  ])("round-trips %s", (_name, exact) => {
    const annotation = withExact(exact);
    const encoded = encodeAnnotation(annotation);
    const body = `> ${exact}\n\nComment\n\n${encoded}\n`;
    const result = extractAnnotation(body);
    expect(result).toEqual({
      status: "ok",
      annotation,
      markerRange: { start: body.indexOf(encoded), end: body.indexOf(encoded) + encoded.length },
    });
  });

  it("reports none when there is no marker", () => {
    expect(extractAnnotation("Looks good to me.")).toEqual({ status: "none" });
    expect(extractAnnotation("")).toEqual({ status: "none" });
  });

  it("does not treat the PR-link marker as an annotation", () => {
    expect(extractAnnotation("Review this PR\n\n<!-- rendered-review-link:v1 -->")).toEqual({ status: "none" });
  });

  it("uses the last marker in the body", () => {
    const first = encodeAnnotation(sampleAnnotation({ motivation: "replying" }));
    const last = encodeAnnotation(sampleAnnotation());
    const result = extractAnnotation(`${first}\n\ntext\n\n${last}`);
    expect(result.status === "ok" && result.annotation.motivation).toBe("commenting");
  });

  it("tolerates surrounding whitespace and CRLF line endings", () => {
    const encoded = encodeAnnotation(sampleAnnotation());
    expect(extractAnnotation(`Comment\r\n\r\n  ${encoded}  \r\n\r\n`).status).toBe("ok");
  });

  it("reports an unknown version as unsupported", () => {
    expect(extractAnnotation(marker("eyJ9", "2"))).toEqual({ status: "unsupported", version: 2 });
  });

  it.each([
    ["a space inside the payload", marker(encodeAnnotation(sampleAnnotation()).slice(24, 60) + " " + "AAAA")],
    ["a line break inside the payload", encodeAnnotation(sampleAnnotation()).replace(/(.{76})/, "$1\n")],
    ["URL-safe Base64 characters", marker("ab-_")],
    ["misplaced padding", marker("ab=c")],
    ["a length that is not a multiple of four", marker("abc")],
    ["an empty payload", marker("")],
    ["invalid UTF-8", marker(base64([0x7b, 0xff, 0xfe, 0x7d]))],
    ["invalid JSON", marker(utf8Base64("{not json"))],
    ["JSON that is not an annotation", marker(utf8Base64('{"version":1}'))],
    ["a missing closing delimiter", encodeAnnotation(sampleAnnotation()).slice(0, -4)],
    ["no space before the closing delimiter", encodeAnnotation(sampleAnnotation()).replace(" -->", "-->")],
    ["a malformed version", marker("eyJ9", "1x")],
    ["an oversized payload", marker("A".repeat(MAX_ENCODED_LENGTH + 4))],
  ])("reports damaged metadata for %s", (_name, body) => {
    expect(extractAnnotation(`Comment\n\n${body}`)).toMatchObject({ status: "damaged", reason: expect.any(String) });
  });

  describe("fuzzing", () => {
    // Small deterministic PRNG so failures reproduce.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = "<!-- rendered-review:v1: -->AZaz09+/=\n\r\t é🚢\u0000";
    const randomString = (length: number) =>
      Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");

    it("never throws on random input", () => {
      for (let i = 0; i < 2000; i++) {
        const body = randomString(Math.floor(random() * 200));
        expect(() => extractAnnotation(body)).not.toThrow();
      }
    });

    it("never throws on random payloads inside a well-formed envelope", () => {
      for (let i = 0; i < 2000; i++) {
        const result = extractAnnotation(marker(randomString(Math.floor(random() * 100)).replace(/-->/g, "")));
        expect(["damaged", "none"]).toContain(result.status);
      }
    });

    it("reports every truncation of a valid marker as damaged or none", () => {
      const encoded = encodeAnnotation(sampleAnnotation());
      for (let cut = 0; cut < encoded.length; cut++) {
        expect(["damaged", "none"]).toContain(extractAnnotation(encoded.slice(0, cut)).status);
      }
    });

    it("stays fast on huge inputs", () => {
      const huge = [
        "x".repeat(5_000_000),
        "<!-- rendered-review:v".repeat(200_000),
        "<!-- rendered-review:v1:" + "A".repeat(5_000_000),
        "<!-- rendered-review:v1:" + "A".repeat(5_000_000) + " -->",
      ];
      const started = performance.now();
      for (const body of huge) expect(extractAnnotation(body).status).not.toBe("ok");
      expect(performance.now() - started).toBeLessThan(500);
    });
  });
});
