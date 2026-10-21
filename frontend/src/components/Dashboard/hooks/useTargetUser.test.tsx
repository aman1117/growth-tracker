import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../../services/api';
import { useFollowStore } from '../../../store';
import {
  ALICE,
  BOB,
  createDeferred,
  dashboardRoutes,
  makePhoto,
  makeSearchUser,
  routeApi,
} from '../../../test/fixtures/dashboard';
import { signIn } from '../../../test/utils';
import { useTargetUser } from './useTargetUser';

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

// The theme store (store barrel) reads matchMedia when its module loads, before the shared
// setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

function renderTargetUser(route: string) {
  const fetchActivities = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/" element={children} />
        <Route path="/user/:username" element={children} />
      </Routes>
    </MemoryRouter>
  );
  const view = renderHook(
    () => ({ ...useTargetUser({ fetchActivities }), navigate: useNavigate() }),
    { wrapper }
  );
  return {
    ...view,
    fetchActivities,
    goTo: (to: string) => act(() => void view.result.current.navigate(to)),
  };
}

const followAccepted = (actorUsername: string) =>
  act(() => {
    window.dispatchEvent(
      new CustomEvent('follow-accepted', { detail: { actorId: BOB.id, actorUsername } })
    );
  });

describe('useTargetUser', () => {
  beforeEach(() => {
    signIn(ALICE);
    routeApi(api, dashboardRoutes());
  });

  describe('own dashboard', () => {
    it.each(['/', '/user/alice'])('treats %s as the signed-in user’s editable day', (route) => {
      const { result } = renderTargetUser(route);

      expect(result.current.targetUsername).toBe('alice');
      expect(result.current.isReadOnly).toBe(false);
      expect(result.current.targetUserId).toBe(ALICE.id);
      expect(api.post).not.toHaveBeenCalledWith('/users', expect.anything());
    });

    it('does not refresh when a follow request is accepted', () => {
      const { fetchActivities } = renderTargetUser('/');

      followAccepted('alice');

      expect(fetchActivities).not.toHaveBeenCalled();
    });
  });

  describe('another user’s dashboard', () => {
    it('loads their public profile, relationship and last activity', async () => {
      routeApi(
        api,
        dashboardRoutes({
          'POST /relationships/lookup': { success: true, relationships: { '2': 'ACTIVE' } },
          [`GET /users/${BOB.id}/profile`]: {
            success: true,
            last_logged_at: '2026-05-14T20:00:00Z',
          },
        })
      );
      const { result } = renderTargetUser('/user/bob');

      expect(result.current.isReadOnly).toBe(true);
      expect(result.current.targetUsername).toBe('bob');
      expect(result.current.targetUserId).toBeNull();

      await waitFor(() => expect(result.current.targetLastLoggedAt).toBe('2026-05-14T20:00:00Z'));
      expect(api.post).toHaveBeenCalledWith('/users', { username: 'bob' });
      expect(api.post).toHaveBeenCalledWith('/relationships/lookup', { target_ids: [BOB.id] });
      expect(api.get).toHaveBeenCalledWith(`/users/${BOB.id}/profile`);
      expect(result.current).toMatchObject({
        targetUserId: BOB.id,
        targetProfilePic: 'https://cdn.test/bob.jpg',
        targetProfilePicThumb: 'https://cdn.test/bob-thumb.jpg',
        targetBio: 'Runner and reader',
        targetIsVerified: true,
        targetIsPrivate: false,
      });
      expect(useFollowStore.getState().relationships[String(BOB.id)]).toMatchObject({
        following: true,
      });
    });

    it('picks the exact (case-insensitive) match from the search results', async () => {
      routeApi(
        api,
        dashboardRoutes({
          'POST /users': {
            success: true,
            data: [
              makeSearchUser({ id: 9, username: 'bobby', bio: 'Not me' }),
              makeSearchUser({ username: 'Bob' }),
            ],
          },
        })
      );
      const { result } = renderTargetUser('/user/BOB');

      await waitFor(() => expect(result.current.targetUserId).toBe(BOB.id));
      expect(result.current.targetBio).toBe('Runner and reader');
    });

    it('fills safe defaults for a sparse private profile', async () => {
      routeApi(
        api,
        dashboardRoutes({
          'POST /users': {
            success: true,
            data: [
              {
                id: BOB.id,
                username: 'bob',
                email: '',
                is_private: true,
              },
            ],
          },
          [`GET /users/${BOB.id}/profile`]: { success: true, last_logged_at: null },
        })
      );
      const { result } = renderTargetUser('/user/bob');

      await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/users/${BOB.id}/profile`));
      expect(result.current).toMatchObject({
        targetUserId: BOB.id,
        targetProfilePic: null,
        targetProfilePicThumb: null,
        targetBio: null,
        targetIsVerified: false,
        targetIsPrivate: true,
        targetLastLoggedAt: null,
      });
    });

    it.each([
      ['no user matches exactly', { success: true, data: [makeSearchUser({ username: 'bobby' })] }],
      ['no users are found', { success: true, data: [] }],
      ['the search fails softly', { success: false }],
    ])('keeps an empty header when %s', async (_label, response) => {
      routeApi(api, dashboardRoutes({ 'POST /users': response }));
      const { result } = renderTargetUser('/user/bob');

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/users', { username: 'bob' }));
      expect(result.current.targetUserId).toBeNull();
      expect(result.current.targetProfilePic).toBeNull();
      expect(api.post).not.toHaveBeenCalledWith('/relationships/lookup', expect.anything());
    });

    it('skips the relationship lookup when the match has no id', async () => {
      routeApi(
        api,
        dashboardRoutes({ 'POST /users': { success: true, data: [makeSearchUser({ id: 0 })] } })
      );
      const { result } = renderTargetUser('/user/bob');

      await waitFor(() => expect(result.current.targetBio).toBe('Runner and reader'));
      expect(result.current.targetUserId).toBeNull();
      expect(api.post).not.toHaveBeenCalledWith('/relationships/lookup', expect.anything());
      expect(api.get).not.toHaveBeenCalled();
    });

    it('treats a failing last-activity lookup as optional', async () => {
      routeApi(api, dashboardRoutes({ [`GET /users/${BOB.id}/profile`]: new Error('403') }));
      const { result } = renderTargetUser('/user/bob');

      await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/users/${BOB.id}/profile`));
      expect(result.current.targetUserId).toBe(BOB.id);
      expect(result.current.targetLastLoggedAt).toBeNull();
    });

    it('logs when the profile cannot be loaded', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      routeApi(api, dashboardRoutes({ 'POST /users': new Error('offline') }));
      renderTargetUser('/user/bob');

      await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          '[useTargetUser] Failed to fetch target user profile',
          expect.any(Error)
        )
      );
    });

    it('ignores a profile that arrives after switching to another user', async () => {
      const bobSearch = createDeferred<unknown>();
      routeApi(
        api,
        dashboardRoutes({
          'POST /users': (body: unknown) =>
            (body as { username: string }).username === 'bob'
              ? bobSearch.promise
              : { success: true, data: [makeSearchUser({ id: 3, username: 'carol', bio: 'Hi' })] },
          'GET /users/3/profile': { success: true },
        })
      );
      const { result, goTo } = renderTargetUser('/user/bob');

      goTo('/user/carol');
      await waitFor(() => expect(result.current.targetUserId).toBe(3));
      await act(async () => bobSearch.resolve({ success: true, data: [makeSearchUser()] }));

      expect(result.current.targetUsername).toBe('carol');
      expect(result.current.targetBio).toBe('Hi');
    });

    it('stops after the relationship lookup if the user switched profiles meanwhile', async () => {
      const lookup = createDeferred<unknown>();
      routeApi(api, dashboardRoutes({ 'POST /relationships/lookup': () => lookup.promise }));
      const { goTo } = renderTargetUser('/user/bob');
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/relationships/lookup', expect.anything())
      );

      goTo('/');
      await act(async () => lookup.resolve({ success: true, relationships: {} }));

      expect(api.get).not.toHaveBeenCalled();
    });

    it('refreshes when the viewed user accepts our follow request', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { fetchActivities } = renderTargetUser('/user/bob');

      followAccepted('carol');
      expect(fetchActivities).not.toHaveBeenCalled();

      followAccepted('BOB');
      expect(fetchActivities).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('[useTargetUser] Follow accepted, refreshing profile data');
    });

    it('clears loaded story photos when switching profiles or returning home', () => {
      const { result, goTo } = renderTargetUser('/user/bob');

      act(() => {
        result.current.setTargetUserPhotos([makePhoto()]);
        result.current.setTargetUserPhotosOwnerId(BOB.id);
      });
      expect(result.current.targetUserPhotos).toHaveLength(1);

      goTo('/user/carol');
      expect(result.current.targetUserPhotos).toEqual([]);
      expect(result.current.targetUserPhotosOwnerId).toBeNull();

      act(() => result.current.setTargetUserPhotos([makePhoto()]));
      goTo('/user/alice');
      expect(result.current.isReadOnly).toBe(false);
      expect(result.current.targetUserPhotos).toEqual([]);
      expect(result.current.targetUserId).toBe(ALICE.id);
    });

    it('tracks whether the full-size profile photo is open', () => {
      const { result } = renderTargetUser('/user/bob');

      act(() => result.current.setShowTargetFullscreenPic(true));

      expect(result.current.showTargetFullscreenPic).toBe(true);
    });
  });
});
