// SPDX-License-Identifier: AGPL-3.0-only
// A refused publish, as shown in the composer, reply box and review dialog.
import type { PublishError } from "../github/mutations";
import { ExternalLink } from "../ui/ExternalLink";

/** `error.message` is already for the reviewer; `cause` is the refusal, when it needs more than text. */
export function PublishFailure({ error }: { error: { message: string; cause?: unknown } }) {
  const refusal = error.cause as Partial<PublishError> | undefined;
  if (refusal?.upgradeUrl && (refusal.code === "trial-expired" || refusal.code === "trial-contributor-cap"))
    return (
      <>
        {error.message}{" "}
        {/* A new tab keeps unsent text and in-memory drafts here. */}
        <ExternalLink href={refusal.upgradeUrl}>See plans</ExternalLink>
      </>
    );
  if (refusal?.code !== "oauth-org-restricted") return error.message;
  return (
    <>
      <strong>
        {refusal.org ? `The ${refusal.org} organization` : "This organization"} restricts third-party apps.
      </strong>{" "}
      An organization owner needs to approve Rendered Review, or{" "}
      {/* A new tab keeps the unsent text here; the install flow brings that tab back to this pull request. */}
      <ExternalLink href={`/api/github/install?return=${encodeURIComponent(location.pathname + location.search)}`}>
        install the Rendered Review GitHub App
      </ExternalLink>{" "}
      on the repository. <ExternalLink href={refusal.approvalUrl}>Request approval</ExternalLink>
    </>
  );
}
