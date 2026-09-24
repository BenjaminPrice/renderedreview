// SPDX-License-Identifier: AGPL-3.0-only
// Deep-link identity for `/<github-host>/<owner>/<repo>/pull/<number>` and its shareable query state.
import type { SearchSchemaInput } from "@tanstack/react-router";

export interface PrParams {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export interface PrSearch {
  files: "changed" | "all";
  /** Selected document path. */
  doc?: string;
  /** Selected comment or thread locator: a numeric comment ID or a node ID. Numbers stay numbers so the URL reads `thread=123`. */
  thread?: string | number;
}

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/;
// GitHub owner and repository names: letters, digits, `-`, `_`, `.`; never `.` or `..`.
const NAME = /^(?!\.\.?$)[\w.-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;

/** Validates raw route params; `undefined` means the route does not exist. */
export function parsePrParams(raw: {
  host: string;
  owner: string;
  repo: string;
  number: string;
}): PrParams | undefined {
  const host = raw.host.toLowerCase();
  if (!HOST.test(host) || !NAME.test(raw.owner) || !NAME.test(raw.repo) || !NUMBER.test(raw.number)) return undefined;
  const number = Number(raw.number);
  if (number > 2 ** 31 - 1) return undefined;
  return { host, owner: raw.owner, repo: raw.repo, number };
}

/** Search input is all optional (`SearchSchemaInput` tells the router), so links may omit it. */
export function validatePrSearch(
  search: { files?: PrSearch["files"]; doc?: string; thread?: string | number } & SearchSchemaInput,
): PrSearch {
  const { thread } = search;
  return {
    files: search.files === "all" ? "all" : "changed",
    ...(typeof search.doc === "string" && search.doc && { doc: search.doc }),
    ...(((typeof thread === "string" && thread) || (typeof thread === "number" && Number.isSafeInteger(thread))) && {
      thread,
    }),
  };
}

/**
 * Parses a GitHub or GitHub Enterprise Server PR URL, e.g. `https://github.com/o/r/pull/1/files`.
 * The scheme may be omitted.
 */
export function parsePullRequestUrl(input: string): PrParams | undefined {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const [owner, repo, pull, number] = url.pathname.split("/").filter(Boolean);
  if (pull !== "pull" || !owner || !repo || !number) return undefined;
  return parsePrParams({ host: url.host.replace(/^www\./, ""), owner, repo, number });
}

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);
