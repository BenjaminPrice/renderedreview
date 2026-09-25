-- SPDX-License-Identifier: AGPL-3.0-only
-- A deleted GitHub App installation keeps its row as a tombstone (GitHub never reuses installation
-- IDs), so a delivery for it that arrives late cannot bring it back.
ALTER TABLE github_installation ADD COLUMN deleted_at TEXT;
