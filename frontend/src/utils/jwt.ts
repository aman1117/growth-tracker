/**
 * JWT Utilities
 *
 * Client-side decoding of the (non-sensitive) JWT payload. The signature is NOT
 * verified here — the backend remains the source of truth for authentication.
 */

export interface AccessTokenPayload {
  user_id: number;
  username: string;
  exp?: number;
}

/**
 * Decodes a base64url string (RFC 4648 §5) to UTF-8 text.
 * `atob` alone fails on the `-` / `_` characters that JWTs routinely contain,
 * and mangles non-ASCII characters.
 */
const decodeBase64Url = (input: string): string => {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/**
 * Returns the decoded access-token payload, or null if the token is malformed.
 */
export const decodeAccessToken = (token: unknown): AccessTokenPayload | null => {
  if (typeof token !== 'string') return null;
  const [, payloadSegment] = token.split('.');
  if (!payloadSegment) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(payloadSegment)) as Partial<AccessTokenPayload>;
    if (typeof payload.username !== 'string' || typeof payload.user_id !== 'number') {
      return null;
    }
    return { user_id: payload.user_id, username: payload.username, exp: payload.exp };
  } catch {
    return null;
  }
};
