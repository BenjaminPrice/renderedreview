// SPDX-License-Identifier: AGPL-3.0-only

export interface RenderedReviewAnnotationV1 {
  version: 1;
  target: {
    githubHost: string;
    repositoryId: number;
    repository: string;
    pullRequest: number;
    path: string;
    commitOid: string;
    blobOid: string;
    selectors: AnnotationSelector[];
    structure?: { nodeType?: string; headingPath?: string[] };
  };
  motivation: "commenting" | "replying" | "suggesting" | "resolving";
  replyTo?: string;
  threadId?: string;
  /** With motivation `resolving`: `reopened` reopens the thread; absent means resolved. */
  resolution?: "resolved" | "reopened";
  createdBy?: "rendered-review";
}

export type AnnotationSelector =
  | { type: "TextQuoteSelector"; exact: string; prefix?: string; suffix?: string }
  | { type: "TextPositionSelector"; start: number; end: number }
  | { type: "MarkdownSourceRangeSelector"; startLine: number; startColumn: number; endLine: number; endColumn: number };

export type ValidationResult = { ok: true; annotation: RenderedReviewAnnotationV1 } | { ok: false; reason: string };

/** Longest `prefix` / `suffix` context, in UTF-16 code units. */
export const MAX_CONTEXT_LENGTH = 64;

const MOTIVATIONS = new Set(["commenting", "replying", "suggesting", "resolving"]);
const SELECTOR_TYPES = ["TextQuoteSelector", "TextPositionSelector", "MarkdownSourceRangeSelector"] as const;
// Host name with optional port; never a scheme, path, or credentials (it is used to build permalinks).
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHAR = /[\\\u0000-\u001f\u007f]/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
// SHA-1 or SHA-256 object ids, lowercase hex as GitHub returns them.
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class Invalid extends Error {}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function fail(reason: string): never {
  throw new Invalid(reason);
}
function object(v: unknown, name: string): Obj {
  return isObject(v) ? v : fail(`${name} must be an object`);
}
function int(v: unknown, name: string, min: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min)
    fail(`${name} must be a ${min === 0 ? "non-negative" : "positive"} integer`);
  return v as number;
}
function str(v: unknown, name: string, pattern?: RegExp, maxLength = Infinity): string {
  if (typeof v !== "string" || v === "" || v.length > maxLength || (pattern && !pattern.test(v)))
    fail(
      `${name} must be a${pattern ? " valid" : " non-empty"} string${maxLength < Infinity ? ` of at most ${maxLength} characters` : ""}`,
    );
  return v;
}
function optional<T>(v: unknown, check: (v: unknown) => T): T | undefined {
  return v === undefined ? undefined : check(v);
}

function selector(s: Obj, name: string): void {
  switch (s.type) {
    case "TextQuoteSelector":
      str(s.exact, `${name}.exact`);
      for (const key of ["prefix", "suffix"]) {
        const v = s[key];
        if (v !== undefined && (typeof v !== "string" || v.length > MAX_CONTEXT_LENGTH))
          fail(`${name}.${key} must be a string of at most ${MAX_CONTEXT_LENGTH} characters`);
      }
      return;
    case "TextPositionSelector":
      if (int(s.end, `${name}.end`, 0) < int(s.start, `${name}.start`, 0)) fail(`${name}.end must not precede start`);
      return;
    case "MarkdownSourceRangeSelector": {
      const startLine = int(s.startLine, `${name}.startLine`, 1);
      const startColumn = int(s.startColumn, `${name}.startColumn`, 1);
      const endLine = int(s.endLine, `${name}.endLine`, 1);
      const endColumn = int(s.endColumn, `${name}.endColumn`, 1);
      if (endLine < startLine || (endLine === startLine && endColumn < startColumn))
        fail(`${name} end must not precede start`);
    }
  }
}

/**
 * Check that a decoded value is a version 1 annotation.
 *
 * Wrong types, missing required fields, out-of-range numbers and malformed identifiers are rejected.
 * Unknown fields and unknown selector types are ignored (not removed) so that later minor additions
 * to version 1 stay readable by older readers. Each of the three known selector types must appear
 * exactly once, in any order.
 */
export function validateAnnotation(value: unknown): ValidationResult {
  try {
    const a = object(value, "annotation");
    if (a.version !== 1) fail("version must be 1");
    const t = object(a.target, "target");
    str(t.githubHost, "target.githubHost", HOST, 253);
    int(t.repositoryId, "target.repositoryId", 1);
    str(t.repository, "target.repository", REPOSITORY, 201);
    int(t.pullRequest, "target.pullRequest", 1);
    const path = str(t.path, "target.path");
    // Used to build links and pick documents: plain repository-relative segments only.
    if (UNSAFE_PATH_CHAR.test(path) || path.split("/").some((seg) => seg === "" || seg === "." || seg === ".."))
      fail(
        "target.path must be repository-relative, without empty, . or .. segments, backslashes or control characters",
      );
    str(t.commitOid, "target.commitOid", OID);
    str(t.blobOid, "target.blobOid", OID);
    if (!Array.isArray(t.selectors)) fail("target.selectors must be an array");
    for (const type of SELECTOR_TYPES) {
      const matches = t.selectors.filter((s) => isObject(s) && s.type === type) as Obj[];
      if (matches.length !== 1) fail(`target.selectors must contain exactly one ${type}`);
      selector(matches[0]!, `target.selectors.${type}`);
    }
    const structure = optional(t.structure, (v) => object(v, "target.structure"));
    if (structure) {
      optional(structure.nodeType, (v) => str(v, "target.structure.nodeType"));
      optional(structure.headingPath, (v) => {
        if (!Array.isArray(v) || !v.every((h) => typeof h === "string"))
          fail("target.structure.headingPath must be an array of strings");
      });
    }
    if (!MOTIVATIONS.has(a.motivation as string))
      fail("motivation must be commenting, replying, suggesting or resolving");
    optional(a.replyTo, (v) => str(v, "replyTo"));
    optional(a.threadId, (v) => str(v, "threadId"));
    if (a.resolution !== undefined && a.resolution !== "resolved" && a.resolution !== "reopened")
      fail('resolution must be "resolved" or "reopened"');
    if (a.createdBy !== undefined && a.createdBy !== "rendered-review") fail('createdBy must be "rendered-review"');
    return { ok: true, annotation: value as RenderedReviewAnnotationV1 };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.message };
    throw error;
  }
}
