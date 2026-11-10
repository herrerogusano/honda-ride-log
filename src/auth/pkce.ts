/**
 * PKCE (RFC 7636) and the `state` value of an authorization request.
 * Only the S256 method is offered; `plain` is never used.
 */

/** The parts of Web Crypto this module needs, injectable for tests. */
export interface CryptoLike {
  getRandomValues<T extends Uint8Array<ArrayBuffer>>(array: T): T;
  readonly subtle: { digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> };
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes as base64url: 43 characters, the minimum length RFC 7636 allows, 256 bits of entropy. */
export function randomToken(crypto: CryptoLike): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** `BASE64URL(SHA-256(ASCII(verifier)))`. */
export async function challengeFor(verifier: string, crypto: CryptoLike): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Characters RFC 7636 allows in a verifier, and its length limits. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
