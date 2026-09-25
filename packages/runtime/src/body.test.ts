// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { readBodyCapped } from "./body";

const streamed = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
  new Request("https://rr.example/", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);

describe("readBodyCapped", () => {
  it("returns a body at the cap, and undefined one byte over", async () => {
    expect(await readBodyCapped(streamed([new Uint8Array(4), new Uint8Array(4)]), 8)).toEqual(new Uint8Array(8));
    expect(await readBodyCapped(streamed([new Uint8Array(4), new Uint8Array(5)]), 8)).toBeUndefined();
  });

  it("does not trust a Content-Length that understates the body", async () => {
    const lying = streamed([new Uint8Array(6), new Uint8Array(6)], { "content-length": "3" });
    expect(await readBodyCapped(lying, 8)).toBeUndefined();
  });

  it("refuses a declared Content-Length over the cap without reading", async () => {
    const req = new Request("https://rr.example/", {
      method: "POST",
      headers: { "content-length": "20" },
      body: "x".repeat(20),
    });
    expect(await readBodyCapped(req, 8)).toBeUndefined();
    expect(req.bodyUsed).toBe(false);
  });

  it("keeps a multibyte character split across chunks intact", async () => {
    const bytes = new TextEncoder().encode("a€b"); // € is e2 82 ac
    const body = await readBodyCapped(streamed([bytes.subarray(0, 2), bytes.subarray(2)]), 100);
    expect(new TextDecoder().decode(body)).toBe("a€b");
  });

  it("reads an empty body as no bytes", async () => {
    expect(await readBodyCapped(new Request("https://rr.example/", { method: "POST" }), 8)).toEqual(new Uint8Array());
  });
});
