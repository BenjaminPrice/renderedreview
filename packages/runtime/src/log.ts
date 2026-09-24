// SPDX-License-Identifier: AGPL-3.0-only
// Structured, redacted server logging: one JSON event per call on the console, which Node writes
// to stdout/stderr and Cloudflare Workers Logs indexes. Only allowlisted fields of the expected
// type pass, so tokens, document and comment bodies, annotation payloads, emails and repository
// names cannot reach a log line even when a caller passes them. Web Platform APIs only.

/** The only fields a log event may carry. */
export interface LogFields {
  /** Short machine-readable outcome, e.g. `stale-head`, `reauth`, `network`. */
  category?: string;
  /** An error's class name (see `errorName`), never its message. */
  error?: string;
  outcome?: string;
  host?: string;
  /** A route template such as `/repos/:/:/pulls/:`, never a concrete path. */
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  count?: number;
  rateLimitRemaining?: number;
}

const TYPES: Record<keyof LogFields, "string" | "number"> = {
  category: "string",
  error: "string",
  outcome: "string",
  host: "string",
  route: "string",
  method: "string",
  status: "number",
  durationMs: "number",
  count: "number",
  rateLimitRemaining: "number",
};
// No spaces, `@`, `?`, `=` or quotes: rules out prose, emails and query strings.
const SAFE_STRING = /^[\w.:/*-]*$/;
const MAX_STRING = 100;
const EVENT = /^[a-z][\w.-]{0,63}$/;
// Workers Logs indexes the fields of a logged object; elsewhere a JSON line is the portable form.
const WORKERS = () =>
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";

function redact(fields: LogFields): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    const type = TYPES[key as keyof LogFields];
    if (!Object.hasOwn(TYPES, key) || typeof value !== type) continue;
    if (typeof value === "string" ? SAFE_STRING.test(value) : Number.isFinite(value))
      out[key] = typeof value === "string" ? value.slice(0, MAX_STRING) : Math.round(value as number);
  }
  return out;
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields = {}) {
  const entry = { level, event: EVENT.test(event) ? event : "invalid-event", ...redact(fields) };
  console[level](WORKERS() ? entry : JSON.stringify(entry));
}

export const log = {
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};

/** An error's class name, safe to log; messages may quote tokens, paths or bodies. */
export const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
