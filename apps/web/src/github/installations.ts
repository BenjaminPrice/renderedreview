// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlDatabase } from "@rendered-review/runtime";

export async function localInstallation(
  _db: SqlDatabase,
  _host: string,
  _owner: string,
  _repo: string,
): Promise<boolean | undefined> {
  return undefined;
}
