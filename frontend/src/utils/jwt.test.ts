import { describe, expect, it } from 'vitest';

import { decodeAccessToken } from './jwt';

/** Builds an unsigned JWT whose payload is `payload`, base64url-encoded like a real token. */
const tokenWith = (payload: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${base64url}.signature`;
};

describe('decodeAccessToken', () => {
  it('decodes the user id, username and expiry', () => {
    expect(
      decodeAccessToken(tokenWith({ user_id: 7, username: 'alice', exp: 1700000000 }))
    ).toEqual({ user_id: 7, username: 'alice', exp: 1700000000 });
  });

  it('handles base64url characters and non-ASCII usernames', () => {
    // '?>>' encodes to base64 containing '/' and '+', which base64url turns into '_' and '-'.
    const token = tokenWith({ user_id: 1, username: 'zoë', note: '?>>?>>' });
    expect(token).toMatch(/[-_]/);
    expect(decodeAccessToken(token)).toEqual({ user_id: 1, username: 'zoë', exp: undefined });
  });

  it.each([
    ['a non-string', 42],
    ['a token without a payload segment', 'only-one-part'],
    ['a payload that is not base64 JSON', 'header.%%%.signature'],
    ['a payload without a numeric user_id', tokenWith({ user_id: '7', username: 'alice' })],
    ['a payload without a username', tokenWith({ user_id: 7 })],
  ])('returns null for %s', (_label, token) => {
    expect(decodeAccessToken(token)).toBeNull();
  });
});
