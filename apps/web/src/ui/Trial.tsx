// SPDX-License-Identifier: AGPL-3.0-only
// The owner's private-repository trial on the PR page: announced once per browser when first seen,
// then only a quiet days-left badge beside the pull request's details.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { trialEndedRepositoryQuery } from "../github/queries";
import { useDrafts } from "../review/drafts";
import { markTrialNoticeSeen, trialNoticeSeen } from "./prefs";

const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

export function TrialStarted({ owner, endsAt }: { owner: string; endsAt: string }) {
  const key = `${owner}/${endsAt}`;
  const [fresh] = useState(() => !trialNoticeSeen(key));
  useEffect(() => markTrialNoticeSeen(key), [key]);
  if (!fresh) return null;
  return (
    <p className="rr-doc-note" role="status" aria-label="Trial started">
      30-day trial started for {owner} · ends {day(endsAt)}
    </p>
  );
}

export function TrialDaysLeft({ endsAt }: { endsAt: string }) {
  const left = Math.max(0, Math.ceil((Date.parse(endsAt) - Date.now()) / 86_400_000));
  return (
    <span className="rr-badge rr-b-neutral" title={`Private-repository trial ends ${day(endsAt)}`}>
      Trial · {left} {left === 1 ? "day" : "days"} left
    </span>
  );
}

/**
 * An ended trial's page: the PR's drafts still in this browser (this tab's memory, or IndexedDB when
 * the user opted in to keeping private content), to copy. Nothing when there are none.
 */
export function TrialEndedDrafts({
  host,
  owner,
  repo,
  number,
}: {
  host: string;
  owner: string;
  repo: string;
  number: number;
}) {
  const repositoryId = useQuery(trialEndedRepositoryQuery(host, owner, repo)).data;
  return repositoryId ? <StoredDrafts host={host} repositoryId={repositoryId} number={number} /> : null;
}

function StoredDrafts(scope: { host: string; repositoryId: number; number: number }) {
  const { drafts } = useDrafts({ ...scope, private: true });
  if (!drafts.length) return null;
  return (
    <section aria-label="Unpublished drafts">
      <p>Your unpublished drafts on this pull request. Copy them to keep them.</p>
      <ul>
        {drafts.map((d) => (
          <li key={d.id}>
            <code>{d.path}</code> {d.comment}{" "}
            <button
              type="button"
              className="rr-btn rr-btn-sm rr-btn-ghost"
              title="Copy the comment as it would be posted to GitHub"
              onClick={() => void navigator.clipboard?.writeText(d.body)}
            >
              Copy
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
