# Rendered Review PR link action

Keeps exactly one comment on a pull request that links to the pull request in Rendered Review whenever it changes Markdown. The comment is updated as files change and removed when no matching Markdown remains.

The link has the form `<base-url>/<github-host>/<owner>/<repo>/pull/<number>`, for example `https://renderedreview.dev/github.com/acme/widgets/pull/123`. On GitHub Enterprise Server the host comes from `GITHUB_SERVER_URL` and API calls go to `GITHUB_API_URL`.

## Inputs

| Input               | Default                      | Description                                                                              |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `base-url`          | `https://renderedreview.dev` | Rendered Review application URL.                                                         |
| `include`           | `**/*.md`, `**/*.markdown`   | Glob patterns (newline- or comma-separated). `**` spans directories; `*` and `?` do not. |
| `exclude`           | none                         | Glob patterns removed from the matches.                                                  |
| `comment-on-drafts` | `false`                      | Also comment on draft pull requests.                                                     |
| `remove-when-empty` | `true`                       | Delete the action's comment when no matching Markdown remains.                           |
| `github-token`      | `${{ github.token }}`        | Token used to list PR files and manage the comment.                                      |
| `fail-on-error`     | `false`                      | Fail the step on errors. By default errors are reported as warnings.                     |

Added, modified, renamed (old or new path matching) and deleted files all count.

## How it identifies its comment

The comment carries the invisible marker `<!-- rendered-review-link:v1 -->`. The action only edits or deletes a comment that has the marker **and** was written by the token's own identity: `github-actions[bot]` for the default `GITHUB_TOKEN`, or the identity GitHub reports for a personal or GitHub App token. Comments from people or other bots that contain the marker are never touched.

## Security

The action is safe to run from `pull_request_target`, which public repositories need so that fork pull requests can receive the comment:

- It reads only pull request metadata (the changed file list) and issue comments through the GitHub REST API.
- It never checks out, downloads, parses or executes pull request content. Do not add `actions/checkout` of the PR head to the same job.
- It needs only `contents: read` and `pull-requests: write`.
- It is a single bundled file (`dist/index.js`) with no runtime dependencies, so pinning it to a commit SHA pins all code that runs.
- It is optional navigation, not a check: failures warn by default and it should not be a required status check.

Pin the action to a full commit SHA rather than a branch or tag.

## Example workflows

Public service (`renderedreview.dev`):

```yaml
name: Rendered Review link
on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: rendered-review-link-${{ github.event.pull_request.number }}
jobs:
  link:
    runs-on: ubuntu-latest
    steps:
      - uses: BenjaminPrice/renderedreview/packages/github-action@<full-commit-sha>
```

Dedicated hosted installation:

```yaml
steps:
  - uses: BenjaminPrice/renderedreview/packages/github-action@<full-commit-sha>
    with:
      base-url: https://acme.renderedreview.dev
```

Self-hosted deployment (works on GitHub Enterprise Server too):

```yaml
steps:
  - uses: BenjaminPrice/renderedreview/packages/github-action@<full-commit-sha>
    with:
      base-url: https://review.internal.example.com
      exclude: |
        vendor/**
        **/CHANGELOG.md
```

Private repositories without fork contributions can use `pull_request` instead of `pull_request_target` with the same permissions.

## Development

`src/index.ts` holds the logic and `src/main.ts` the entry point. After changing either, rebuild and commit the bundle; CI fails if `dist/index.js` does not match a fresh build.

```sh
pnpm --filter @rendered-review/github-action build
pnpm vitest run packages/github-action
```
