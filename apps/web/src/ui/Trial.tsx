// SPDX-License-Identifier: AGPL-3.0-only
// The owner's private-repository trial on the PR page: announced once per browser when first seen,
// then only a quiet days-left badge beside the pull request's details.
import { useEffect, useState } from "react";
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
