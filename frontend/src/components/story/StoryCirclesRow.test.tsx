import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../../store/useAuthStore';
import { activityPhoto, deferred, storyGroup } from '../../test/fixtures/social';
import { signIn } from '../../test/utils';
import type { ActivityName } from '../../types';
import type { ActivityPhoto } from '../../types/story';
import StoryCirclesRowDefault, {
  StoryCirclesRow,
  type StoryCirclesRowProps,
} from './StoryCirclesRow';
import styles from './StoryCirclesRow.module.css';

const photoApi = vi.hoisted(() => ({
  getPhotos: vi.fn(),
  getFollowingStories: vi.fn(),
  uploadPhoto: vi.fn(),
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  activityPhotoApi: photoApi,
}));

// useThemeStore reads matchMedia while modules load, before setup.ts stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

const TODAY = new Date(2026, 9, 21, 12, 0, 0);
const DATE = '2026-10-21';
const LONG_AGO = new Date(2026, 9, 1, 12, 0, 0);
const ACTIVITIES: ActivityName[] = ['workout', 'sleep', 'custom:tile-1'];
const CUSTOM_TILES = [{ id: 'tile-1', name: 'Guitar', icon: 'Guitar', color: '#ff00aa' }];

const ownPhoto = (overrides: Partial<ActivityPhoto>) => activityPhoto({ user_id: 1, ...overrides });

function renderRow(props: Partial<StoryCirclesRowProps> = {}) {
  const onPhotoClick = vi.fn();
  const base: StoryCirclesRowProps = {
    currentDate: TODAY,
    targetUserId: 1,
    targetUsername: 'alice',
    isOwnProfile: true,
    activities: ACTIVITIES,
    customTiles: CUSTOM_TILES,
    colorOverrides: {},
    isEditMode: false,
    onPhotoClick,
    ...props,
  };
  const view = render(<StoryCirclesRow {...base} />);
  const rerender = (next: Partial<StoryCirclesRowProps>) =>
    view.rerender(<StoryCirclesRow {...base} {...next} />);
  return { ...view, rerender, onPhotoClick, user: userEvent.setup() };
}

const stories = () => screen.findByRole('region', { name: 'Stories' });
const fileInputs = (container: HTMLElement) => ({
  camera: container.querySelector<HTMLInputElement>('input[type="file"][capture]')!,
  gallery: container.querySelector<HTMLInputElement>('input[type="file"]:not([capture])')!,
});
const jpeg = (name = 'run.jpg') => new File(['photo-bytes'], name, { type: 'image/jpeg' });

/** Opens the activity picker from the "+" badge and picks an activity. */
async function chooseActivity(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('button', { name: 'Add new story' }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Add to your story' })).getByRole('button', {
      name: label,
    })
  );
}

