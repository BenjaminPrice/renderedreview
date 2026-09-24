// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  nextTheme,
  PREFS_SCRIPT,
  readConnectors,
  readRail,
  readTheme,
  saveConnectors,
  saveRail,
  saveTheme,
} from "./prefs";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const broken = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const fakeRoot = () => ({ dataset: {} as DOMStringMap }) as HTMLElement;

describe("theme", () => {
  it("defaults to system and ignores unknown values", () => {
    expect(readTheme(memory())).toBe("system");
    expect(readTheme(memory({ "rr-theme": "sepia" }))).toBe("system");
    expect(readTheme(broken)).toBe("system");
  });

  it("persists an explicit choice and applies it to the root", () => {
    const s = memory();
    const root = fakeRoot();
    saveTheme("dark", root, s);
    expect(root.dataset.theme).toBe("dark");
    expect(readTheme(s)).toBe("dark");
    saveTheme("system", root, s);
    expect(root.dataset.theme).toBeUndefined();
    expect(s.data.has("rr-theme")).toBe(false);
  });

  it("still applies when storage fails", () => {
    const root = fakeRoot();
    saveTheme("light", root, broken);
    expect(root.dataset.theme).toBe("light");
  });

  it("cycles system -> light -> dark -> system", () => {
    expect([nextTheme("system"), nextTheme("light"), nextTheme("dark")]).toEqual(["light", "dark", "system"]);
  });
});

describe("rail", () => {
  it("starts pinned unless the user collapsed it", () => {
    expect(readRail(memory())).toBe("pinned");
    expect(readRail(broken)).toBe("pinned");
    expect(readRail(memory({ "rr-rail": "collapsed" }))).toBe("collapsed");
  });

  it("remembers pinned/collapsed but not the transient slide-over", () => {
    const s = memory();
    saveRail("collapsed", s);
    saveRail("slide", s);
    expect(readRail(s)).toBe("collapsed");
    saveRail("pinned", s);
    expect(readRail(s)).toBe("pinned");
  });
});

describe("connectors", () => {
  it("defaults off and persists", () => {
    const s = memory();
    expect(readConnectors(s)).toBe(false);
    saveConnectors(true, s);
    expect(readConnectors(s)).toBe(true);
    saveConnectors(false, s);
    expect(readConnectors(s)).toBe(false);
  });
});

describe("PREFS_SCRIPT (pre-paint)", () => {
  function run(localStorage: unknown) {
    const documentElement = fakeRoot();
    new Function("document", "localStorage", PREFS_SCRIPT)({ documentElement }, localStorage);
    return documentElement.dataset;
  }

  it("applies saved theme and collapsed rail", () => {
    expect(run(memory({ "rr-theme": "dark", "rr-rail": "collapsed" }))).toEqual({ theme: "dark", rail: "collapsed" });
  });

  it("leaves defaults (system theme, pinned rail) untouched", () => {
    expect(run(memory({ "rr-theme": "sepia", "rr-rail": "pinned" }))).toEqual({});
    expect(run(broken)).toEqual({});
  });
});
