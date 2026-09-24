// SPDX-License-Identifier: AGPL-3.0-only
import GithubSlugger from "github-slugger";
import type { Element, Root } from "hast";
import { toString } from "hast-util-to-string";

/** Where a document was read from. Repository-relative URLs resolve against it. */
export interface DocumentLocation {
  /** GitHub web host (served over https): `github.com` or a GitHub Enterprise Server host. */
  host: string;
  owner: string;
  repo: string;
  /** Commit the blob was read at. Relative images and links resolve to this immutable commit. */
  commitOid: string;
  /** Repository path of the document, e.g. `docs/rfd/0042.md`. */
  path: string;
}

export interface ResourceOptions {
  /** Without a location, relative links are left untouched and relative images are dropped. */
  location?: DocumentLocation;
  /**
   * URL for a repository image. `path` is the decoded repository path (no leading slash).
   * Return `undefined` for the default: the raw file at `commitOid`.
   */
  resolveImage?: (path: string) => string | undefined;
  /**
   * URL for a repository link, e.g. an in-app route for Markdown files. `path` is the decoded
   * repository path (`""` is the root, a trailing `/` marks a directory); `suffix` is the
   * original `?query#hash` or `""`. Return `undefined` for the default: the GitHub blob (or
   * tree) URL at `commitOid`.
   */
  resolveLink?: (path: string, suffix: string) => string | undefined;
}

const PREFIX = "user-content-";

/**
 * Image origins that load without a click, as CSP source expressions. Everything else is an
 * external image and stays unloaded (see `docs/privacy-external-resources.md`). The app's
 * `img-src` directive is built from the same list, so the two cannot drift apart.
 */
export function githubContentOrigins(host: string): string[] {
  return host === "github.com"
    ? ["https://github.com", "https://*.githubusercontent.com"]
    : [`https://${host}`, `https://*.${host}`];
}

function isTrusted(url: URL, host: string): boolean {
  return (
    url.protocol === "https:" &&
    githubContentOrigins(host).some((origin) => {
      const pattern = origin.slice("https://".length);
      return pattern.startsWith("*.") ? url.host.endsWith(pattern.slice(1)) : url.host === pattern;
    })
  );
}

type Ref =
  | { kind: "anchor"; fragment: string }
  | { kind: "absolute"; url: URL }
  | { kind: "repo"; path: string; suffix: string }
  | { kind: "invalid" };

/**
 * Classify a URL from the document. Repository-relative paths are resolved here rather than
 * with `URL`, because `URL` silently clamps `..` at the root; any path that would climb out of
 * the repository is `invalid`.
 */
