# External resources and privacy

Loading an image from a server tells that server your IP address, browser and when you read the document. A tracking pixel in a pull request would tell its owner which reviewers opened it. Rendered Review therefore never loads a resource from a third-party server without you asking for it.

## What loads automatically

- **Rendered Review itself:** its scripts, styles and fonts.
- **GitHub:** the configured GitHub host and its content hosts. On github.com that means `github.com` and `*.githubusercontent.com` (repository files, uploaded attachments and avatars). On GitHub Enterprise Server it means the server's host and its subdomains. You already share your IP address with GitHub when you use it.

## Images in documents

- **Repository images** (`![diagram](./diagram.png)`, `/assets/logo.svg`, `../img/a.png`) load from the same repository at the commit you are reviewing. For a pull request that is the head commit being reviewed, so the image always matches the text. A path that would leave the repository is not loaded.
- **Images already hosted on GitHub** load directly.
- **Every other image** (`https://example.com/badge.svg`, status badges, tracking pixels) is not loaded. It is shown as a link naming its host, for example "build status (external image from img.shields.io)". Following the link opens the image in a new tab, so the image's server only sees you if you click. The page sends no referrer when you do.

Private repository images need your GitHub credentials, and a plain image request can't send them. They may not display yet.

## Links in documents

- Relative links to other repository files go to the file on GitHub at the reviewed commit. Links to directories go to the directory view.
- `#section` links go to the matching heading in the rendered document.
- Other links are left as written. Nothing is fetched until you follow them.

## Content Security Policy

Every response carries a Content Security Policy that enforces these rules in the browser, even if a document tried to get around them:

| Directive                                | Value                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `script-src`                             | `'self'` and a fresh per-response nonce. No other inline script runs. |
| `style-src`                              | `'self'` and the same nonce                                           |
| `img-src`                                | `'self'` and the GitHub hosts above                                   |
| `connect-src`                            | `'self'`, the GitHub API, and the GitHub hosts above                  |
| `object-src`, `base-uri`                 | `'none'`                                                              |
| `frame-ancestors`                        | `'none'`: Rendered Review can't be embedded in another site           |
| `default-src`, `font-src`, `form-action` | `'self'`                                                              |

### GitHub Enterprise Server

The GitHub hosts come from `GITHUB_URL`. With `GITHUB_URL=https://ghe.example.com`, the policy allows `https://ghe.example.com` and `https://*.ghe.example.com` in place of github.com's hosts, and the API origin derived from it. You don't need any other setting. The server must be reachable over HTTPS: repository images are requested with `https://` URLs.

To allow another origin, for example an internal image mirror, add it to the directive lists in `apps/web/src/csp.ts`. For images, also add it to `githubContentOrigins` in `packages/markdown-domain/src/resources.ts`: the renderer only leaves an image loadable when that list includes its host.
