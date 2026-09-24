// SPDX-License-Identifier: AGPL-3.0-only
// Narrow interfaces each runtime (Node, Cloudflare Workers) implements.
// Application code depends on these, never on a platform API directly.
import type { AppConfig } from "./config";

export type SqlValue = string | number | null | Uint8Array;

/**
 * Relational persistence for the control plane. Implemented over D1, PostgreSQL and SQLite,
 * so statements use `?` positional placeholders; adapters translate where the driver differs.
 */
export interface SqlDatabase {
  all<Row = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
}

/** Platform secret storage (environment, Workers secret bindings). Async because some stores are remote. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
}

/** Keeps background work alive after the response is sent (Workers `waitUntil`). */
export interface Scheduler {
  waitUntil(work: Promise<unknown>): void;
}

/** What the server entry hands every request, via TanStack Start's request context. */
export interface RequestContext {
  config: AppConfig;
  secrets: SecretStore;
  scheduler: Scheduler;
}
