// SPDX-License-Identifier: AGPL-3.0-only
import type { PrIdentity } from "../github/queries";

export function NewConversationComment(_: { id: PrIdentity; isPrivate: boolean }) {
  return null;
}
