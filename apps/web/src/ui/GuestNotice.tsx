// SPDX-License-Identifier: AGPL-3.0-only
// Suggests signing in to guests reading GitHub directly, whose anonymous limit is about 60
// requests an hour per network. Quiet and dismissible; a warning, not dismissible, once few are left.
// Gives way to the rate-limit banner once the limit is reached.
import { useState, useSyncExternalStore } from "react";
import { rateLimit } from "../github/client";
import { Icon } from "./AppShell";
import { dismissGuestNotice, guestNoticeDismissed } from "./prefs";
import { signIn } from "./Viewer";

export function GuestNotice({ host }: { host: string }) {
  const limitedUntil = useSyncExternalStore(rateLimit.subscribe, rateLimit.resetAt, () => undefined);
  const guest = useSyncExternalStore(
    rateLimit.subscribe,
    () => rateLimit.guest(host),
    () => undefined,
  );
  const [dismissed, setDismissed] = useState(() => guestNoticeDismissed());

  const now = Date.now();
  if (limitedUntil && limitedUntil.getTime() > now) return null;
  const low = !!guest && guest.resetAt.getTime() > now && guest.remaining <= guest.limit / 4;
  const time = guest?.resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <>
      {/* Its text only changes on entering the low state, so that is all it announces. */}
      <p className="rr-sr-only" role="status">
        {low && "GitHub guest requests are running low. Sign in with GitHub for a higher limit."}
      </p>
      {(low || !dismissed) && (
        <div className="rr-guest" data-low={low || undefined} role="note" aria-label="GitHub guest access">
          <Icon name={low ? "warn" : "info"} />
          <p>
            {low ? (
              <>
                <b>
                  {guest.remaining === 0 ? "No" : guest.remaining} {guest.remaining === 1 ? "request" : "requests"} left
                  until {time}.
                </b>{" "}
                GitHub allows guests about {guest.limit} requests an hour per network. Sign in with GitHub for 5,000.
              </>
            ) : (
              "Reading as a guest — GitHub allows about 60 requests an hour per network. Sign in with GitHub for 5,000."
            )}
          </p>
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => void signIn()}>
            Sign in with GitHub
          </button>
          {!low && (
            <button
              type="button"
              className="rr-btn rr-btn-sm rr-btn-ghost rr-btn-icon"
              aria-label="Dismiss sign-in suggestion"
              title="Dismiss for a week"
              onClick={() => {
                dismissGuestNotice();
                setDismissed(true);
              }}
            >
              <Icon name="x" />
            </button>
          )}
        </div>
      )}
    </>
  );
}
