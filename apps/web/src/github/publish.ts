// SPDX-License-Identifier: AGPL-3.0-only
// The write boundary: publishes comments to GitHub for the signed-in user. The browser composes
// bodies and locations; this checks them (CSRF, session, repository access, PR head, sizes,
// annotation target, representation) and publishes with the least-privileged credential. It does
// not rerun rendering: GitHub is the final authority on native locations. Server only; bodies and
// tokens are never logged. Web Request/Response/fetch only.
import {
  extractAnnotation,
  type RenderedReviewAnnotationV1,
  repairCommentBody,
} from "@rendered-review/annotation-domain";
import {
  createGitHubClient,
  ForbiddenError,
  type GitHubClient,
  GitHubError,
  type LineRange,
  type PullRequest,
  RateLimitError,
} from "@rendered-review/github-integration";
import type { Identity } from "@rendered-review/identity";
import { anchorLines } from "@rendered-review/review-domain";
import { log, readBodyCapped } from "@rendered-review/runtime";
import type { EntitlementCheck } from "../billing";
import { forRepository, type WriteOperation } from "./broker";
import type { InstallationCheck } from "./installation";
import { meteredFetch } from "./metrics";
import { parseProxyPath, REPO_SEGMENT } from "./proxy";
import { NOT_ENTITLED, REQUESTED_WITH } from "./user-proxy";

export const WRITE_PREFIX = "/api/github/write/";

/** GitHub's limit on a comment body, in characters. */
export const MAX_BODY_LENGTH = 65_536;
const MAX_REQUEST_BYTES = 1024 * 1024;

export type Representation = "review-line" | "review-file" | "conversation";

/** Error codes the client acts on; the JSON body is `{ code, message, ...extra }`. */
export type PublishErrorCode =
  | "csrf"
  | "unsupported-media-type"
  | "not-found"
  | "unauthenticated"
  | "reauth"
  | "needs-public-authorization"
  | "private-repo-unsupported"
  | "not-entitled"
  | "unavailable"
  | "stale-head"
  | "invalid-request"
  | "request-too-large"
  | "body-too-large"
  | "invalid-annotation"
  | "annotation-mismatch"
  | "thread-mismatch"
  | "not-author"
  | "comment-changed"
  | "invalid-repair"
  | "rate-limited"
  | "oauth-org-restricted"
  | "github-rejected"
  | "github-error";

const PATH = new RegExp(
  String.raw`^(${REPO_SEGMENT})/(${REPO_SEGMENT})/pulls/(\d{1,10})/(comment|review|reply|resolve|edit)$`,
);
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PRIVATE = { "cache-control": "private, no-store", vary: "Cookie" };

