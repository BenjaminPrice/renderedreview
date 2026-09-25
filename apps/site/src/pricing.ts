// SPDX-License-Identifier: AGPL-3.0-only
// The one source for every price the site shows. Numbers follow the commercial model: priced by
// monthly active private contributors; annual is 11 times monthly (one month free).

export interface Plan {
  name: string;
  /** Who the plan is for. */
  audience: string;
  /** Included active private contributors; null for Public (unlimited public activity). */
  contributors: number | null;
  /** USD per month; 0 is free. */
  monthly: number;
  /** USD per month for each additional active private contributor; null when the plan has none. */
  overage: number | null;
  cta: string;
  /** Highlighted with the "Free Trial" badge. */
  featured?: boolean;
}

export const TRIAL_DAYS = 30;
export const TRIAL_CONTRIBUTORS = 10;

export const plans: readonly Plan[] = [
  {
    name: "Public",
    audience: "Open-source and public projects",
    contributors: null,
    monthly: 0,
    overage: null,
    cta: "Open a pull request",
  },
  {
    name: "Individual",
    audience: "Personal private repositories",
    contributors: 1,
    monthly: 5,
    overage: null,
    cta: `Start ${TRIAL_DAYS}-day trial`,
  },
  {
    name: "Team",
    audience: "Small engineering teams",
    contributors: 10,
    monthly: 49,
    overage: 5,
    cta: `Start ${TRIAL_DAYS}-day trial`,
    featured: true,
  },
  {
    name: "Business",
    audience: "Growing companies",
    contributors: 50,
    monthly: 200,
    overage: 4,
    cta: `Start ${TRIAL_DAYS}-day trial`,
  },
  {
    name: "Scale",
    audience: "Larger engineering organizations",
    contributors: 200,
    monthly: 600,
    overage: 3,
    cta: `Start ${TRIAL_DAYS}-day trial`,
  },
];

export const annualPrice = (plan: Plan) => plan.monthly * 11;

export const formatUsd = (amount: number) => `$${amount.toLocaleString("en-US")}`;
