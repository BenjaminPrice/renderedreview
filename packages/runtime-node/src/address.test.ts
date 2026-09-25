// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { clientAddress } from "./address";

/** A request as Nitro hands it over on Node: srvx exposes the socket's peer address as `ip`. */
const request = (headers: Record<string, string>, ip?: string) =>
  Object.assign(new Request("http://app.example/", { headers }), ip === undefined ? {} : { ip });

describe("clientAddress (Node)", () => {
  it("uses the socket's peer address and ignores a spoofed X-Forwarded-For without configuration", () => {
    expect(clientAddress(request({ "x-forwarded-for": "6.6.6.6" }, "203.0.113.7"), undefined)).toBe("203.0.113.7");
  });

  it("takes the right-most hop of the configured header: the one the operator's proxy appended", () => {
    const req = request({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }, "10.0.0.2");
    expect(clientAddress(req, "x-forwarded-for")).toBe("198.51.100.4");
    expect(clientAddress(request({ "x-real-ip": " 198.51.100.9 " }, "10.0.0.2"), "x-real-ip")).toBe("198.51.100.9");
  });

  it("strips a port some proxies append to the address", () => {
    const via = (value: string) => clientAddress(request({ "x-forwarded-for": value }, "10.0.0.2"), "x-forwarded-for");
    expect(via("6.6.6.6, 198.51.100.4:5678")).toBe("198.51.100.4");
    expect(via("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(via("2001:db8::1")).toBe("2001:db8::1");
  });

  it("falls back to the peer address when the configured header is missing or empty", () => {
    expect(clientAddress(request({}, "10.0.0.2"), "x-forwarded-for")).toBe("10.0.0.2");
    expect(clientAddress(request({ "x-forwarded-for": "1.2.3.4, " }, "10.0.0.2"), "x-forwarded-for")).toBe("10.0.0.2");
  });

  it("is undefined when nothing names the client", () => {
    expect(clientAddress(request({}), undefined)).toBeUndefined();
  });
});