function classify(raw: string, location: DocumentLocation | undefined): Ref {
  // Mirror the URL parser: drop tab/newline anywhere, trim C0 controls and spaces, `\` is `/`.
  const ref = raw.replace(/[\t\n\r]/g, "").replace(/^[\0- ]+|[\0- ]+$/g, "");
  if (ref.startsWith("#")) return { kind: "anchor", fragment: ref.slice(1) };
  const slashed = ref.replaceAll("\\", "/");
  if (/^[a-z][a-z\d+.-]*:/i.test(ref) || slashed.startsWith("//")) {
    const url = URL.parse(slashed.startsWith("//") ? `https:${slashed}` : ref);
    return url ? { kind: "absolute", url } : { kind: "invalid" };
  }
  if (!location) return { kind: "invalid" };

  const [, pathPart = "", suffix = ""] = /^([^?#]*)(.*)$/s.exec(slashed)!;
  const stack = pathPart.startsWith("/") ? [] : location.path.split("/").slice(0, -1);
  const segments = pathPart.split("/");
  for (const [i, segment] of segments.entries()) {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return { kind: "invalid" };
    }
    if (/[/\\]/.test(name)) return { kind: "invalid" };
    if (name === "..") {
      if (!stack.pop()) return { kind: "invalid" };
    } else if (name && name !== ".") stack.push(name);
    // `dir/`, `.` and `..` all name a directory.
    if (i === segments.length - 1 && (!name || name === "." || name === "..") && stack.length) stack.push("");
  }
  return { kind: "repo", path: stack.join("/"), suffix };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Only http(s) URLs and same-origin paths may come back from a resolver. */
function safe(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (/^\/(?![/\\])/.test(url) && !/[\t\n\r]/.test(url)) return url;
  const parsed = URL.parse(url);
  return parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") ? parsed.href : undefined;
}

function repoBase({ host, owner, repo }: DocumentLocation) {
  return `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function defaultImage(location: DocumentLocation, path: string): string {
  const { host, owner, repo, commitOid } = location;
  return host === "github.com"
    ? `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commitOid}/${encodePath(path)}`
    : `${repoBase(location)}/raw/${commitOid}/${encodePath(path)}`;
}

function defaultLink(location: DocumentLocation, path: string, suffix: string): string {
  const kind = path === "" || path.endsWith("/") ? "tree" : "blob";
  return `${repoBase(location)}/${kind}/${location.commitOid}/${encodePath(path)}${suffix}`;
}

/** Resolved image URL, or `undefined` when the image must not load automatically. */
function imageUrl(raw: string, options: ResourceOptions): { url: string } | { external: URL } | undefined {
  const ref = classify(raw, options.location);
  const host = options.location?.host ?? "github.com";
  if (ref.kind === "absolute") return isTrusted(ref.url, host) ? { url: ref.url.href } : { external: ref.url };
  if (ref.kind !== "repo" || ref.path === "" || ref.path.endsWith("/")) return undefined;
  const url = safe(options.resolveImage?.(ref.path)) ?? defaultImage(options.location!, ref.path);
  return { url };
}

/**
 * Rewrite URLs in a sanitized tree. Runs after sanitization, so it only ever emits values it
 * built itself or re-validated: https raw/blob URLs, `#user-content-*` anchors, or resolver
 * results that pass `safe`.
 *
 * - `#frag` becomes `#user-content-frag`, matching the ids the sanitizer prefixes, and headings
 *   without an id get GitHub's slug (`user-content-<slug>`).
 * - Repository-relative links and images resolve to `location.commitOid`; paths escaping the
 *   repository lose their URL.
 * - External images do not load: they become a link to the image (or plain text inside an
 *   existing link) showing the image's host.
 */
export function resolveResources(tree: Root, options: ResourceOptions): void {
  const slugger = new GithubSlugger();

  const visit = (el: Element, inLink: boolean) => {
    const props = el.properties;
    if (/^h[1-6]$/.test(el.tagName) && props.id === undefined) props.id = PREFIX + slugger.slug(toString(el));

    if (el.tagName === "a" && typeof props.href === "string") {
      const ref = classify(props.href, options.location);
      if (ref.kind === "anchor") {
        if (ref.fragment && !ref.fragment.startsWith(PREFIX)) props.href = `#${PREFIX}${ref.fragment}`;
      } else if (ref.kind === "repo") {
        props.href =
          safe(options.resolveLink?.(ref.path, ref.suffix)) ?? defaultLink(options.location!, ref.path, ref.suffix);
      } else if (ref.kind === "invalid" && options.location) {
        delete props.href;
      }
    }

    if (el.tagName === "img" && typeof props.src === "string") {
      const resolved = imageUrl(props.src, options);
      if (!resolved) delete props.src;
      else if ("url" in resolved) props.src = resolved.url;
      else {
        const alt = typeof props.alt === "string" && props.alt ? props.alt : "Image";
        const label = `${alt} (external image from ${resolved.external.host})`;
        el.children = [{ type: "text", value: label }];
        if (inLink) {
          el.tagName = "span";
          el.properties = { dataRrExternalImage: resolved.external.href, title: resolved.external.href };
        } else {
          el.tagName = "a";
          el.properties = {
            href: resolved.external.href,
            target: "_blank",
            rel: ["noreferrer"],
            dataRrExternalImage: resolved.external.href,
          };
        }
      }
    }

    if (el.tagName === "source" && typeof props.srcSet === "string") {
      const candidates = props.srcSet.split(",").map((candidate) => {
        const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
        const resolved = imageUrl(url, options);
        return resolved && "url" in resolved ? [resolved.url, ...descriptor].join(" ") : undefined;
      });
      if (candidates.every(Boolean)) props.srcSet = candidates.join(", ");
      else delete props.srcSet;
    }

    for (const child of el.children) if (child.type === "element") visit(child, inLink || el.tagName === "a");
  };
  for (const child of tree.children) if (child.type === "element") visit(child, false);
}
