-- SPDX-License-Identifier: AGPL-3.0-only
-- Sessions no longer record the client's IP address; clear the ones recorded before.
UPDATE "session" SET "ipAddress" = NULL;
