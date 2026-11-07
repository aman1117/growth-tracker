import { describe, expect, it } from 'vitest';

import { makeFollowUser } from '../../test/fixtures/shell';
import {
  getMenuPosition,
  getMessageElementId,
  mergeChatCandidates,
  parseConversationId,
} from './chatHelpers';

const rect = (top: number, left: number, width = 200, height = 40) =>
  ({ top, left, width, height, bottom: top + height, right: left + width }) as DOMRect;
const viewport = { width: 400, height: 800 };

describe('parseConversationId', () => {
  it.each([
    ['42', 42],
    ['007', 7],
    ['0', null],
    ['-3', null],
    ['1.5', null],
    ['abc', null],
    ['', null],
    [undefined, null],
    ['99999999999999999999', null],
  ])('%s → %s', (raw, expected) => {
    expect(parseConversationId(raw)).toBe(expected);
  });
});

describe('getMessageElementId', () => {
  it('names message rows by id', () => {
    expect(getMessageElementId(7)).toBe('chat-msg-7');
  });
});

describe('getMenuPosition', () => {
  it('is centered without an anchor', () => {
    expect(getMenuPosition(null, true, viewport)).toBeUndefined();
  });

  it('opens below a message in the top half, aligned to the peer’s side', () => {
    expect(getMenuPosition(rect(100, 16), false, viewport)).toEqual({
      left: 16,
      top: 148,
      maxHeight: 640,
    });
  });

  it('opens above a message in the bottom half, aligned to my side', () => {
    expect(getMenuPosition(rect(600, 180), true, viewport)).toEqual({
      right: 20,
      bottom: 208,
      maxHeight: 580,
    });
  });

  it('keeps clear of the screen edges and leaves room to scroll', () => {
    expect(getMenuPosition(rect(-200, 2, 600), true, viewport)).toEqual({
      right: 12,
      top: 12,
      maxHeight: 776,
    });
    expect(getMenuPosition(rect(790, 0, 100, 400), false, { width: 400, height: 800 })).toEqual({
      left: 12,
      bottom: 18,
      maxHeight: 770,
    });
    expect(getMenuPosition(rect(60, 0, 100, 700), false, viewport)).toMatchObject({
      maxHeight: 160,
    });
  });
});

describe('mergeChatCandidates', () => {
  it('dedupes, marks mutuals and sorts them first', () => {
    const result = mergeChatCandidates(
      [
        makeFollowUser({
          id: 3,
          username: 'zoe',
          profile_pic: 'z.png',
          profile_pic_thumb: 'z-t.png',
        }),
        makeFollowUser({ id: 2, username: 'bob' }),
      ],
      [makeFollowUser({ id: 3, username: 'zoe' }), makeFollowUser({ id: 4, username: 'amy' })]
    );
    expect(result).toEqual([
      {
        id: 3,
        username: 'zoe',
        profilePic: 'z.png',
        profilePicThumb: 'z-t.png',
        isVerified: false,
        isMutual: true,
      },
      expect.objectContaining({ id: 4, username: 'amy', isMutual: false, profilePic: null }),
      expect.objectContaining({ id: 2, username: 'bob', isMutual: false }),
    ]);
  });
});
