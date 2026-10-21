import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../../constants/storage';
import { ApiError } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { pushService } from '../../services/pushService';
import { useAuthStore } from '../../store/useAuthStore';
import { useThemeStore } from '../../store/useThemeStore';
import { deferred, setPushEnvironment } from '../../test/fixtures/settings';
import { renderWithRouter, signIn } from '../../test/utils';
import type { Badge } from '../../types/api';
import { SettingsPage } from './index';

const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn<(endpoint: string) => Promise<unknown>>(),
    post: vi.fn<(endpoint: string, body?: unknown) => Promise<unknown>>(),
    delete: vi.fn<(endpoint: string) => Promise<unknown>>(),
    uploadFile: vi.fn<(endpoint: string, file: File) => Promise<unknown>>(),
  },
}));

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  api,
}));
vi.mock('../../services/pushService');

// The follow lists are their own feature; stand-ins show what Settings asked them to open.
vi.mock('../social', () => ({
  FollowRequestsModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div role="dialog" aria-label="Follow requests">
        <button type="button" onClick={onClose}>
          Close requests
        </button>
      </div>
    ) : null,
  FollowListModal: (props: {
    isOpen: boolean;
    onClose: () => void;
    userId: number;
    username: string;
    type: string;
  }) =>
    props.isOpen ? (
      <div role="dialog" aria-label={`${props.type} of ${props.username} (#${props.userId})`}>
        <button type="button" onClick={props.onClose}>
          Close list
        </button>
      </div>
    ) : null,
}));

const BADGES: Badge[] = [
  {
    key: 'streak_3',
    name: 'Spark',
    icon: 'flame',
    color: '#f97316',
    threshold: 3,
    earned: true,
    earned_at: '2025-03-01',
  },
  {
    key: 'streak_7',
    name: 'Week Warrior',
    icon: 'zap',
    color: '#6366f1',
    threshold: 7,
    earned: false,
  },
];

type Routes = Record<string, unknown>;

/** Answers requests by endpoint; an Error is thrown, a promise is awaited. */
function serve({ get = {}, post = {} }: { get?: Routes; post?: Routes } = {}) {
  const gets: Routes = {
    '/get-privacy': { success: true, is_private: false },
    '/profile': { success: true, bio: 'Reading daily', is_verified: false },
    '/badges': { success: true, badges: BADGES },
    '/me/follow-requests/incoming?limit=1': { success: true, requests: [], total_count: 0 },
    '/users/1/follow-counts': {
      success: true,
      counts: { followers_count: 12, following_count: 3 },
    },
    ...get,
  };
  const posts: Routes = {
    '/get-streak': { success: true, data: { current: 2, longest: 5 } },
    ...post,
  };
  const answer = (routes: Routes, method: string) => async (endpoint: string) => {
    if (!(endpoint in routes)) throw new Error(`Unexpected ${method} ${endpoint}`);
    const response = routes[endpoint];
    if (response instanceof Error) throw response;
    return response;
  };
  api.get.mockImplementation(answer(gets, 'GET'));
  api.post.mockImplementation(answer(posts, 'POST'));
}

/** Renders Settings and lets the background requests finish */
async function renderSettings() {
  const view = renderWithRouter(<SettingsPage />, { route: '/settings', path: '/settings' });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return view;
}

const row = (name: RegExp) => screen.getByRole('button', { name });
const privacySwitch = () => screen.getByRole('switch', { name: 'Private account' });
const fileInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[type="file"]')!;

