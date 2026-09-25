// SPDX-License-Identifier: AGPL-3.0-only
// Reads the built site (dist/) for the tests.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { JSDOM } from "jsdom";

export const DIST = new URL("../dist/", import.meta.url).pathname;

/** Every built HTML page, as its URL path ("/", "/pricing/", "/404.html"). */
export function pages(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : [],
    );
  return walk(DIST)
    .map((file) => "/" + relative(DIST, file))
    .map((path) => path.replace(/(^|\/)index\.html$/, "$1"))
    .sort();
}

/** The file serving a URL path, as Cloudflare static assets resolve it; undefined when none. */
export function fileFor(path: string): string | undefined {
  const clean = decodeURIComponent(path.replace(/[?#].*$/, ""));
  const candidates = clean.endsWith("/")
    ? [join(DIST, clean, "index.html")]
    : [join(DIST, clean), join(DIST, clean, "index.html"), join(DIST, `${clean}.html`)];
  return candidates.find((f) => existsSync(f) && !f.endsWith("/"));
}

export const read = (path: string) => readFileSync(fileFor(path) ?? join(DIST, path), "utf8");

export function page(path: string): Document {
  return new JSDOM(read(path), { url: `https://renderedreview.com${path}` }).window.document;
}
