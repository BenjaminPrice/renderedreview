-- SPDX-License-Identifier: AGPL-3.0-only
-- Control-plane schema. Runs unchanged on SQLite, Cloudflare D1 and PostgreSQL:
-- see packages/control-plane/README.md for the portability rules.
-- Nothing here stores repository content, comment or reply bodies, suggestions,
-- review threads or annotations: those stay in GitHub.

-- Better Auth core tables. Names and camelCase columns match Better Auth's default
-- schema, so it needs no field mapping ("user" is quoted because PostgreSQL reserves it).
CREATE TABLE "user" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0 CHECK ("emailVerified" IN (0, 1)),
  "image" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT PRIMARY KEY,
  "expiresAt" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "session_userId_idx" ON "session" ("userId");

-- Token columns hold application-encrypted ciphertext, never raw tokens.
CREATE TABLE "account" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TEXT,
  "refreshTokenExpiresAt" TEXT,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "verification" (
  "id" TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- Billing. Provider columns are the Polar/Stripe customer reference; null in community mode.
CREATE TABLE billing_account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_provider TEXT CHECK (billing_provider IN ('polar', 'stripe')),
  billing_customer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (billing_provider, billing_customer_id)
);

CREATE TABLE membership (
  billing_account_id TEXT NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (billing_account_id, user_id)
);
CREATE INDEX membership_user_id_idx ON membership (user_id);

-- GitHub identities use the host plus GitHub's stable numeric ID (stored as decimal text),
-- so renames keep the row and github.com and Enterprise Server IDs never collide.
-- login/name are the current display names, refreshed from GitHub.
CREATE TABLE github_owner (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  github_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('User', 'Organization')),
  login TEXT NOT NULL,
  billing_account_id TEXT REFERENCES billing_account (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (host, github_id)
);
CREATE INDEX github_owner_billing_account_id_idx ON github_owner (billing_account_id);

CREATE TABLE github_installation (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  github_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES github_owner (id) ON DELETE CASCADE,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  suspended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (host, github_id)
);
CREATE INDEX github_installation_owner_id_idx ON github_installation (owner_id);

CREATE TABLE github_repository (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  github_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES github_owner (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  private INTEGER NOT NULL CHECK (private IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (host, github_id)
);
CREATE INDEX github_repository_owner_id_idx ON github_repository (owner_id);

-- Repositories an installation grants (the "selected" list, or every repo seen for "all").
CREATE TABLE github_installation_repository (
  installation_id TEXT NOT NULL REFERENCES github_installation (id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES github_repository (id) ON DELETE CASCADE,
  PRIMARY KEY (installation_id, repository_id)
);
CREATE INDEX github_installation_repository_repository_id_idx ON github_installation_repository (repository_id);

-- Plan catalog. Prices live with the billing provider; this holds what entitlements need.
CREATE TABLE plan (
  id TEXT PRIMARY KEY,
  included_contributors INTEGER,
  overage_cents INTEGER
);
INSERT INTO plan (id, included_contributors, overage_cents) VALUES
  ('public', 0, NULL),
  ('individual', 1, NULL),
  ('team', 10, 500),
  ('business', 50, 400),
  ('scale', 200, 300),
  ('enterprise', NULL, NULL);

CREATE TABLE subscription (
  id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plan (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
  billing_provider TEXT CHECK (billing_provider IN ('polar', 'stripe')),
  provider_subscription_id TEXT,
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (billing_provider, provider_subscription_id)
);
CREATE INDEX subscription_billing_account_id_idx ON subscription (billing_account_id);

-- Locally derived entitlement per billing account, read on each request instead of
-- calling the billing provider. contributor_limit null means unlimited.
CREATE TABLE entitlement (
  billing_account_id TEXT PRIMARY KEY REFERENCES billing_account (id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plan (id),
  source TEXT NOT NULL CHECK (source IN ('subscription', 'trial', 'manual')),
  contributor_limit INTEGER,
  valid_until TEXT,
  updated_at TEXT NOT NULL
);

-- Pseudonymous trial ledger: one row per HMAC(host, subject type, stable owner ID), hex.
-- Deliberately not linked to github_owner, and kept when the redeeming account is deleted.
CREATE TABLE trial (
  subject_key TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'converted')),
  contributor_limit INTEGER NOT NULL,
  billing_account_id TEXT REFERENCES billing_account (id) ON DELETE SET NULL
);

-- A GitHub user counts once per billing account per billing period.
CREATE TABLE active_contributor (
  billing_account_id TEXT NOT NULL REFERENCES billing_account (id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  github_user_id TEXT NOT NULL,
  first_active_at TEXT NOT NULL,
  PRIMARY KEY (billing_account_id, period_start, github_user_id)
);

-- Webhook idempotency: source is 'github', 'polar' or 'stripe'; delivery_id is the sender's delivery/event ID.
CREATE TABLE processed_webhook_event (
  source TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (source, delivery_id)
);
CREATE INDEX processed_webhook_event_processed_at_idx ON processed_webhook_event (processed_at);

-- Aggregate usage and abuse counters. subject is an internal/GitHub ID or an HMAC
-- (for network signals); never content, never a raw IP address.
CREATE TABLE usage_counter (
  scope TEXT NOT NULL CHECK (scope IN ('user', 'repository', 'installation', 'network', 'billing_account')),
  subject TEXT NOT NULL,
  metric TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, subject, metric, window_start)
);
