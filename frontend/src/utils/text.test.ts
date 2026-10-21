import { describe, expect, it } from 'vitest';

import { applyCharacterLimit, characterCount, truncateToCharacters } from './text';

describe('characterCount', () => {
  it.each([
    ['an empty string', '', 0],
    ['ASCII', 'growth', 6],
    ['accented letters', 'café', 4],
    ['Devanagari', 'नमस्ते', 6],
    ['emoji outside the BMP', '🔥🔥', 2],
    ['mixed text', 'day 🔥 é', 7],
  ])('counts %s per code point, like the server', (_label, value, expected) => {
    expect(characterCount(value)).toBe(expected);
  });

  it('counts an emoji once even though it is two UTF-16 units', () => {
    expect('🔥'.length).toBe(2);
    expect(characterCount('🔥')).toBe(1);
  });
});

describe('truncateToCharacters', () => {
  it('returns short values unchanged', () => {
    expect(truncateToCharacters('hello', 5)).toBe('hello');
    expect(truncateToCharacters('', 3)).toBe('');
  });

  it('cuts long values to the limit', () => {
    expect(truncateToCharacters('growth tracker', 6)).toBe('growth');
  });

  it('never splits an emoji', () => {
    const cut = truncateToCharacters('ab🔥🔥', 3);
    expect(cut).toBe('ab🔥');
    expect(characterCount(cut)).toBe(3);
  });

  it('treats a zero or negative limit as empty', () => {
    expect(truncateToCharacters('abc', 0)).toBe('');
    expect(truncateToCharacters('abc', -1)).toBe('');
  });
});

describe('applyCharacterLimit', () => {
  it('accepts any edit that stays within the limit', () => {
    expect(applyCharacterLimit('abcd', 'abc', 5)).toBe('abcd');
    expect(applyCharacterLimit('abcde', 'abc', 5)).toBe('abcde');
    expect(applyCharacterLimit('', 'abc', 5)).toBe('');
  });

  it('ignores typing at the end of a full field', () => {
    expect(applyCharacterLimit('abcdeX', 'abcde', 5)).toBe('abcde');
  });

  it('ignores typing in the middle of a full field instead of dropping its last character', () => {
    expect(applyCharacterLimit('abXcde', 'abcde', 5)).toBe('abcde');
  });

  it('cuts a paste at the end to the room that is left', () => {
    expect(applyCharacterLimit('abc12345', 'abc', 5)).toBe('abc12');
  });

  it('keeps the text after the cursor and cuts the pasted text when pasting in the middle', () => {
    expect(applyCharacterLimit('a12345bc', 'abc', 5)).toBe('a12bc');
  });

  it('keeps the surrounding text when a selection is replaced with longer text', () => {
    // "bc" selected in "abcde" and replaced with "1234": only two of the four fit
    expect(applyCharacterLimit('a1234de', 'abcde', 5)).toBe('a12de');
  });

  it('counts an emoji once and never splits one', () => {
    const nineteen = 'x'.repeat(19);
    const result = applyCharacterLimit(`${nineteen}🔥🔥`, nineteen, 20);
    expect(result).toBe(`${nineteen}🔥`);
    expect(characterCount(result)).toBe(20);
    expect(applyCharacterLimit('🔥'.repeat(20), '🔥'.repeat(19), 20)).toBe('🔥'.repeat(20));
  });

  it('cuts a value set from nothing, such as a paste into an empty field', () => {
    expect(applyCharacterLimit('abcdefgh', '', 5)).toBe('abcde');
  });

  it('handles repeated characters without losing text', () => {
    expect(applyCharacterLimit('aaaa', 'aaa', 3)).toBe('aaa');
  });

  it('allows deleting from a value that is already over the limit but blocks additions', () => {
    expect(applyCharacterLimit('abcdef', 'abcdefg', 5)).toBe('abcdef');
    expect(applyCharacterLimit('abcdefgX', 'abcdefg', 5)).toBe('abcdefg');
  });
});