describe('StoryCirclesRow', () => {
  beforeEach(() => {
    vi.setSystemTime(TODAY);
    signIn({ id: 1, username: 'alice', profilePic: 'https://cdn.test/alice.jpg' });
    photoApi.getPhotos.mockResolvedValue({ success: true, photos: [] });
    photoApi.getFollowingStories.mockResolvedValue({ success: true, stories: [] });
    // Overlay history logs every modal open/close in development builds.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  describe('visibility', () => {
    it('shows skeleton circles while stories load', async () => {
      photoApi.getPhotos.mockReturnValue(deferred().promise);
      renderRow();

      const region = await stories();
      expect(within(region).queryByRole('button')).not.toBeInTheDocument();
      expect(photoApi.getPhotos).toHaveBeenCalledWith(1, DATE);
    });

    it('renders nothing in edit mode', async () => {
      renderRow({ isEditMode: true });

      await waitFor(() => expect(photoApi.getPhotos).toHaveBeenCalled());
      expect(screen.queryByRole('region', { name: 'Stories' })).not.toBeInTheDocument();
    });

    it('stays hidden on another user’s profile but hands their photos to the parent', async () => {
      const photos = [activityPhoto({ id: 7, user_id: 2 })];
      photoApi.getPhotos.mockResolvedValue({ success: true, photos });
      const onTargetUserPhotos = vi.fn();
      renderRow({
        isOwnProfile: false,
        targetUserId: 2,
        targetUsername: 'bob',
        onTargetUserPhotos,
      });

      await waitFor(() => expect(onTargetUserPhotos).toHaveBeenCalledWith(photos));
      expect(photoApi.getPhotos).toHaveBeenCalledWith(2, DATE);
      expect(photoApi.getFollowingStories).not.toHaveBeenCalled();
      expect(screen.queryByRole('region', { name: 'Stories' })).not.toBeInTheDocument();
    });

    it('waits for a signed-in user before fetching', async () => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
      renderRow();

      await act(async () => {});
      expect(photoApi.getPhotos).not.toHaveBeenCalled();
    });

    it('does not fetch another profile without a user id', async () => {
      renderRow({ isOwnProfile: false, targetUserId: 0 });

      await act(async () => {});
      expect(photoApi.getPhotos).not.toHaveBeenCalled();
    });

    it('renders nothing for an old day without any stories', async () => {
      renderRow({ currentDate: LONG_AGO });

      await waitFor(() => expect(photoApi.getFollowingStories).toHaveBeenCalledWith('2026-10-01'));
      expect(screen.queryByRole('region', { name: 'Stories' })).not.toBeInTheDocument();
    });

    it('still shows an old day’s stories, without the option to add more', async () => {
      photoApi.getPhotos.mockResolvedValue({ success: true, photos: [ownPhoto({ id: 1 })] });
      renderRow({ currentDate: LONG_AGO });

      expect(await screen.findByRole('button', { name: 'View your story' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Add new story' })).not.toBeInTheDocument();
    });

    it('renders nothing when stories cannot be loaded', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('offline');
      photoApi.getPhotos.mockRejectedValue(failure);
      renderRow();

      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith('Failed to fetch stories:', failure)
      );
      expect(screen.queryByRole('region', { name: 'Stories' })).not.toBeInTheDocument();
    });

    it('tolerates responses without photo or story lists', async () => {
      photoApi.getPhotos.mockResolvedValue({ success: true });
      photoApi.getFollowingStories.mockResolvedValue({ success: true });
      renderRow();

      expect(await screen.findByRole('button', { name: 'Add to your story' })).toBeEnabled();
    });
  });

  describe('your story', () => {
    it('invites you to add a story when you have none', async () => {
      renderRow();

      expect(await screen.findByRole('button', { name: 'Add to your story' })).toBeEnabled();
      expect(screen.getByText('Add story')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add new story' })).toBeEnabled();
      expect(screen.getByRole('img', { name: 'alice' })).toHaveAttribute(
        'src',
        'https://cdn.test/alice.jpg'
      );
    });

    it('opens your photos oldest first', async () => {
      const later = ownPhoto({ id: 2, activity_name: 'sleep', created_at: '2026-10-21T10:00:00Z' });
      const earlier = ownPhoto({
        id: 1,
        activity_name: 'workout',
        created_at: '2026-10-21T08:00:00Z',
      });
      photoApi.getPhotos.mockResolvedValue({ success: true, photos: [later, earlier] });
      const { user, onPhotoClick } = renderRow();

      await user.click(await screen.findByRole('button', { name: 'View your story' }));

      expect(screen.getByText('Your story')).toBeInTheDocument();
      expect(onPhotoClick).toHaveBeenCalledWith(
        [earlier, later],
        0,
        'Your Story',
        'https://cdn.test/alice.jpg',
        true,
        { onPhotoDeleted: expect.any(Function), onPhotosViewed: expect.any(Function) }
      );
    });

    it('drops a photo deleted from the viewer', async () => {
      photoApi.getPhotos.mockResolvedValue({ success: true, photos: [ownPhoto({ id: 1 })] });
      const { user, onPhotoClick } = renderRow();
      await user.click(await screen.findByRole('button', { name: 'View your story' }));
      const handlers = onPhotoClick.mock.calls[0][5];

      act(() => {
        handlers.onPhotosViewed([1]);
        handlers.onPhotoDeleted(1);
      });

      expect(screen.getByRole('button', { name: 'Add to your story' })).toBeInTheDocument();
    });

    it('hides the "+" badge once every activity has a photo', async () => {
      photoApi.getPhotos.mockResolvedValue({
        success: true,
        photos: ACTIVITIES.map((activity_name, i) => ownPhoto({ id: i + 1, activity_name })),
      });
      renderRow();

      expect(await screen.findByRole('button', { name: 'View your story' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Add new story' })).not.toBeInTheDocument();
    });
  });

  describe("friends' stories", () => {
    const seen = (id: number) => activityPhoto({ id, user_id: 2, viewed: true });
    const unseen = (id: number) => activityPhoto({ id, user_id: 2, viewed: false });

    it('lists friends with new stories first highlighted', async () => {
      photoApi.getFollowingStories.mockResolvedValue({
        success: true,
        stories: [
          storyGroup({ user_id: 2, username: 'bob', has_unseen: true }),
          storyGroup({ user_id: 3, username: 'carol', has_unseen: false }),
        ],
      });
      renderRow();

      expect(await screen.findByRole('button', { name: "View bob's story (new)" })).toBeEnabled();
      expect(screen.getByRole('button', { name: "View carol's story" })).toBeEnabled();
      expect(photoApi.getFollowingStories).toHaveBeenCalledWith(DATE);
    });

    it.each([
      ['at the first photo they have not seen', [seen(21), unseen(22), unseen(23)], 1],
      ['from the start when they have seen everything', [seen(21), seen(22)], 0],
    ])('opens a friend’s story %s', async (_label, photos, startIndex) => {
      const group = storyGroup({
        user_id: 2,
        username: 'bob',
        profile_pic: 'https://cdn.test/bob.jpg',
        photos,
        has_unseen: startIndex > 0,
      });
      photoApi.getFollowingStories.mockResolvedValue({ success: true, stories: [group] });
      const { user, onPhotoClick } = renderRow();

      await user.click(await screen.findByRole('button', { name: /^View bob's story/ }));

      expect(onPhotoClick).toHaveBeenCalledWith(
        photos,
        startIndex,
        'bob',
        'https://cdn.test/bob.jpg',
        false,
        { onPhotoDeleted: expect.any(Function), onPhotosViewed: expect.any(Function) }
      );
    });

    it('marks a friend’s story as seen once every photo was viewed', async () => {
      photoApi.getFollowingStories.mockResolvedValue({
        success: true,
        stories: [
          storyGroup({ user_id: 2, username: 'bob', photos: [unseen(21), unseen(22)] }),
          storyGroup({ user_id: 3, username: 'carol', photos: [unseen(31)] }),
        ],
      });
      const { user, onPhotoClick } = renderRow();
      await user.click(await screen.findByRole('button', { name: "View bob's story (new)" }));
      const { onPhotosViewed } = onPhotoClick.mock.calls[0][5];

      act(() => onPhotosViewed([21]));
      expect(screen.getByRole('button', { name: "View bob's story (new)" })).toBeInTheDocument();

      act(() => onPhotosViewed([21, 22]));
      expect(screen.getByRole('button', { name: "View bob's story" })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: "View carol's story (new)" })).toBeInTheDocument();
    });
  });

  describe('adding a photo', () => {
    it('lists only activities without a photo, sorted by name', async () => {
      photoApi.getPhotos.mockResolvedValue({
        success: true,
        photos: [ownPhoto({ id: 1, activity_name: 'sleep' })],
      });
      const { user } = renderRow({ activities: [...ACTIVITIES, 'yoga' as ActivityName] });

      await user.click(await screen.findByRole('button', { name: 'Add new story' }));

      const picker = screen.getByRole('dialog', { name: 'Add to your story' });
      expect(within(picker).getByText('Which activity is this photo for?')).toBeInTheDocument();
      const options = within(picker)
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-label') !== 'Close');
      expect(options.map((option) => option.textContent)).toEqual(['Guitar', 'Workout', 'Yoga']);
    });

    it('opens the activity picker from your story ring too', async () => {
      const { user } = renderRow();

      await user.click(await screen.findByRole('button', { name: 'Add to your story' }));

      expect(screen.getByRole('dialog', { name: 'Add to your story' })).toBeInTheDocument();
    });

    it.each([
      ['Take photo', 'camera'],
      ['Choose photo', 'gallery'],
    ] as const)('"%s" opens the %s picker for the chosen activity', async (option, source) => {
      const { user, container } = renderRow();
      const onOpen = vi.fn();
      fileInputs(container)[source].addEventListener('click', onOpen);

      await chooseActivity(user, 'Workout');
      const sourcePicker = screen.getByRole('dialog', { name: 'Add photo' });
      expect(within(sourcePicker).getByText('For Workout')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Add to your story' })).not.toBeInTheDocument();
      await user.click(within(sourcePicker).getByRole('button', { name: new RegExp(option) }));

      expect(screen.queryByRole('dialog', { name: 'Add photo' })).not.toBeInTheDocument();
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    });

    it('uploads the photo and adds it to your story', async () => {
      const upload = deferred<unknown>();
      photoApi.uploadPhoto.mockReturnValue(upload.promise);
      const { user, container } = renderRow();
      await chooseActivity(user, 'Workout');

      fireEvent.change(fileInputs(container).gallery, { target: { files: [jpeg()] } });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(photoApi.uploadPhoto).toHaveBeenCalled());
      const [file, activity, date, metadata] = photoApi.uploadPhoto.mock.calls[0];
      expect(file).toBeInstanceOf(File);
      expect(file).toMatchObject({ name: 'run.jpg', type: 'image/jpeg' });
      expect([activity, date, metadata]).toEqual(['workout', DATE, undefined]);
      const ring = screen.getByRole('button', { name: 'Add to your story' });
      expect(ring).toHaveAttribute('aria-busy', 'true');
      expect(ring).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add new story' })).toBeDisabled();

      await act(async () =>
        upload.resolve({ success: true, photo: ownPhoto({ id: 9, activity_name: 'workout' }) })
      );

      expect(screen.getByRole('status')).toHaveTextContent('Photo uploaded!');
      expect(screen.getByRole('button', { name: 'View your story' })).toBeEnabled();
    });

    it.each([
      ['its own color', {}, '#ff00aa'],
      ['the color override', { 'custom:tile-1': '#123456' }, '#123456'],
    ])('sends custom tile details with %s', async (_label, colorOverrides, color) => {
      photoApi.uploadPhoto.mockResolvedValue({ success: true, photo: ownPhoto({ id: 9 }) });
      const { user, container } = renderRow({ colorOverrides });
      await chooseActivity(user, 'Guitar');

      fireEvent.change(fileInputs(container).camera, { target: { files: [jpeg()] } });

      await waitFor(() =>
        expect(photoApi.uploadPhoto).toHaveBeenCalledWith(expect.any(File), 'custom:tile-1', DATE, {
          icon: 'Guitar',
          color,
          label: 'Guitar',
        })
      );
    });

    it.each([
      [
        'a file that is not an image',
        new File(['x'], 'notes.txt', { type: 'text/plain' }),
        'Please select a JPEG, PNG, or WebP image',
      ],
      [
        'an image over 5MB',
        Object.defineProperty(jpeg('huge.jpg'), 'size', { value: 6 * 1024 * 1024 }),
        'Image must be less than 5MB',
      ],
    ])('rejects %s', async (_label, file, message) => {
      const { user, container } = renderRow();
      await chooseActivity(user, 'Workout');

      fireEvent.change(fileInputs(container).gallery, { target: { files: [file] } });

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(photoApi.uploadPhoto).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Add new story' })).toBeEnabled();
    });

    it.each([
      [
        'the server’s reason',
        { success: false, error: 'Daily limit reached' },
        'Daily limit reached',
      ],
      ['a generic message', { success: false }, 'Upload failed'],
    ])('shows %s as an error when the upload is refused', async (_label, response, message) => {
      photoApi.uploadPhoto.mockResolvedValue(response);
      const { user, container } = renderRow();
      await chooseActivity(user, 'Workout');

      fireEvent.change(fileInputs(container).gallery, { target: { files: [jpeg()] } });

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add to your story' })).toBeEnabled();
    });

    it.each([
      ['the error message', new Error('Network down'), 'Network down'],
      ['a generic message for unknown errors', 'boom', 'Upload failed'],
    ])('shows %s as an error when the upload throws', async (_label, failure, message) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      photoApi.uploadPhoto.mockRejectedValue(failure);
      const { user, container } = renderRow();
      await chooseActivity(user, 'Workout');

      fireEvent.change(fileInputs(container).gallery, { target: { files: [jpeg()] } });

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith('Upload error:', failure);
    });

    it('does nothing when the picker is dismissed without a file', async () => {
      const { user, container } = renderRow();
      await chooseActivity(user, 'Workout');

      fireEvent.change(fileInputs(container).gallery, { target: { files: [] } });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(photoApi.uploadPhoto).not.toHaveBeenCalled();
    });

    it('forgets the chosen activity when the source picker is closed', async () => {
      const { user, container } = renderRow();
      await chooseActivity(user, 'Workout');

      await user.click(
        within(screen.getByRole('dialog', { name: 'Add photo' })).getByRole('button', {
          name: 'Close',
        })
      );
      fireEvent.change(fileInputs(container).gallery, { target: { files: [jpeg()] } });

      expect(photoApi.uploadPhoto).not.toHaveBeenCalled();
    });

    it('closes the activity picker without choosing', async () => {
      const { user } = renderRow();
      await user.click(await screen.findByRole('button', { name: 'Add new story' }));

      await user.click(
        within(screen.getByRole('dialog', { name: 'Add to your story' })).getByRole('button', {
          name: 'Close',
        })
      );

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('uses dark icons on bright activity colors', async () => {
      const { user } = renderRow({ colorOverrides: { workout: '#fde047' } });

      await user.click(await screen.findByRole('button', { name: 'Add new story' }));

      const icon = (label: string) =>
        screen.getByRole('button', { name: label }).querySelector(`.${styles.pickerIcon}`);
      expect(icon('Workout')).toHaveClass(styles.pickerIconDark);
      expect(icon('Sleep')).not.toHaveClass(styles.pickerIconDark);
    });

    describe('with fake timers', () => {
      beforeEach(() => {
        // Replace the plain Date mock with a fake clock that starts at the same moment.
        vi.useRealTimers();
        vi.useFakeTimers({ now: TODAY });
      });
      // Unmount with real timers so overlay history cleanup is not stranded on fake timers.
      afterEach(() => {
        vi.useRealTimers();
      });

      it('hides the upload confirmation after a few seconds', async () => {
        photoApi.uploadPhoto.mockResolvedValue({ success: true, photo: ownPhoto({ id: 9 }) });
        const { container } = renderRow();
        await act(async () => {});
        fireEvent.click(screen.getByRole('button', { name: 'Add new story' }));
        fireEvent.click(screen.getByRole('button', { name: 'Workout' }));

        fireEvent.change(fileInputs(container).gallery, { target: { files: [jpeg()] } });
        await act(async () => {});
        expect(screen.getByRole('status')).toHaveTextContent('Photo uploaded!');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2750);
        });
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      });
    });
  });

  it('reloads when switching between profiles', async () => {
    photoApi.getPhotos.mockResolvedValue({ success: true, photos: [ownPhoto({ id: 1 })] });
    const { rerender } = renderRow();
    await screen.findByRole('button', { name: 'View your story' });

    photoApi.getPhotos.mockResolvedValue({ success: true, photos: [] });
    rerender({ isOwnProfile: false, targetUserId: 2 });
    await waitFor(() => expect(photoApi.getPhotos).toHaveBeenLastCalledWith(2, DATE));
    rerender({ isOwnProfile: true, targetUserId: 1 });

    expect(await screen.findByRole('button', { name: 'Add to your story' })).toBeInTheDocument();
  });

  it('is exported as the default export', () => {
    expect(StoryCirclesRowDefault).toBe(StoryCirclesRow);
  });
});
