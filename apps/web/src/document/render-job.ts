// SPDX-License-Identifier: AGPL-3.0-only
// Rendering one document blob: pure, and its input and output are plain data, so it runs the
// same on the main thread and in the render Worker (./render-worker.ts).
import { renderMarkdown, type RenderedMarkdown } from "@rendered-review/markdown-domain";
import { isMarkdownPath } from "../pr-url";
import type { PrIdentity } from "../github/queries";

type PrRef = Pick<PrIdentity, "host" | "owner" | "repo" | "number">;

export interface RenderJob {
  source: string;
  pr: PrRef;
  /** Commit the blob was read at; relative links and images resolve there. */
  sha: string;
  path: string;
}

/** In-app route for a repository Markdown file; other links keep GitHub's default. */
export function inAppDocLink(id: PrRef, path: string, suffix: string): string | undefined {
  if (!isMarkdownPath(path)) return undefined;
  const hash = suffix.includes("#") ? suffix.slice(suffix.indexOf("#")) : "";
  return `/${id.host}/${id.owner}/${id.repo}/pull/${id.number}?${new URLSearchParams({ doc: path })}${hash}`;
}

/** Relative links and images resolve at `sha`; Markdown links open in this PR. `.mdx` throws its parse error when invalid. */
export function renderJob({ source, pr, sha, path }: RenderJob): RenderedMarkdown {
  return renderMarkdown(source, {
    location: { host: pr.host, owner: pr.owner, repo: pr.repo, commitOid: sha, path },
    resolveLink: (target, suffix) => inAppDocLink(pr, target, suffix),
    format: /\.mdx$/i.test(path) ? "mdx" : "md",
  });
}
