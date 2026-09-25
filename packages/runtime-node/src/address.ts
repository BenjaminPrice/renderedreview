// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client's address on Node. With `TRUSTED_PROXY_HEADER` set, the right-most value of that
 * header: the hop the operator's own reverse proxy appended (X-Forwarded-For) or set (X-Real-IP),
 * so values a client sends ahead of it are ignored. Otherwise, or when the header is missing, the
 * socket's peer address, which Nitro's server (srvx) exposes as `request.ip`.
 */
export function clientAddress(request: Request, trustedHeader: string | undefined): string | undefined {
  const forwarded = trustedHeader && request.headers.get(trustedHeader)?.split(",").at(-1)?.trim();
  return forwarded || (request as Request & { ip?: string }).ip || undefined;
}
