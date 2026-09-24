// SPDX-License-Identifier: AGPL-3.0-only
import type { AnchorHTMLAttributes } from "react";

/** Link out of the app (to GitHub): opens in a new tab without a referrer, and says so. */
export function ExternalLink({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
      <svg className="rr-icon rr-icon-sm" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />
      </svg>
      <span className="rr-sr-only"> (opens in new tab)</span>
    </a>
  );
}
