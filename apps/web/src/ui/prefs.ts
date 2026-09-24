// SPDX-License-Identifier: AGPL-3.0-only
// Per-browser UI preferences in localStorage. They are cosmetic, so storage failures
// (disabled storage, private mode, quota) are ignored and the defaults apply.

export type Theme = "light" | "dark" | "system";
export type RailMode = "pinned" | "collapsed" | "slide";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const THEME = "rr-theme";
const RAIL = "rr-rail";
const CONNECTORS = "rr-connectors";

// Inlined in <head> so a saved theme or collapsed rail applies before first paint (no flash
// after SSR). "system" needs no script: the tokens use light-dark() with color-scheme.
export const PREFS_SCRIPT = `try{var d=document.documentElement,s=localStorage,t=s.getItem("${THEME}");if(t==="light"||t==="dark")d.dataset.theme=t;if(s.getItem("${RAIL}")==="collapsed")d.dataset.rail="collapsed"}catch(e){}`;

function store(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string, s = store()): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null, s = store()) {
  try {
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    // Preference is still applied for this page; it just won't be remembered.
  }
}

export function readTheme(s?: Store | null): Theme {
  const value = read(THEME, s);
  return value === "light" || value === "dark" ? value : "system";
}

export function saveTheme(theme: Theme, root: HTMLElement, s?: Store | null) {
  write(THEME, theme === "system" ? null : theme, s);
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export const nextTheme = (theme: Theme): Theme =>
  theme === "system" ? "light" : theme === "light" ? "dark" : "system";

/** The rail starts pinned at every width; only an explicit collapse is remembered. */
export function readRail(s?: Store | null): "pinned" | "collapsed" {
  return read(RAIL, s) === "collapsed" ? "collapsed" : "pinned";
}

/** The slide-over is transient: opening it does not change the saved pinned/collapsed choice. */
export function saveRail(mode: RailMode, s?: Store | null) {
  if (mode !== "slide") write(RAIL, mode, s);
}

export const readConnectors = (s?: Store | null) => read(CONNECTORS, s) === "on";

export const saveConnectors = (on: boolean, s?: Store | null) => write(CONNECTORS, on ? "on" : "off", s);
