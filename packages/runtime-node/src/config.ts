// SPDX-License-Identifier: AGPL-3.0-only
// Config for the Node build: the shared loader, plus the files only Node can read.
import { readFileSync } from "node:fs";
import { ConfigError, loadConfig, type AppConfig, type Env } from "@rendered-review/runtime";
import { resolveLocalPath } from "./database";

export function loadNodeConfig(env: Env = process.env): AppConfig {
  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  let githubAppPrivateKeyFile: string | undefined;
  if (keyFile) {
    try {
      githubAppPrivateKeyFile = readFileSync(resolveLocalPath(keyFile), "utf8");
    } catch (error) {
      throw new ConfigError([`GITHUB_APP_PRIVATE_KEY_FILE could not be read: ${(error as Error).message}`]);
    }
  }
  // Node takes the request origin from the Host header, so hosted and dedicated deployments pin it.
  return loadConfig(env, { githubAppPrivateKeyFile, requirePublicUrl: true });
}