describe('SettingsPage', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.delete.mockReset();
    api.uploadFile.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2025, 2, 12, 10, 0, 0));
    setPushEnvironment({ supported: false });
    signIn({ id: 1, username: 'testuser' });
    serve();
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('sends signed-out visitors to the login screen', async () => {
    act(() => useAuthStore.setState({ user: null, isAuthenticated: false }));

    await renderSettings();

    expect(screen.getByTestId('location')).toHaveTextContent('/login');
    expect(api.get).not.toHaveBeenCalled();
  });

  describe('on open', () => {
    it('loads the profile, privacy, badges, streak and follow counts', async () => {
      await renderSettings();

      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
      expect(api.get).toHaveBeenCalledWith('/get-privacy');
      expect(api.get).toHaveBeenCalledWith('/profile');
      expect(api.get).toHaveBeenCalledWith('/badges');
      // The streak is asked for the local calendar day
      expect(api.post).toHaveBeenCalledWith('/get-streak', {
        username: 'testuser',
        date: '2025-03-12',
      });

      expect(row(/^12\s*Followers$/)).toBeInTheDocument();
      expect(row(/^3\s*Following$/)).toBeInTheDocument();
      expect(row(/^Edit bio: Reading daily$/)).toBeInTheDocument();
      expect(useAuthStore.getState().user?.bio).toBe('Reading daily');
      expect(screen.getByRole('heading', { name: 'Streak badges' })).toBeInTheDocument();
      expect(screen.getByRole('progressbar', { name: 'Progress to Week Warrior' })).toHaveAttribute(
        'aria-valuenow',
        '5'
      );
      expect(row(/^Follow requests\s*No pending requests$/)).toBeInTheDocument();
    });

    it('holds the badge card until badges arrive', async () => {
      const badges = deferred<unknown>();
      serve({ get: { '/badges': badges.promise } });
      await renderSettings();

      expect(screen.queryByRole('heading', { name: 'Streak badges' })).not.toBeInTheDocument();

      await act(async () => badges.resolve({ success: true, badges: BADGES }));
      expect(screen.getByRole('heading', { name: 'Streak badges' })).toBeInTheDocument();
    });

    it('leaves the badge card out when there are no badges', async () => {
      serve({ get: { '/badges': { success: true, badges: [] } } });
      await renderSettings();

      expect(screen.queryByRole('heading', { name: 'Streak badges' })).not.toBeInTheDocument();
    });

    it('applies the photo and verified badge from the server', async () => {
      serve({
        get: {
          '/profile': {
            success: true,
            profile_pic: 'https://cdn.example/me.jpg',
            profile_pic_thumb: 'https://cdn.example/me-thumb.jpg',
            is_verified: true,
          },
        },
      });
      await renderSettings();

      expect(row(/^View profile photo$/)).toBeInTheDocument();
      expect(
        within(screen.getByRole('heading', { level: 2, name: /testuser/ })).getByRole('img', {
          name: 'Verified account',
        })
      ).toBeInTheDocument();
      expect(useAuthStore.getState().user).toMatchObject({
        profilePic: 'https://cdn.example/me.jpg',
        profilePicThumb: 'https://cdn.example/me-thumb.jpg',
      });
      expect(localStorage.getItem(STORAGE_KEYS.PROFILE_PIC)).toBe('https://cdn.example/me.jpg');
    });

    it('ignores unsuccessful responses', async () => {
      serve({
        get: {
          '/get-privacy': { success: false, is_private: true },
          '/profile': { success: false, bio: 'Not mine', is_verified: true },
          '/badges': { success: false, badges: BADGES },
          '/users/1/follow-counts': { success: false },
        },
        post: { '/get-streak': { success: false } },
      });
      await renderSettings();

      expect(privacySwitch()).not.toBeChecked();
      expect(row(/^Add a bio$/)).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Verified account' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Streak badges' })).not.toBeInTheDocument();
      expect(row(/^0\s*Followers$/)).toBeInTheDocument();
    });

    it('still works when the background requests fail', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const offline = () => new TypeError('Failed to fetch');
      serve({
        get: {
          '/get-privacy': offline(),
          '/profile': offline(),
          '/badges': offline(),
          '/me/follow-requests/incoming?limit=1': offline(),
          '/users/1/follow-counts': offline(),
        },
        post: { '/get-streak': offline() },
      });
      await renderSettings();

      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
      expect(row(/^Username\s*@testuser$/)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Streak badges' })).not.toBeInTheDocument();
      expect(warn.mock.calls.map(([message]) => message)).toEqual(
        expect.arrayContaining([
          '[SettingsPage] Failed to load privacy setting',
          '[SettingsPage] Failed to load profile',
          '[SettingsPage] Failed to load badges',
          '[SettingsPage] Failed to load streak',
        ])
      );
    });
  });

  describe('account', () => {
    it('changes the username everywhere it is shown and stored', async () => {
      serve({ post: { '/update-username': { success: true, new_username: 'new_name' } } });
      const { user } = await renderSettings();

      await user.click(row(/^Username\s*@testuser$/));
      const dialog = screen.getByRole('dialog', { name: 'Change username' });
      const input = within(dialog).getByRole('textbox', { name: 'Username' });
      await user.clear(input);
      await user.type(input, 'new_name');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Username updated!');
      expect(screen.queryByRole('dialog', { name: 'Change username' })).not.toBeInTheDocument();
      expect(row(/^Username\s*@new_name$/)).toBeInTheDocument();
      expect(useAuthStore.getState().user?.username).toBe('new_name');
      expect(localStorage.getItem(STORAGE_KEYS.USERNAME)).toBe('new_name');
    });

    it('keeps the username when the new one is taken', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      serve({
        post: { '/update-username': new ApiError('Username already taken', 409, 'USERNAME_TAKEN') },
      });
      const { user } = await renderSettings();

      await user.click(row(/^Username\s*@testuser$/));
      const input = screen.getByRole('textbox', { name: 'Username' });
      await user.clear(input);
      await user.type(input, 'bob');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Username already taken');
      expect(useAuthStore.getState().user?.username).toBe('testuser');
      expect(localStorage.getItem(STORAGE_KEYS.USERNAME)).toBe('testuser');
    });

    it('confirms a password change', async () => {
      serve({ post: { '/change-password': { success: true } } });
      const { user } = await renderSettings();

      await user.click(row(/^Password\s*Change your password$/));
      await user.type(screen.getByLabelText('Current password'), 'oldpass123');
      await user.type(screen.getByLabelText('New password'), 'newpass456');
      await user.click(screen.getByRole('button', { name: 'Update' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Password changed successfully!');
      expect(screen.queryByRole('dialog', { name: 'Change password' })).not.toBeInTheDocument();
    });

    it('edits the bio and stores it', async () => {
      serve({ post: { '/update-bio': { success: true, bio: 'Growing every day' } } });
      const { user } = await renderSettings();

      await user.click(row(/^Edit bio: Reading daily$/));
      const bio = screen.getByRole('textbox', { name: 'Bio' });
      expect(bio).toHaveValue('Reading daily');
      await user.clear(bio);
      await user.type(bio, 'Growing every day');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Bio updated!');
      expect(row(/^Edit bio: Growing every day$/)).toBeInTheDocument();
      expect(localStorage.getItem(STORAGE_KEYS.BIO)).toBe('Growing every day');
    });

    it('removes the bio when it is cleared', async () => {
      serve({ post: { '/update-bio': { success: true, bio: '' } } });
      const { user } = await renderSettings();

      await user.click(row(/^Edit bio: Reading daily$/));
      await user.clear(screen.getByRole('textbox', { name: 'Bio' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('button', { name: 'Add a bio' })).toBeInTheDocument();
      expect(useAuthStore.getState().user?.bio).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.BIO)).toBeNull();
    });
  });

  describe('private account', () => {
    it('makes the account private', async () => {
      serve({ post: { '/update-privacy': { success: true, is_private: true } } });
      const { user } = await renderSettings();

      expect(privacySwitch()).not.toBeChecked();
      expect(privacySwitch()).toHaveAccessibleDescription('Anyone can see your days and insights');

      await user.click(privacySwitch());

      expect(api.post).toHaveBeenCalledWith('/update-privacy', { is_private: true });
      expect(await screen.findByRole('status')).toHaveTextContent('Your account is now private');
      expect(privacySwitch()).toBeChecked();
      expect(privacySwitch()).toHaveAccessibleDescription(
        'Only approved followers can see your days and insights'
      );
      expect(gl.track).toHaveBeenCalledWith('privacy_toggled', {
        properties: { isPrivate: true },
      });
    });

    it('makes a private account public again', async () => {
      serve({
        get: { '/get-privacy': { success: true, is_private: true } },
        post: { '/update-privacy': { success: true, is_private: false } },
      });
      const { user } = await renderSettings();
      expect(privacySwitch()).toBeChecked();

      await user.click(privacySwitch());

      expect(api.post).toHaveBeenCalledWith('/update-privacy', { is_private: false });
      expect(await screen.findByRole('status')).toHaveTextContent('Your account is now public');
      expect(privacySwitch()).not.toBeChecked();
    });

    it('keeps keyboard focus on the switch and ignores repeat presses while saving', async () => {
      const request = deferred<unknown>();
      serve({ post: { '/update-privacy': request.promise } });
      const { user } = await renderSettings();

      privacySwitch().focus();
      await user.keyboard(' ');

      expect(privacySwitch()).toHaveAttribute('aria-busy', 'true');
      expect(privacySwitch()).toHaveFocus();
      await user.keyboard(' ');
      await user.keyboard('{Enter}');
      expect(
        api.post.mock.calls.filter(([endpoint]) => endpoint === '/update-privacy')
      ).toHaveLength(1);

      await act(async () => request.resolve({ success: true, is_private: true }));

      expect(privacySwitch()).toBeChecked();
      expect(privacySwitch()).not.toHaveAttribute('aria-busy');
      expect(privacySwitch()).toHaveFocus();
    });

    it('stays as it was and says so when saving fails', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      serve({ post: { '/update-privacy': new ApiError('Internal server error', 500) } });
      const { user } = await renderSettings();

      await user.click(privacySwitch());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't update your privacy setting. Try again."
      );
      expect(privacySwitch()).not.toBeChecked();
      expect(privacySwitch()).not.toHaveAttribute('aria-busy');
      expect(errorLog).toHaveBeenCalledWith('[Settings] Failed to update privacy', {
        code: 'HTTP_500',
      });
    });

    it('stays as it was when the server rejects the change', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serve({ post: { '/update-privacy': { success: false, error_code: 'RATE_LIMITED' } } });
      const { user } = await renderSettings();

      await user.click(privacySwitch());

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't update your privacy setting. Try again."
      );
      expect(privacySwitch()).not.toBeChecked();
      expect(warn).toHaveBeenCalledWith('[Settings] Privacy update rejected', {
        code: 'RATE_LIMITED',
      });
    });
  });

  describe('people', () => {
    it('shows waiting follow requests and opens them', async () => {
      serve({
        get: {
          '/me/follow-requests/incoming?limit=1': { success: true, requests: [], total_count: 3 },
        },
      });
      const { user } = await renderSettings();

      await user.click(row(/^Follow requests\s*3 waiting for your answer\s*3$/));
      expect(screen.getByRole('dialog', { name: 'Follow requests' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Close requests' }));
      expect(screen.queryByRole('dialog', { name: 'Follow requests' })).not.toBeInTheDocument();
    });

    it('opens your followers and the people you follow', async () => {
      const { user } = await renderSettings();

      await user.click(row(/^12\s*Followers$/));
      expect(
        screen.getByRole('dialog', { name: 'followers of testuser (#1)' })
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Close list' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      await user.click(row(/^3\s*Following$/));
      expect(
        screen.getByRole('dialog', { name: 'following of testuser (#1)' })
      ).toBeInTheDocument();
    });
  });

  describe('appearance', () => {
    it('switches between light, dark and automatic themes', async () => {
      const { user } = await renderSettings();
      const theme = screen.getByRole('radiogroup', { name: 'Theme' });

      expect(within(theme).getByRole('radio', { name: /Auto/ })).toBeChecked();
      expect(screen.getByText('Follows your device setting')).toBeInTheDocument();

      await user.click(within(theme).getByRole('radio', { name: 'Dark' }));
      expect(useThemeStore.getState().theme).toBe('dark');
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(screen.getByText('Easy on the eyes')).toBeInTheDocument();
      expect(localStorage.getItem(STORAGE_KEYS.THEME)).toContain('"theme":"dark"');

      await user.keyboard('{ArrowLeft}');
      expect(useThemeStore.getState().theme).toBe('light');
      expect(within(theme).getByRole('radio', { name: 'Light' })).toHaveFocus();
      expect(document.documentElement).not.toHaveAttribute('data-theme');
      expect(screen.getByText('Bright and airy')).toBeInTheDocument();
    });
  });

  describe('profile photo', () => {
    const photo = () => new File(['png-bytes'], 'me.png', { type: 'image/png' });

    it('offers photo options from the avatar and opens the file picker', async () => {
      const { user, container } = await renderSettings();
      const pick = vi.spyOn(fileInput(container), 'click');

      await user.click(screen.getAllByRole('button', { name: 'Add a profile photo' })[0]);
      await user.click(
        within(screen.getByRole('dialog', { name: 'Profile photo' })).getByRole('button', {
          name: /Upload a photo/,
        })
      );

      expect(pick).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog', { name: 'Profile photo' })).not.toBeInTheDocument();
    });

    it('uploads a chosen photo and shows it', async () => {
      const upload = deferred<unknown>();
      api.uploadFile.mockReturnValue(upload.promise);
      const { user, container } = await renderSettings();
      const file = photo();

      await user.upload(fileInput(container), file);

      expect(api.uploadFile).toHaveBeenCalledWith('/profile/upload-picture', file);
      expect(screen.getByRole('status')).toHaveTextContent('Uploading photo…');
      screen
        .getAllByRole('button', { name: 'Add a profile photo' })
        .forEach((button) => expect(button).toBeDisabled());

      await act(async () =>
        upload.resolve({
          success: true,
          profile_pic: 'https://cdn.example/new.jpg',
          profile_pic_thumb: 'https://cdn.example/new-thumb.jpg',
        })
      );

      expect(screen.getByRole('status')).toHaveTextContent('Profile picture updated!');
      expect(row(/^View profile photo$/)).toBeEnabled();
      expect(useAuthStore.getState().user?.profilePicThumb).toBe(
        'https://cdn.example/new-thumb.jpg'
      );
      expect(localStorage.getItem(STORAGE_KEYS.PROFILE_PIC)).toBe('https://cdn.example/new.jpg');
      expect(fileInput(container).value).toBe('');
    });

    it('accepts HEIC photos recognised by their extension', async () => {
      api.uploadFile.mockResolvedValue({ success: true });
      const { container } = await renderSettings();
      const heic = new File(['heic'], 'IMG_0001.HEIC', { type: '' });

      fireEvent.change(fileInput(container), { target: { files: [heic] } });

      await waitFor(() =>
        expect(api.uploadFile).toHaveBeenCalledWith('/profile/upload-picture', heic)
      );
    });

    it.each([
      [
        'a file that is not an image',
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        'Only JPG, PNG, WebP, and HEIC images are allowed',
      ],
      [
        'a file without an image type or extension',
        new File(['?'], 'scan.', { type: '' }),
        'Only JPG, PNG, WebP, and HEIC images are allowed',
      ],
      [
        'an image over 5 MB',
        Object.defineProperty(new File(['big'], 'big.png', { type: 'image/png' }), 'size', {
          value: 5 * 1024 * 1024 + 1,
        }),
        'Image size must be less than 5MB',
      ],
    ])('refuses %s before uploading', async (_label, file, message) => {
      const { container } = await renderSettings();

      fireEvent.change(fileInput(container), { target: { files: [file] } });

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(api.uploadFile).not.toHaveBeenCalled();
    });

    it('does nothing when the picker is cancelled', async () => {
      const { container } = await renderSettings();

      fireEvent.change(fileInput(container), { target: { files: [] } });

      expect(api.uploadFile).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
      ['the upload fails', new ApiError('Too large', 413), 'Failed to upload image'],
      [
        'the server rejects the image',
        { success: false, error: 'Image is corrupted' },
        'Image is corrupted',
      ],
      ['the server gives no reason', { success: false }, 'Failed to upload image'],
    ])('explains when %s', async (_label, response, message) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (response instanceof Error) api.uploadFile.mockRejectedValue(response);
      else api.uploadFile.mockResolvedValue(response);
      const { user, container } = await renderSettings();

      await user.upload(fileInput(container), photo());

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(useAuthStore.getState().user?.profilePic).toBeFalsy();
      expect(screen.getAllByRole('button', { name: 'Add a profile photo' })[0]).toBeEnabled();
    });

    describe('with a photo', () => {
      beforeEach(() => {
        serve({
          get: {
            '/profile': {
              success: true,
              profile_pic: 'https://cdn.example/me.jpg',
              profile_pic_thumb: 'https://cdn.example/me-thumb.jpg',
            },
          },
        });
      });

      it('shows the photo full screen from the avatar', async () => {
        const { user } = await renderSettings();

        await user.click(row(/^View profile photo$/));
        const viewer = screen.getByRole('dialog', { name: "testuser's profile photo" });
        expect(within(viewer).getByRole('img', { name: 'testuser' })).toBeInTheDocument();

        await user.click(within(viewer).getByRole('button', { name: 'Close photo' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      it('removes the photo', async () => {
        api.delete.mockResolvedValue({ success: true });
        const { user } = await renderSettings();

        await user.click(row(/^Change profile photo$/));
        await user.click(screen.getByRole('button', { name: /Remove photo/ }));

        expect(api.delete).toHaveBeenCalledWith('/profile/picture');
        expect(await screen.findByRole('status')).toHaveTextContent('Profile picture removed');
        expect(screen.getAllByRole('button', { name: 'Add a profile photo' })).toHaveLength(2);
        expect(useAuthStore.getState().user?.profilePic).toBeNull();
        expect(localStorage.getItem(STORAGE_KEYS.PROFILE_PIC)).toBeNull();
      });

      it.each([
        ['the request fails', new TypeError('Failed to fetch'), 'Failed to remove image'],
        ['the server refuses', { success: false, error: 'Photo is locked' }, 'Photo is locked'],
        ['the server gives no reason', { success: false }, 'Failed to remove image'],
      ])('keeps the photo when %s', async (_label, response, message) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        if (response instanceof Error) api.delete.mockRejectedValue(response);
        else api.delete.mockResolvedValue(response);
        const { user } = await renderSettings();

        await user.click(row(/^Change profile photo$/));
        await user.click(screen.getByRole('button', { name: /Remove photo/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent(message);
        expect(row(/^View profile photo$/)).toBeInTheDocument();
      });
    });
  });

  describe('notifications', () => {
    it('confirms when push notifications are turned on', async () => {
      setPushEnvironment({ permission: 'default' });
      vi.mocked(pushService.subscribe).mockResolvedValue({ success: true });
      const { user } = await renderSettings();

      await user.click(screen.getByRole('switch', { name: 'Push notifications' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Notifications turned on');
    });
  });

  it('lets the user swipe a confirmation away', async () => {
    serve({ post: { '/update-privacy': { success: true, is_private: true } } });
    const { user } = await renderSettings();
    await user.click(privacySwitch());
    const toast = await screen.findByRole('status');

    fireEvent.touchStart(toast, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(toast, { touches: [{ clientX: 100, clientY: 40 }] });
    fireEvent.touchEnd(toast);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('links to the help site in a new tab', async () => {
    await renderSettings();

    const help = screen.getByRole('link', { name: /^FAQs & help/ });
    expect(help).toHaveAttribute('href', 'http://localhost:5174');
    expect(help).toHaveAttribute('target', '_blank');
  });

  describe('log out', () => {
    it('stays signed in when the confirmation is cancelled', async () => {
      const { user } = await renderSettings();

      await user.click(row(/^Log out$/));
      await user.click(
        within(screen.getByRole('alertdialog', { name: 'Log out?' })).getByRole('button', {
          name: 'Cancel',
        })
      );

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(useAuthStore.getState().user?.username).toBe('testuser');
    });

    it('signs out and replaces the screen with login after confirming', async () => {
      const { user } = await renderSettings();

      await user.click(row(/^Log out$/));
      await user.click(
        within(screen.getByRole('alertdialog', { name: 'Log out?' })).getByRole('button', {
          name: 'Log out',
        })
      );

      expect(screen.getByTestId('location')).toHaveTextContent('/login');
      expect(useAuthStore.getState().user).toBeNull();
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBeNull();
      expect(gl.track).toHaveBeenCalledWith('logout');
    });
  });
});
