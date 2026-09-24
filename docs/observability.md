# Observability

Rendered Review writes structured log events to the console. There is no telemetry SDK and no analytics
service: Node writes the events to stdout/stderr, and Cloudflare Workers Logs stores and indexes them. You
can send them on to any log tool.

## What is logged

The server logs events. Each event is one JSON object: `level` (`info`, `warn` or `error`), `event` (its
name) and a few fields. For example:

```json
{
  "level": "warn",
  "event": "github.request",
  "host": "api.github.com",
  "method": "GET",
  "route": "/repos/:/:/pulls/:/files",
  "status": 403,
  "durationMs": 212,
  "rateLimitRemaining": 0,
  "outcome": "error"
}
```

| Event                 | When                                                            | Fields                                                                                                                 |
| --------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `github.request`      | Each server call to GitHub from the read proxies and publishing | `host`, `method`, `route`, `status`, `durationMs`, `rateLimitRemaining`, `outcome` (`ok`, `error`, `network`), `error` |
| `github.user_proxy`   | A signed-in read is refused                                     | `category` (`unauthenticated`, `reauth`, `private-repo-unsupported`, `too-large`, `graphql-error`), `status`           |
| `github.publish`      | Each publish request finishes                                   | `category` (`published` or the refusal code, such as `stale-head`, `rate-limited`, `reauth`), `status`                 |
| `auth.failure`        | A sign-in, link or token refresh fails                          | `route` (such as `/callback/github`), `category` (the error code, or `refresh-rejected`), or `status`                  |
| `auth.library`        | The sign-in library reports a warning or error                  | `category` (its level; the library's message is not logged)                                                            |
| `server.error`        | A request ends in a 5xx or throws                               | `method`, `route` (a template such as `/:host/:owner/:repo/pull/:number`), `status` or `error`                         |
| `background.failed`   | Background work fails (Node)                                    | `error`                                                                                                                |
| `db.migration_failed` | Database migrations fail (Node)                                 | `error`                                                                                                                |

At startup, the Node server also prints its configuration (secrets redacted) or the list of configuration
problems.

## What is never logged

- Tokens, cookies, OAuth codes or authorization headers.
- Document, comment or review bodies, and annotation payloads.
- Owner or repository names, pull request numbers, file paths, or full URLs. A private repository's name is
  itself confidential, so GitHub calls are logged by route template (`/repos/:/:/pulls/:`) and pages by
  route (`/:host/:owner/:repo/pull/:number`).
- Error messages, which can quote any of the above. Errors are logged by class name (`TypeError`).
- Email addresses, GitHub logins or user IDs.

The logger (`packages/runtime/src/log.ts`) enforces this. It keeps only allowlisted field names with the
expected type, and drops any string with spaces or characters such as `@`, `?` or `=`. Strings are capped
at 100 characters. A field that fails these checks is left out, even if a caller passes it.

On Cloudflare, Workers Logs also records its own metadata for each request, such as URL, status and
uncaught exceptions. That is Cloudflare's record, not an application log, and it is kept under your
Cloudflare account's retention settings.

The browser sends no analytics or telemetry. The one browser-side log line, a note when public reads fall
back to the server proxy, appears only in development builds.

## Viewing logs

**Cloudflare Workers.** `observability.enabled` is on in `apps/web/wrangler.jsonc`, so events land in
Workers Logs (Cloudflare dashboard, Workers & Pages, your Worker, Logs). Fields are indexed, so you can filter
on `event`, `route` or `status`, for example `event = "github.request" AND status >= 400`. To stream live
events:

```sh
cd apps/web && pnpm exec wrangler tail --env production --format json
```

**Node.** One JSON line per event on stdout (`info`) and stderr (`warn`, `error`). Pipe it to any log
collector (journald, Docker logging drivers, Vector, Loki, and so on), or read it locally:

```sh
pnpm --filter @rendered-review/web start | jq -R 'fromjson? | select(.event == "github.request")'
```

## Suggested dashboard

Split failures by where they come from, so a GitHub outage is not mistaken for an application bug:

| Panel               | Query                                                                              | Points to                                   |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| GitHub errors       | `github.request` with `status >= 500` or `outcome = "network"`, by `host`, `route` | GitHub availability                         |
| GitHub rate limits  | `github.request` with `status` 403/429, and minimum `rateLimitRemaining` by `host` | Quota; set `GITHUB_PUBLIC_READ_TOKEN`       |
| GitHub latency      | p50/p95 `durationMs` of `github.request` by `route`                                | GitHub slowness                             |
| Sign-in failures    | `auth.failure` by `category`                                                       | GitHub App or OAuth configuration, sessions |
| Publishing outcomes | `github.publish` by `category`                                                     | Stale heads, permissions, GitHub refusals   |
| Platform errors     | `db.migration_failed`, `background.failed`, and Cloudflare exceptions/CPU limits   | Hosting platform and database               |
| Application defects | `server.error` by `route` and `error`                                              | Bugs in Rendered Review                     |

Billing events will join the platform panel once billing ships.
