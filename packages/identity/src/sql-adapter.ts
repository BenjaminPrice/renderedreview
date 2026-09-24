// SPDX-License-Identifier: AGPL-3.0-only
// Better Auth database adapter over the portable SqlDatabase (node:sqlite, PostgreSQL, D1).
// The official adapters need a driver per database (Kysely dialects for pg, SQLite and D1); this
// reuses the adapters the control plane already has. Token columns on `account` are encrypted
// here, on the way in and out, so Better Auth works with plaintext and the table only ever
// holds ciphertext.
import { createAdapterFactory, type CleanedWhere } from "better-auth/adapters";
import type { SqlDatabase, SqlValue } from "@rendered-review/runtime";
import type { TokenCipher } from "./token-cipher";

const TOKEN_COLUMNS = ["accessToken", "refreshToken", "idToken"];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Row = Record<string, unknown>;

function where(clauses: CleanedWhere[] | undefined): { sql: string; params: SqlValue[] } {
  if (!clauses?.length) return { sql: "", params: [] };
  const params: SqlValue[] = [];
  const parts = clauses.map((clause, i) => {
    const column = clause.mode === "insensitive" ? `lower(${quote(clause.field)})` : quote(clause.field);
    const value = (v: unknown) => {
      const bound = (v instanceof Date ? v.toISOString() : typeof v === "boolean" ? Number(v) : v) as SqlValue;
      params.push(clause.mode === "insensitive" && typeof bound === "string" ? bound.toLowerCase() : bound);
      return clause.mode === "insensitive" ? "lower(?)" : "?";
    };
    const ops: Record<string, string> = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
    let condition: string;
    if (clause.operator === "in" || clause.operator === "not_in") {
      const list = clause.value as unknown[];
      // An empty IN list is invalid SQL: `in []` matches nothing, `not_in []` matches everything.
      condition = list.length
        ? `${column} ${clause.operator === "in" ? "IN" : "NOT IN"} (${list.map(value).join(", ")})`
        : clause.operator === "in"
          ? "1 = 0"
          : "1 = 1";
    } else if (clause.value === null && (clause.operator === "eq" || clause.operator === "ne")) {
      condition = `${column} IS ${clause.operator === "eq" ? "" : "NOT "}NULL`;
    } else if (ops[clause.operator]) {
      condition = `${column} ${ops[clause.operator]} ${value(clause.value)}`;
    } else {
      // ponytail: contains/starts_with/ends_with are unused by core auth with social sign-in; LIKE
      // differs in case sensitivity between SQLite and PostgreSQL. Add when a plugin needs them.
      throw new Error(`Unsupported where operator: ${clause.operator}`);
    }
    return i === 0 ? condition : `${clause.connector} ${condition}`;
  });
  return { sql: ` WHERE ${parts.join(" ")}`, params };
}

export function sqlAdapter(db: SqlDatabase, cipher: TokenCipher) {
  const seal = async (model: string, data: Row) => {
    if (model !== "account") return data;
    const out = { ...data };
    for (const column of TOKEN_COLUMNS) {
      if (typeof out[column] === "string") out[column] = await cipher.encrypt(out[column]);
    }
    return out;
  };
  const open = async (model: string, row: Row | undefined) => {
    if (!row || model !== "account") return row;
    const out = { ...row };
    for (const column of TOKEN_COLUMNS) {
      if (typeof out[column] === "string") out[column] = await cipher.decrypt(out[column]);
    }
    return out;
  };
  const assignments = (data: Row) => {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    return { sql: entries.map(([k]) => `${quote(k)} = ?`).join(", "), params: entries.map(([, v]) => v as SqlValue) };
  };

  return createAdapterFactory({
    config: {
      adapterId: "rendered-review-sql",
      // The schema stores timestamps as ISO text and booleans as 0/1 (see the control-plane README).
      supportsDates: false,
      supportsBooleans: false,
      supportsJSON: false,
      supportsNumericIds: false,
      // D1 has no transactions through SqlDatabase; Better Auth then runs operations in sequence.
      transaction: false,
    },
    adapter: () => ({
      async create({ model, data }) {
        const sealed = await seal(model, data);
        const columns = Object.keys(sealed).filter((k) => sealed[k] !== undefined);
        const [row] = await db.all<Row>(
          `INSERT INTO ${quote(model)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING *`,
          columns.map((c) => sealed[c] as SqlValue),
        );
        return (await open(model, row)) as typeof data;
      },
      async update({ model, where: clauses, update }) {
        const set = assignments(await seal(model, update as Row));
        const w = where(clauses);
        const [row] = await db.all<Row>(`UPDATE ${quote(model)} SET ${set.sql}${w.sql} RETURNING *`, [
          ...set.params,
          ...w.params,
        ]);
        return ((await open(model, row)) ?? null) as never;
      },
      async updateMany({ model, where: clauses, update }) {
        const set = assignments(await seal(model, update));
        const w = where(clauses);
        return (await db.run(`UPDATE ${quote(model)} SET ${set.sql}${w.sql}`, [...set.params, ...w.params])).changes;
      },
      async findOne({ model, where: clauses }) {
        const w = where(clauses);
        const [row] = await db.all<Row>(`SELECT * FROM ${quote(model)}${w.sql} LIMIT 1`, w.params);
        return ((await open(model, row)) ?? null) as never;
      },
      async findMany({ model, where: clauses, limit, offset, sortBy }) {
        const w = where(clauses);
        const order = sortBy ? ` ORDER BY ${quote(sortBy.field)} ${sortBy.direction === "desc" ? "DESC" : "ASC"}` : "";
        const rows = await db.all<Row>(`SELECT * FROM ${quote(model)}${w.sql}${order} LIMIT ? OFFSET ?`, [
          ...w.params,
          limit,
          offset ?? 0,
        ]);
        return (await Promise.all(rows.map((row) => open(model, row)))) as never;
      },
      async count({ model, where: clauses }) {
        const w = where(clauses);
        const [row] = await db.all<{ n: number }>(`SELECT count(*) AS n FROM ${quote(model)}${w.sql}`, w.params);
        return Number(row?.n ?? 0);
      },
      async delete({ model, where: clauses }) {
        const w = where(clauses);
        await db.run(`DELETE FROM ${quote(model)}${w.sql}`, w.params);
      },
      async deleteMany({ model, where: clauses }) {
        const w = where(clauses);
        return (await db.run(`DELETE FROM ${quote(model)}${w.sql}`, w.params)).changes;
      },
      // Single-use records (OAuth state): delete-and-return in one statement, so a state cannot be
      // redeemed twice by concurrent callbacks.
      async consumeOne({ model, where: clauses }) {
        const w = where(clauses);
        const [row] = await db.all<Row>(
          `DELETE FROM ${quote(model)} WHERE "id" IN (SELECT "id" FROM ${quote(model)}${w.sql} LIMIT 1) RETURNING *`,
          w.params,
        );
        return ((await open(model, row)) ?? null) as never;
      },
    }),
  });
}