class Refusal {
  constructor(
    readonly status: number,
    readonly code: PublishErrorCode,
    readonly message: string,
    readonly extra: Record<string, unknown> = {},
  ) {}
  get body() {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

const refuse = (...args: ConstructorParameters<typeof Refusal>): never => {
  throw new Refusal(...args);
};
const invalid = (message: string) => refuse(400, "invalid-request", message);

const ORG_DOCS = "https://docs.github.com/articles/restricting-access-to-your-organization-s-data/";
/** GitHub has no error code for it: the phrase is the stable part of its message. */
const ORG_RESTRICTED = /organization has enabled OAuth App access restrictions/;
/** The organization it names, when that is a GitHub login. */
const ORG_LOGIN = /the `([A-Za-z0-9-]{1,39})` organization/;

/**
 * A GitHub failure as a typed refusal. `retryAs`: offered when GitHub rejects a native line location.
 * `approvalUrl`: where users ask an organization to approve the OAuth App.
 */
function fromGitHub(error: unknown, approvalUrl?: string, representation?: Representation): Refusal {
  if (!(error instanceof GitHubError)) throw error;
  if (error instanceof RateLimitError)
    return new Refusal(429, "rate-limited", "GitHub's rate limit was reached", {
      resetAt: error.resetAt.toISOString(),
    });
  if (error.status === 401) return new Refusal(401, "reauth", "Sign in with GitHub again");
  // REST answers 403; GraphQL (resolve) answers 200 with a FORBIDDEN error.
  if ((error.status === 403 || error instanceof ForbiddenError) && ORG_RESTRICTED.test(error.message)) {
    const org = ORG_LOGIN.exec(error.message)?.[1];
    return new Refusal(
      403,
      "oauth-org-restricted",
      `${org ? `The ${org} organization` : "This organization"} restricts third-party apps`,
      { ...(org && { org }), approvalUrl: approvalUrl ?? ORG_DOCS },
    );
  }
  if (error.status >= 400 && error.status < 500) {
    const retry = error.status === 422 && representation === "review-line" && { retryAs: "review-file" };
    return new Refusal(error.status, "github-rejected", error.message, retry || {});
  }
  return new Refusal(502, "github-error", "GitHub request failed");
}

// ponytail: per-process fixed window per user; hosted abuse controls (shared store, per-repository
// limits) replace it when there is more than one instance.
const WINDOW_MS = 60_000;
const WRITES_PER_WINDOW = 60;
const windows = new Map<string, { count: number; until: number }>();
/** Counts `cost` writes against the user's window: a review costs one per draft. */
function limitRate(userId: string, cost = 1) {
  const now = Date.now();
  let window = windows.get(userId);
  if (!window || window.until <= now) {
    if (windows.size >= 10_000) windows.clear();
    windows.set(userId, (window = { count: 0, until: now + WINDOW_MS }));
  }
  if ((window.count += cost) > WRITES_PER_WINDOW)
    refuse(429, "rate-limited", "Too many comments at once; try again in a minute", {
      resetAt: new Date(window.until).toISOString(),
    });
}

// Input checks. Everything from the browser is untrusted.
type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const line = (v: unknown, name: string) =>
  Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : invalid(`${name} must be a positive integer`);
const side = (v: unknown, name: string) =>
  v === "LEFT" || v === "RIGHT" ? v : invalid(`${name} must be LEFT or RIGHT`);
const oid = (v: unknown, name: string) =>
  typeof v === "string" && OID.test(v) ? v : invalid(`${name} must be a commit OID`);

/** A body to publish, with its annotation if it carries one; malformed or oversized ones are refused. */
function commentBody(v: unknown): { body: string; annotation?: RenderedReviewAnnotationV1 } {
  if (typeof v !== "string" || !v.trim()) invalid("body must be a non-empty string");
  const body = v as string;
  if (body.length > MAX_BODY_LENGTH)
    refuse(413, "body-too-large", `Comments are limited to ${MAX_BODY_LENGTH} characters`);
  const found = extractAnnotation(body);
  if (found.status === "damaged" || found.status === "unsupported")
    refuse(400, "invalid-annotation", found.status === "damaged" ? found.reason : "Unsupported annotation version");
  return { body, ...(found.status === "ok" && { annotation: found.annotation }) };
}

export interface Draft {
  representation: Representation;
  body: string;
  annotation?: RenderedReviewAnnotationV1;
  /** review-line and review-file only. */
  path?: string;
  /** review-line only. */
  range?: LineRange;
}

/** A comment's body, location and representation; the representation must fit the location. */
function draft(v: Obj): Draft {
  const { representation } = v;
  if (representation !== "review-line" && representation !== "review-file" && representation !== "conversation")
    invalid("representation must be review-line, review-file or conversation");
  const out: Draft = { representation: representation as Representation, ...commentBody(v.body) };
  const hasLine =
    v.line !== undefined || v.side !== undefined || v.startLine !== undefined || v.startSide !== undefined;
  if (representation === "conversation") {
    if (v.path !== undefined || hasLine) invalid("A conversation comment has no path or line");
    return out;
  }
  if (typeof v.path !== "string" || !v.path || v.path.startsWith("/") || v.path.length > 4096)
    invalid("path must be a repository-relative file path");
  out.path = v.path as string;
  if (representation === "review-file") {
    if (hasLine) invalid("A file comment has no line");
    return out;
  }
  const range: LineRange = { line: line(v.line, "line"), side: side(v.side, "side") };
  if (v.startLine !== undefined) {
    range.startLine = line(v.startLine, "startLine");
    range.startSide = v.startSide === undefined ? range.side : side(v.startSide, "startSide");
    if (range.startLine >= range.line) invalid("startLine must precede line");
  } else if (v.startSide !== undefined) invalid("startSide needs startLine");
  out.range = range;
  return out;
}

/** An annotation may only describe this pull request, never another one it could be replayed into. */
function checkTarget(annotation: RenderedReviewAnnotationV1 | undefined, host: string, pr: PullRequest) {
  if (!annotation) return;
  const t = annotation.target;
  if (t.githubHost !== host || t.repositoryId !== pr.base.repository?.id || t.pullRequest !== pr.number)
    refuse(400, "annotation-mismatch", "The annotation belongs to a different pull request");
}

interface Deps {
  allowedHosts: string[];
  /** Undefined when this deployment has no sign-in. */
  identity: Pick<Identity, "getSessionUser" | "getUserGitHubToken" | "getUserPublicWriteToken"> | undefined;
  installed?: InstallationCheck;
  /** Undefined in community mode: private repositories are then refused. */
  entitlement?: EntitlementCheck;
  fetch?: typeof fetch;
  /** The OAuth App's page on GitHub, where users ask an organization to approve it. */
  approvalUrl?: string;
}

interface Target {
  host: string;
  owner: string;
  repo: string;
  number: number;
  userId: string;
}

/** Rechecks access (the least-privileged write credential) and reads the PR with it. */
async function connect(t: Target, operation: WriteOperation["operation"], deps: Deps) {
  const credential = await forRepository(
    { userId: t.userId, host: t.host, owner: t.owner, repo: t.repo, operation },
    { identity: deps.identity, installed: deps.installed, fetch: deps.fetch, entitlement: deps.entitlement },
  );
  switch (credential.kind) {
    case "reauth":
      return refuse(401, "reauth", "Sign in with GitHub again");
    case "needs-public-authorization":
      return refuse(403, "needs-public-authorization", "Allow Rendered Review to comment on public repositories");
    case "private-repo-unsupported":
      return refuse(403, "private-repo-unsupported", "Private repositories aren't supported yet");
    case "not-entitled":
      return refuse(403, "not-entitled", NOT_ENTITLED, { reason: credential.reason });
    case "unavailable":
      return refuse(credential.status === 404 ? 404 : 403, "unavailable", "Repository not available");
  }
  const client = createGitHubClient({
    host: t.host,
    fetch: deps.fetch,
    auth: () => `Bearer ${credential.token}`,
    maxRetries: 0,
  });
  const pr = await client.getPullRequest(t.owner, t.repo, t.number).catch((e: unknown) => {
    throw fromGitHub(e, deps.approvalUrl);
  });
  return { client, pr };
}

function checkHead(pr: PullRequest, expected: string) {
  if (pr.head.sha !== expected) refuse(409, "stale-head", "The pull request has new commits", { headOid: pr.head.sha });
}

function publishDraft(client: GitHubClient, t: Target, d: Draft, commitId: string) {
  if (d.representation === "conversation") return client.createIssueComment(t.owner, t.repo, t.number, d.body);
  return client.createReviewComment(t.owner, t.repo, t.number, { body: d.body, commitId, path: d.path!, ...d.range });
}

type Result = { status: number; body: unknown };
type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
const EVENTS = new Set<unknown>(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
const MAX_DRAFTS = 50;
const NODE_ID = /^[\w=-]{1,200}$/;
const SUBMISSION_ID = /^[\w-]{1,100}$/;

/** Runs `check` for one draft of a submission, naming the draft in any refusal. */
function forDraft<T>(draftId: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof Refusal)
      throw new Refusal(error.status, error.code, error.message, { ...error.extra, draftId });
    throw error;
  }
}

// ponytail: per-process memory of recent submissions; a retry landing on another instance
// publishes again. A shared store (KV, database) when there is more than one instance.
const SUBMISSION_TTL_MS = 10 * 60_000;
const submissions = new Map<string, { result: Promise<Result>; until: number }>();

/** Answers a repeated submission with the first one's outcome instead of publishing twice. */
function once(key: string, run: () => Promise<Result>): Promise<Result> {
  const now = Date.now();
  const hit = submissions.get(key);
  if (hit && hit.until > now) return hit.result;
  if (submissions.size >= 10_000) submissions.clear();
  const result = run();
  submissions.set(key, { result, until: now + SUBMISSION_TTL_MS });
  // Refused before anything was published (stale head, access): the same submission may be sent again.
  result.catch(() => submissions.delete(key));
  return result;
}

type Outcome = { draftId: string; ok: boolean } & Record<string, unknown>;

/**
 * Line drafts and the summary become one native review; file and conversation drafts are
 * published one by one (GitHub's review endpoint takes neither). Every draft gets an outcome.
 */
async function submitReview(
  t: Target,
  deps: Deps,
  review: {
    expected: string;
    event: ReviewEvent;
    summary?: ReturnType<typeof commentBody>;
    drafts: (Draft & { id: string })[];
  },
): Promise<Result> {
  const { client, pr } = await connect(t, "review", deps);
  checkHead(pr, review.expected);
  checkTarget(review.summary?.annotation, t.host, pr);
  for (const d of review.drafts) forDraft(d.id, () => checkTarget(d.annotation, t.host, pr));

  const outcomes = new Map<string, Outcome>();
  const lines = review.drafts.filter((d) => d.representation === "review-line");
  let native: { ok: true; reviewId: number } | { ok: false; error: unknown } | undefined;
  if (lines.length || review.summary || review.event !== "COMMENT") {
    try {
      const { id } = await client.createReview(t.owner, t.repo, t.number, {
        commitId: pr.head.sha,
        event: review.event,
        ...(review.summary && { body: review.summary.body }),
        comments: lines.map((d) => ({ path: d.path!, body: d.body, ...d.range! })),
      });
      native = { ok: true, reviewId: id };
      for (const d of lines) outcomes.set(d.id, { draftId: d.id, ok: true, reviewId: id });
    } catch (error) {
      native = { ok: false, error: fromGitHub(error, deps.approvalUrl).body };
      for (const d of lines)
        outcomes.set(d.id, {
          draftId: d.id,
          ok: false,
          error: fromGitHub(error, deps.approvalUrl, "review-line").body,
        });
    }
  }
  // One at a time: GitHub asks for serial writes to avoid secondary rate limits.
  for (const d of review.drafts) {
    if (d.representation === "review-line") continue;
    try {
      const comment = await publishDraft(client, t, d, pr.head.sha);
      outcomes.set(d.id, { draftId: d.id, ok: true, commentId: comment.id, url: comment.htmlUrl });
    } catch (error) {
      outcomes.set(d.id, {
        draftId: d.id,
        ok: false,
        error: fromGitHub(error, deps.approvalUrl, d.representation).body,
      });
    }
  }
  const results = review.drafts.map((d) => outcomes.get(d.id)!);
  const ok = (native?.ok ?? true) && results.every((r) => r.ok);
  return { status: 200, body: { ok, ...(native && { review: native }), results } };
}

export async function publishToGitHub(request: Request, deps: Deps): Promise<Response> {
  try {
    const { status, body } = await handle(request, { ...deps, fetch: meteredFetch(deps.fetch ?? fetch) });
    log.info("github.publish", { category: "published", status });
    return Response.json(body, { status, headers: PRIVATE });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    log.info("github.publish", { category: error.code, status: error.status });
    return Response.json(error.body, { status: error.status, headers: PRIVATE });
  }
}

async function handle(request: Request, deps: Deps): Promise<Result> {
  const { identity } = deps;
  if (!identity) throw new Refusal(404, "not-found", "Not found");
  if (request.method !== "POST") throw new Refusal(405, "invalid-request", "Method not allowed");
  const url = new URL(request.url);
  // Cross-site pages can send neither the custom header (it forces a CORS preflight, never
  // answered) nor a same-origin Origin.
  if (request.headers.get("x-requested-with") !== REQUESTED_WITH || request.headers.get("origin") !== url.origin)
    refuse(403, "csrf", "Cross-site request refused");
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? ""))
    refuse(415, "unsupported-media-type", "Send JSON");
  const path = parseProxyPath(url, WRITE_PREFIX, deps.allowedHosts);
  if (path instanceof Response) {
    const { message } = (await path.json()) as { message: string };
    return refuse(path.status, "not-found", message);
  }
  const match = PATH.exec(path.path) ?? refuse(404, "not-found", "Not found");
  const [, owner, repo, number, operation] = match;

  const user = await identity.getSessionUser(request.headers);
  if (!user) return refuse(401, "unauthenticated", "Sign in with GitHub");
  limitRate(user.id);

  const bytes = await readBodyCapped(request, MAX_REQUEST_BYTES);
  if (!bytes) return refuse(413, "request-too-large", "Request too large");
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalid("Body must be JSON");
  }
  if (!isObject(input)) return invalid("Body must be a JSON object");
  const t: Target = { host: path.host, owner: owner!, repo: repo!, number: Number(number), userId: user.id };

  switch (operation) {
    case "comment": {
      const d = draft(input);
      const expected = oid(input.expectedHeadOid, "expectedHeadOid");
      const { client, pr } = await connect(t, "comment", deps);
      // A plain conversation comment isn't tied to a revision; anything annotated or on a line is.
      if (d.representation !== "conversation" || d.annotation) checkHead(pr, expected);
      checkTarget(d.annotation, t.host, pr);
      const comment = await publishDraft(client, t, d, pr.head.sha).catch((e: unknown) => {
        throw fromGitHub(e, deps.approvalUrl, d.representation);
      });
      return { status: 201, body: { comment } };
    }
    case "reply": {
      const { body, annotation } = commentBody(input.body);
      const inReplyTo = line(input.inReplyTo, "inReplyTo");
      const expected = oid(input.expectedHeadOid, "expectedHeadOid");
      const { client, pr } = await connect(t, "comment", deps);
      checkHead(pr, expected);
      checkTarget(annotation, t.host, pr);
      const comment = await client
        .replyToReviewComment(t.owner, t.repo, t.number, inReplyTo, body)
        .catch((e: unknown) => {
          throw fromGitHub(e, deps.approvalUrl);
        });
      return { status: 201, body: { comment } };
    }
    case "resolve": {
      // Resolution does not depend on the head, so no head check.
      const { threadNodeId, resolved } = input;
      if (typeof threadNodeId !== "string" || !NODE_ID.test(threadNodeId)) invalid("threadNodeId must be a node id");
      if (typeof resolved !== "boolean") invalid("resolved must be true or false");
      const id = threadNodeId as string;
      const { client, pr } = await connect(t, "resolve", deps);
      const thread = await (async () => {
        // Access was checked for this repository only: the thread must belong to this PR.
        const owner = await client.getReviewThreadPullRequest(id);
        if (owner?.repositoryId !== pr.base.repository?.id || owner?.number !== pr.number)
          refuse(400, "thread-mismatch", "The thread belongs to a different pull request");
        return resolved ? client.resolveReviewThread(id) : client.unresolveReviewThread(id);
      })().catch((e: unknown) => {
        throw e instanceof Refusal ? e : fromGitHub(e, deps.approvalUrl);
      });
      return { status: 200, body: { thread } };
    }
    case "edit": {
      // Moves the signed-in user's own comment to a new anchor: only the body changes.
      const { commentType, previousBody } = input;
      if (commentType !== "issue" && commentType !== "review") invalid("commentType must be issue or review");
      const commentId = line(input.commentId, "commentId");
      if (typeof previousBody !== "string" || previousBody.length > MAX_BODY_LENGTH)
        invalid("previousBody must be the comment's current body");
      const { body, annotation } = commentBody(input.body);
      if (!annotation) return refuse(400, "invalid-annotation", "A repaired comment needs its annotation");
      // Only the quote, permalink and marker may change; the rest is the previous body's, byte for byte.
      // (Re-encoding a decoded annotation is byte-stable: compact JSON parses and stringifies back unchanged.)
      const location = commentType === "issue" ? "conversation" : "review-line";
      if (repairCommentBody({ body: previousBody as string, annotation, location }).body !== body)
        refuse(400, "invalid-repair", "A repair may change only the comment's quote, link and metadata");
      const expected = oid(input.expectedHeadOid, "expectedHeadOid");
      const { client, pr } = await connect(t, "comment", deps);
      checkHead(pr, expected);
      checkTarget(annotation, t.host, pr);
      const comment = await (async () => {
        // Collaborators may edit others' comments on GitHub; here only the author may, by account id.
        const me = await client.getAuthenticatedUser();
        const review = commentType === "review" ? await client.getReviewComment(t.owner, t.repo, commentId) : undefined;
        const current = review ?? (await client.getIssueComment(t.owner, t.repo, commentId));
        if (current.pullRequest !== pr.number) refuse(404, "not-found", "Comment not found on this pull request");
        if (review) {
          if (review.path !== annotation.target.path)
            refuse(400, "annotation-mismatch", "The annotation names another file than the comment");
          // GitHub keeps a review comment on its lines; an annotation elsewhere would never place it.
          const selected = anchorLines({ type: "annotation", annotation })!;
          const { line, side, startLine, startSide } = review;
          const start = (startSide ?? "RIGHT") === "RIGHT" && startLine ? startLine : line;
          if (line === null || side !== "RIGHT" || selected.endLine < start! || selected.startLine > line)
            refuse(400, "invalid-repair", "The new selection must be on the comment's lines in the current head");
        }
        if (current.author?.id !== me.id) refuse(403, "not-author", "Only the comment's author can repair its anchor");
        // Sent again after it landed: nothing to do. Changed since the preview: never overwrite it.
        if (current.body === body) return current;
        if (current.body !== previousBody)
          refuse(409, "comment-changed", "The comment changed on GitHub since this page loaded");
        return commentType === "issue"
          ? client.updateIssueComment(t.owner, t.repo, commentId, body)
          : client.updateReviewComment(t.owner, t.repo, commentId, body);
      })().catch((e: unknown) => {
        throw e instanceof Refusal ? e : fromGitHub(e, deps.approvalUrl);
      });
      return { status: 200, body: { comment } };
    }
    case "review": {
      const expected = oid(input.expectedHeadOid, "expectedHeadOid");
      const { submissionId, event, drafts } = input;
      if (typeof submissionId !== "string" || !SUBMISSION_ID.test(submissionId)) invalid("submissionId is required");
      if (!EVENTS.has(event)) invalid("event must be COMMENT, APPROVE or REQUEST_CHANGES");
      if (!Array.isArray(drafts) || drafts.length > MAX_DRAFTS)
        invalid(`drafts must list at most ${MAX_DRAFTS} drafts`);
      // The request itself already counted once.
      limitRate(t.userId, Math.max(0, (drafts as unknown[]).length - 1));
      const ids = new Set<string>();
      const checked = (drafts as unknown[]).map((v) => {
        if (!isObject(v) || typeof v.id !== "string" || !SUBMISSION_ID.test(v.id))
          return invalid("Every draft needs an id");
        if (ids.has(v.id)) invalid("Draft ids must be unique");
        ids.add(v.id);
        return { id: v.id, ...forDraft(v.id, () => draft(v)) };
      });
      const summary = input.body === undefined || input.body === "" ? undefined : commentBody(input.body);
      return once(`${t.userId} ${t.host}/${t.owner}/${t.repo}#${t.number} ${submissionId}`, () =>
        submitReview(t, deps, { expected, event: event as ReviewEvent, summary, drafts: checked }),
      );
    }
  }
  return refuse(404, "not-found", "Not found");
}
