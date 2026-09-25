# Private-repository trial ledger

The hosted service offers each GitHub owner (a personal account or an organization) one 30-day private-repository trial, without a card. The trial starts the first time a signed-in person who can see one of the owner's private repositories opens one of its pull requests in Rendered Review. To grant it only once per owner, the hosted service keeps a small trial ledger. Self-hosted (community) and dedicated deployments run no trial and write no ledger.

## What an entry holds

| Field             | Content                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Subject key       | HMAC-SHA256 of the GitHub host, the owner type (user or organization) and GitHub's numeric owner ID |
| Start and expiry  | When the trial started and when it ends (UTC)                                                       |
| Status            | Active, expired or converted to a paid plan                                                         |
| Contributor limit | Active private contributors the trial covers: 10, or more for a sales-approved trial                |
| Billing account   | The Rendered Review billing account that redeemed the trial                                         |

The subject key is pseudonymous: it holds no login, name or email, and without the server's secret it can't be linked back to an owner. The HMAC key is derived (HKDF-SHA256) from the deployment's `BETTER_AUTH_SECRET`. Because the key uses GitHub's stable numeric ID, renaming the owner, reinstalling the GitHub App, connecting another repository or deleting and recreating the billing account all find the same entry. Coupons and promotional subscriptions never create one.

The ledger stores no repository content, comments or GitHub tokens.

Active private contributors are counted per calendar month, as for paid plans, so a trial that spans two months can take up to 10 new contributors in each.

## Purpose and retention

The ledger's only purpose is to stop the same owner from starting a second trial. Entries have no expiry: an entry is kept for as long as the hosted service offers this trial, because deleting it would let the owner start another. When the redeeming billing account is deleted, the entry loses its link to that account (the billing account field is cleared) and the pseudonymous entry stays.

## Trial start limits

To stop one person or network from starting trials for many throwaway organizations, starting a trial (only once its ledger entry is actually created, never for a refused or duplicate start) also adds one to two daily counters in `usage_counter`: one for the signed-in user's internal ID and one for the client's network address (an IPv6 address counts per /64). The address is stored only as an HMAC (keyed by a subkey of `BETTER_AUTH_SECRET`) over the address and the day, so it can't be read back and one day's row can't be linked to another's. A counter holds a count and the UTC day, nothing about the owner or repository, and is not linked to the ledger. Earlier days' counters are deleted the next time a trial starts.

## After the trial

When the trial ends, Rendered Review stops opening new private pull request pages for that owner and stops publishing comments to its private repositories. Comments already on GitHub are unaffected. Drafts still in the browser can be copied, from the open page or from the trial-ended page. Private drafts are kept only in the tab's memory unless you chose to keep private content in the browser, so copy them before closing the tab.
