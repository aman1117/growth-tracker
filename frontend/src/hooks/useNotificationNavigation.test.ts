import { act, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeNotification, routerWrapper } from '../test/fixtures/core';
import type { Notification, NotificationType } from '../types';
import { useNotificationNavigation } from './useNotificationNavigation';

const lastNavigation = () => screen.getByTestId('navigation').textContent;

function renderNavigation() {
  return renderHook(() => useNotificationNavigation(), {
    wrapper: routerWrapper(['/notifications-origin']),
  }).result;
}

const note = (type: NotificationType, metadata: Notification['metadata']) =>
  makeNotification({ type, metadata });

const followMetadata = { actor_id: 5, actor_username: 'erin' };
const commentMetadata = {
  comment_id: 11,
  comment_preview: 'Great run!',
  day_owner_username: 'frank',
  day_date: '2026-10-15',
  author_id: 6,
  author_username: 'gina',
};
const challengeActorMetadata = {
  challenge_id: 42,
  challenge_title: 'Study 2h+ a day',
  actor_id: 5,
  actor_username: 'erin',
  actor_avatar: '',
};

describe('useNotificationNavigation', () => {
  it.each<[string, Notification, string]>([
    [
      'a liked day opens that day on the dashboard',
      note('like_received', { liker_id: 2, liker_username: 'bob', liked_date: '2026-10-18' }),
      'PUSH /?date=2026-10-18',
    ],
    [
      'a liked story opens that day on the dashboard',
      note('story_liked', {
        liker_id: 2,
        liker_username: 'bob',
        photo_id: 9,
        photo_date: '2026-10-19',
      }),
      'PUSH /?date=2026-10-19',
    ],
    [
      'a streak milestone opens that user on that day',
      note('streak_milestone', {
        completed_user_id: 3,
        completed_username: 'carol',
        completed_date: '2026-10-17',
      }),
      'PUSH /user/carol?date=2026-10-17',
    ],
    [
      'an uploaded photo opens the uploader on that day',
      note('photo_uploaded', {
        uploader_id: 4,
        uploader_username: 'dave',
        photo_count: 2,
        photo_date: '2026-10-16',
      }),
      'PUSH /user/dave?date=2026-10-16',
    ],
    ['a new follower opens their profile', note('new_follower', followMetadata), 'PUSH /user/erin'],
    [
      'a follow request opens their profile',
      note('follow_request', followMetadata),
      'PUSH /user/erin',
    ],
    [
      'an accepted follow request opens their profile',
      note('follow_accepted', followMetadata),
      'PUSH /user/erin',
    ],
    ...(['comment_received', 'comment_reply', 'comment_mention', 'comment_liked'] as const).map(
      (type): [string, Notification, string] => [
        `a ${type} notification opens the day's comments`,
        note(type, commentMetadata),
        'PUSH /user/frank?date=2026-10-15&comments=true',
      ]
    ),
    [
      'a challenge invite opens its invite link',
      note('challenge_invite', { ...challengeActorMetadata, invite_code: 'ABCD2345' }),
      'PUSH /c/ABCD2345',
    ],
    [
      'a challenge invite trims its code',
      note('challenge_invite', { ...challengeActorMetadata, invite_code: ' ABCD2345 ' }),
      'PUSH /c/ABCD2345',
    ],
    [
      'a new challenger opens the challenge',
      note('challenge_joined', challengeActorMetadata),
      'PUSH /challenges/42',
    ],
    [
      'a cheer opens the challenge',
      note('challenge_cheer', { ...challengeActorMetadata, challenge_id: '42' }),
      'PUSH /challenges/42',
    ],
    [
      'a final result opens the challenge',
      note('challenge_ended', {
        challenge_id: 42,
        challenge_title: 'Study 2h+ a day',
        rank: 1,
        days_met: 18,
        days_possible: 21,
        completed: true,
      }),
      'PUSH /challenges/42',
    ],
  ])('%s', (_label, notification, expected) => {
    const navigation = renderNavigation();

    act(() => navigation.current.handleNotificationClick(notification));

    expect(lastNavigation()).toBe(expected);
  });

  it.each<[string, Notification]>([
    [
      'a badge',
      note('badge_unlocked', { badge_id: 'b1', badge_name: 'Early bird', badge_icon: 'Sun' }),
    ],
    ['a system announcement', note('system_announcement', null)],
    ['a like without metadata', note('like_received', null)],
    ['a story like without a date', note('story_liked', { liker_id: 2, liker_username: 'bob' })],
    ['a follow request without a username', note('follow_request', { actor_id: 5 })],
    ['a comment without its day', note('comment_reply', { day_owner_username: 'frank' })],
    [
      'a challenge invite without a code',
      note('challenge_invite', { ...challengeActorMetadata, invite_code: '  ' }),
    ],
    ['a challenge cheer without metadata', note('challenge_cheer', null)],
    [
      'a challenge result without a valid challenge',
      note('challenge_ended', { challenge_id: 'abc', challenge_title: 'Study' }),
    ],
    ['a challenger with a blank challenge id', note('challenge_joined', { challenge_id: ' ' })],
    ['a challenger with a negative challenge id', note('challenge_joined', { challenge_id: -3 })],
  ])('stays put for %s', (_label, notification) => {
    const navigation = renderNavigation();

    act(() => navigation.current.handleNotificationClick(notification));

    expect(lastNavigation()).toBe('POP /notifications-origin');
  });

  it("opens a user's profile when their name is clicked", () => {
    const navigation = renderNavigation();

    act(() => navigation.current.handleUsernameClick('henry'));

    expect(lastNavigation()).toBe('PUSH /user/henry');
  });
});
