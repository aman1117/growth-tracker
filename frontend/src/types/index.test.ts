import { describe, expect, it } from 'vitest';

import * as types from './index';
import { ACTIVITY_NAMES, getCustomTileId, isCustomTile } from './index';
import * as notification from './notification';

describe('custom tile names', () => {
  it.each([
    ['custom:3f2a-uuid', true, '3f2a-uuid'],
    ['custom:', true, ''],
    ['sleep', false, null],
    ['Custom:3f2a', false, null],
    ['my custom:3f2a', false, null],
  ])('%s → custom: %s, id: %o', (name, custom, id) => {
    expect(isCustomTile(name)).toBe(custom);
    expect(getCustomTileId(name)).toBe(id);
  });

  it('never treats a predefined activity as a custom tile', () => {
    ACTIVITY_NAMES.forEach((name) => expect(isCustomTile(name)).toBe(false));
  });
});

describe('ACTIVITY_NAMES', () => {
  it('lists each predefined activity once, in snake_case', () => {
    expect(new Set(ACTIVITY_NAMES).size).toBe(ACTIVITY_NAMES.length);
    ACTIVITY_NAMES.forEach((name) => expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/));
  });
});

describe('types barrel', () => {
  it('re-exports the notification helpers', () => {
    expect(types.formatNotificationTime).toBe(notification.formatNotificationTime);
    expect(types.formatLastLogged).toBe(notification.formatLastLogged);
    expect(types.isFollowMetadata).toBe(notification.isFollowMetadata);
    expect(types.isChallengeMetadata).toBe(notification.isChallengeMetadata);
    expect(types.isChallengeNotificationType).toBe(notification.isChallengeNotificationType);
  });
});
