/**
 * Text length helpers that count characters the way the server does: once per Unicode code
 * point (Go's utf8.RuneCountInString). JavaScript's `.length` and the `maxLength` attribute
 * count UTF-16 units instead, so many emoji would count twice.
 */

/** Number of characters (Unicode code points) in `value`. */
export const characterCount = (value: string): number => Array.from(value).length;

/** `value` cut to at most `max` characters, never splitting a character in two. */
export const truncateToCharacters = (value: string, max: number): string => {
  const characters = Array.from(value);
  return characters.length <= max ? value : characters.slice(0, Math.max(0, max)).join('');
};

/**
 * The value a text input should keep after an edit from `previous` to `next`, enforcing a
 * limit of `max` characters the way the `maxLength` attribute does: only the text the edit
 * inserted is cut to fit, so existing text is never pushed off the end, and a full field
 * ignores further typing. Deleting is always allowed, even from a value already over the limit.
 */
export const applyCharacterLimit = (next: string, previous: string, max: number): string => {
  const nextChars = Array.from(next);
  if (nextChars.length <= max) return next;

  // The edit is whatever lies between the text both values start with and end with
  const prevChars = Array.from(previous);
  let start = 0;
  while (
    start < prevChars.length &&
    start < nextChars.length &&
    prevChars[start] === nextChars[start]
  ) {
    start += 1;
  }
  let end = 0;
  while (
    end < prevChars.length - start &&
    end < nextChars.length - start &&
    prevChars[prevChars.length - 1 - end] === nextChars[nextChars.length - 1 - end]
  ) {
    end += 1;
  }

  const room = Math.max(0, max - start - end);
  const inserted = nextChars.slice(start, nextChars.length - end).slice(0, room);
  return [
    ...nextChars.slice(0, start),
    ...inserted,
    ...nextChars.slice(nextChars.length - end),
  ].join('');
};
