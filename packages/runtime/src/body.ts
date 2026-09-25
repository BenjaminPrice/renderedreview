// SPDX-License-Identifier: AGPL-3.0-only
// Bounded request bodies: Node's server applies no size limit, so every handler that reads a body
// reads it through this. Web Platform APIs only.

/**
 * The body's bytes, or undefined once it exceeds `max` bytes. Stops reading (and cancels the
 * stream) as soon as it is too large; a declared Content-Length over `max` is refused unread, but
 * a smaller one is not trusted.
 */
export async function readBodyCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(request.headers.get("content-length")) > max) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) break;
    size += chunk.value.byteLength;
    if (size > max) {
      await reader?.cancel();
      return undefined;
    }
    chunks.push(chunk.value);
  }
  return new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
}
