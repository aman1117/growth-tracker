import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { gl } from '../../services/goodlogs';
import { activityPhoto, deferred, photoInteraction } from '../../test/fixtures/social';
import { StoryViewer, type StoryViewerProps } from './StoryViewer';
import styles from './StoryViewer.module.css';

const photoApi = vi.hoisted(() => ({
  getPhotoInteractions: vi.fn(),
  getLikeStatus: vi.fn(),
  recordView: vi.fn(),
  likePhoto: vi.fn(),
  unlikePhoto: vi.fn(),
  deletePhoto: vi.fn(),
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

const SLEEP = activityPhoto({ id: 101, activity_name: 'sleep' });
const WORKOUT = activityPhoto({ id: 102, activity_name: 'workout' });
const GUITAR = activityPhoto({
  id: 103,
  activity_name: 'custom:tile-1',
  activity_label: 'Guitar',
  activity_icon: 'Guitar',
  activity_color: '#ff00aa',
});
const PHOTOS = [SLEEP, WORKOUT, GUITAR];

async function renderViewer(props: Partial<StoryViewerProps> = {}) {
  const onClose = vi.fn();
  const base: StoryViewerProps = {
    isOpen: true,
    photos: PHOTOS,
    ownerUsername: 'bob',
    isOwnStory: false,
    onClose,
    ...props,
  };
  const view = render(<StoryViewer {...base} />);
  // Settle the like-status / view / interactions requests fired on open.
  await act(async () => {});
  const rerender = async (next: Partial<StoryViewerProps>) => {
    view.rerender(<StoryViewer {...base} {...next} />);
    await act(async () => {});
  };
  return { ...view, onClose, rerender };
}

const viewer = () => screen.getByRole('dialog', { name: "bob's story" });
/** Only the current slide is exposed to assistive tech; neighbours are aria-hidden. */
const currentPhoto = () => screen.getByRole('img', { name: /^bob's .+ activity$/ });
const swipeTrack = () => currentPhoto().parentElement!.parentElement!;
const likeButton = () => screen.getByRole('button', { name: /like photo$/i });

/** The decorative heart shown after a double-tap like (aria-hidden, so only reachable by class). */
const likeBurst = () => document.querySelector(`.${styles.likeBurst}`);

/** Adds navigator.vibrate (jsdom has none) for the current test. */
function stubVibrate() {
  const vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, 'vibrate');
  });
  return vibrate;
}

/** Runs the current test in another IANA time zone. */
function stubTimeZone(timeZone: string) {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  vi.stubEnv('TZ', timeZone);
  // Removing TZ again does not reset Node's cached zone, so set the original back
  onTestFinished(() => {
    vi.stubEnv('TZ', localZone);
  });
}

describe('StoryViewer', () => {
  beforeEach(() => {
    photoApi.getPhotoInteractions.mockResolvedValue({ success: true, interactions: [], total: 0 });
    photoApi.getLikeStatus.mockResolvedValue({ success: true, liked: false, like_count: 0 });
    photoApi.recordView.mockResolvedValue({ success: true });
    photoApi.likePhoto.mockResolvedValue({ success: true });
    photoApi.unlikePhoto.mockResolvedValue({ success: true });
    photoApi.deletePhoto.mockResolvedValue({ success: true });
    // Overlay history logs every open/close in development builds.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  describe('rendering', () => {
    it('renders nothing while closed', async () => {
      await renderViewer({ isOpen: false, photos: [] });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(photoApi.recordView).not.toHaveBeenCalled();
    });

    it('does not record views or load like status for photos passed to a closed viewer', async () => {
      await renderViewer({ isOpen: false });

      expect(photoApi.recordView).not.toHaveBeenCalled();
      expect(photoApi.getLikeStatus).not.toHaveBeenCalled();
    });

    it('records the view and loads the like status once a closed viewer opens', async () => {
      const { rerender } = await renderViewer({ isOpen: false, startIndex: 1 });

      await rerender({ isOpen: true, startIndex: 1 });

      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
      expect(photoApi.recordView.mock.calls).toEqual([[102]]);
      expect(photoApi.getLikeStatus.mock.calls).toEqual([[102]]);
    });

    it('records the start photo, not the last one shown, when it reopens', async () => {
      const user = userEvent.setup();
      const { rerender } = await renderViewer();
      await user.click(screen.getByRole('button', { name: 'Go to photo 3 of 3' }));
      await rerender({ isOpen: false });
      photoApi.recordView.mockClear();
      photoApi.getLikeStatus.mockClear();

      await rerender({ isOpen: true });

      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
      expect(photoApi.recordView.mock.calls).toEqual([[101]]);
      expect(photoApi.getLikeStatus.mock.calls).toEqual([[101]]);
    });

    it('renders nothing when there are no photos', async () => {
      await renderViewer({ photos: [] });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows the current photo with the owner, activity and date', async () => {
      await renderViewer({ ownerProfilePic: 'https://cdn.test/bob.jpg' });

      expect(viewer()).toHaveAttribute('aria-modal', 'true');
      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
      expect(currentPhoto()).toHaveAttribute('src', SLEEP.photo_url);
      expect(within(viewer()).getByRole('img', { name: 'bob' })).toHaveAttribute(
        'src',
        'https://cdn.test/bob.jpg'
      );
      expect(within(viewer()).getByText('Sleep')).toBeInTheDocument();
      expect(within(viewer()).getByText('Oct 21, 2026')).toBeInTheDocument();
    });

    it('shows the calendar day of the photo in time zones west of UTC', async () => {
      stubTimeZone('America/Los_Angeles');
      await renderViewer();

      expect(within(viewer()).getByText('Oct 21, 2026')).toBeInTheDocument();
    });

    it('still formats a photo date sent as a full timestamp', async () => {
      await renderViewer({
        photos: [activityPhoto({ id: 105, photo_date: '2026-10-21T12:00:00Z' })],
      });

      expect(within(viewer()).getByText('Oct 21, 2026')).toBeInTheDocument();
    });

    it.each([
      ['a custom tile with its saved label', GUITAR, 'Guitar'],
      [
        'a custom tile without a saved label',
        activityPhoto({ id: 104, activity_name: 'custom:Piano' }),
        'Piano',
      ],
      [
        'an activity the app does not know',
        activityPhoto({ id: 105, activity_name: 'knitting' }),
        'Knitting',
      ],
    ])('labels %s', async (_label, photo, text) => {
      await renderViewer({ photos: [photo] });

      expect(within(viewer()).getByText(text)).toBeInTheDocument();
    });

    it('shows one progress segment per photo and marks the current and seen ones', async () => {
      await renderViewer({ startIndex: 1 });

      const segments = screen.getAllByRole('button', { name: /^Go to photo \d of 3$/ });
      expect(segments).toHaveLength(3);
      expect(segments[0]).toHaveClass(styles.segmentSeen);
      expect(segments[1]).toHaveAttribute('aria-current', 'step');
      expect(segments[2]).not.toHaveAttribute('aria-current');
      expect(segments[2]).not.toHaveClass(styles.segmentSeen);
    });

    it('hides the progress bar for a single photo', async () => {
      await renderViewer({ photos: [SLEEP] });

      expect(screen.queryByRole('button', { name: /^Go to photo/ })).not.toBeInTheDocument();
    });

    it('blocks the context menu on the photo', async () => {
      await renderViewer();

      expect(fireEvent.contextMenu(currentPhoto())).toBe(false);
    });

    it.each([
      ['the thumbnail', SLEEP, SLEEP.thumbnail_url],
      [
        'the full photo when there is no thumbnail',
        { ...SLEEP, thumbnail_url: '' },
        SLEEP.photo_url,
      ],
    ])('blurs %s behind the viewer', async (_label, photo, src) => {
      await renderViewer({ photos: [photo] });

      expect(viewer().querySelector('img[aria-hidden="true"]')).toHaveAttribute('src', src);
    });

    it('replaces a photo that fails to load with a message', async () => {
      await renderViewer({ photos: [SLEEP] });

      fireEvent.error(currentPhoto());

      expect(within(viewer()).getByText('Failed to load photo')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /activity$/ })).not.toBeInTheDocument();
    });

    it('locks page scrolling and touch gestures while open', async () => {
      const { unmount } = await renderViewer();

      expect(document.body.style.overflow).toBe('hidden');
      expect(document.body.style.touchAction).toBe('none');

      unmount();
      expect(document.body.style.overflow).toBe('');
      expect(document.body.style.touchAction).toBe('');
    });
  });

  describe('navigation and timed feedback', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    // Unmount with real timers so overlay history cleanup is not stranded on fake timers.
    afterEach(() => {
      vi.useRealTimers();
    });

    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    it('moves between photos with the arrow buttons after the slide animation', async () => {
      await renderViewer();
      expect(screen.queryByRole('button', { name: 'Previous photo' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
      expect(swipeTrack()).toHaveClass(styles.trackAnimating);
      await advance(299);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
      await advance(1);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
      expect(swipeTrack()).not.toHaveClass(styles.trackAnimating);

      fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
      await advance(300);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
    });

    it('hides the next button on the last photo', async () => {
      await renderViewer({ startIndex: 2 });

      expect(screen.queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Previous photo' })).toBeInTheDocument();
    });

    it('ignores extra taps while a slide is animating', async () => {
      await renderViewer();

      fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
      await advance(600);

      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
    });

    it('jumps straight to a photo from the progress bar', async () => {
      await renderViewer();

      fireEvent.click(screen.getByRole('button', { name: 'Go to photo 3 of 3' }));

      expect(currentPhoto()).toHaveAttribute('alt', "bob's custom:tile-1 activity");
      expect(screen.getByRole('button', { name: 'Go to photo 3 of 3' })).toHaveAttribute(
        'aria-current',
        'step'
      );
    });

    it('navigates with the left and right arrow keys', async () => {
      await renderViewer();

      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      await advance(300);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");

      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      await advance(300);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");

      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      await advance(300);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
    });

    it('follows the finger and changes photo on a quick horizontal swipe', async () => {
      await renderViewer();

      fireEvent.touchStart(viewer(), { touches: [{ clientX: 300, clientY: 200 }] });
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 100, clientY: 210 }] });
      expect(swipeTrack()).toHaveStyle({ transform: 'translateX(-200px)' });
      fireEvent.touchEnd(viewer());
      await advance(300);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");

      fireEvent.touchStart(viewer(), { touches: [{ clientX: 100, clientY: 200 }] });
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 300, clientY: 200 }] });
      fireEvent.touchEnd(viewer());
      await advance(300);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
    });

    it('changes photo after a long, slow swipe past a quarter of the screen', async () => {
      await renderViewer();

      fireEvent.touchStart(viewer(), { touches: [{ clientX: 600, clientY: 200 }] });
      await advance(2000);
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 300, clientY: 200 }] });
      fireEvent.touchEnd(viewer());
      await advance(300);

      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
    });

    it('snaps back after a short, slow swipe', async () => {
      await renderViewer();

      fireEvent.touchStart(viewer(), { touches: [{ clientX: 300, clientY: 200 }] });
      await advance(1000);
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 250, clientY: 200 }] });
      fireEvent.touchEnd(viewer());
      await advance(300);

      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
      expect(swipeTrack()).toHaveStyle({ transform: 'translateX(0px)' });
    });

    it('resists swiping past the first photo', async () => {
      await renderViewer();

      fireEvent.touchStart(viewer(), { touches: [{ clientX: 100, clientY: 200 }] });
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 200, clientY: 200 }] });
      expect(swipeTrack()).toHaveStyle({ transform: 'translateX(30px)' });
      fireEvent.touchCancel(viewer());
      await advance(300);

      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
    });

    it('resists swiping past the last photo', async () => {
      await renderViewer({ startIndex: 2 });

      fireEvent.touchStart(viewer(), { touches: [{ clientX: 300, clientY: 200 }] });
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 100, clientY: 200 }] });
      expect(swipeTrack()).toHaveStyle({ transform: 'translateX(-60px)' });
      fireEvent.touchEnd(viewer());
      await advance(300);

      expect(currentPhoto()).toHaveAttribute('alt', "bob's custom:tile-1 activity");
    });

    it('ignores mostly vertical gestures and touches during an animation', async () => {
      await renderViewer();

      fireEvent.touchStart(viewer(), { touches: [{ clientX: 100, clientY: 100 }] });
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 120, clientY: 400 }] });
      fireEvent.touchEnd(viewer());
      expect(swipeTrack()).toHaveStyle({ transform: 'translateX(0px)' });

      fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
      fireEvent.touchStart(viewer(), { touches: [{ clientX: 300, clientY: 200 }] });
      fireEvent.touchMove(viewer(), { touches: [{ clientX: 100, clientY: 200 }] });
      fireEvent.touchEnd(viewer());
      await advance(600);

      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
    });

    it('resets to the start photo each time it opens', async () => {
      const { rerender } = await renderViewer({ startIndex: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
      await advance(300);
      expect(currentPhoto()).toHaveAttribute('alt', "bob's custom:tile-1 activity");

      await rerender({ isOpen: false, startIndex: 1 });
      await rerender({ isOpen: true, startIndex: 1 });

      expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
    });

    it('shows a heart burst for a second when a photo is double-tapped', async () => {
      await renderViewer();

      fireEvent.click(currentPhoto());
      expect(likeBurst()).not.toBeInTheDocument();
      fireEvent.click(currentPhoto());
      expect(likeBurst()).toBeInTheDocument();
      expect(photoApi.likePhoto).toHaveBeenCalledWith(101);

      await advance(999);
      expect(likeBurst()).toBeInTheDocument();
      await advance(1);
      expect(likeBurst()).not.toBeInTheDocument();
    });

    it('only counts two taps within 300ms as a double-tap', async () => {
      await renderViewer();

      fireEvent.click(currentPhoto());
      await advance(300);
      fireEvent.click(currentPhoto());
      expect(photoApi.likePhoto).not.toHaveBeenCalled();

      await advance(299);
      fireEvent.click(currentPhoto());
      expect(photoApi.likePhoto).toHaveBeenCalledWith(101);
    });

    it('dismisses the like error after a few seconds, even once the photos are gone', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      photoApi.likePhoto.mockRejectedValue(new Error('offline'));
      const { rerender } = await renderViewer();

      fireEvent.click(likeButton());
      await advance(0);
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to update like');
      await advance(2750);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      fireEvent.click(likeButton());
      await advance(0);
      await rerender({ photos: [] });
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to update like');
      await advance(2750);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it('closes from the close button', async () => {
      const user = userEvent.setup();
      const { onClose } = await renderViewer();

      await user.click(screen.getByRole('button', { name: 'Close' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes with the Escape key', async () => {
      const user = userEvent.setup();
      const { onClose } = await renderViewer();

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the backdrop is tapped but not when the photo is', async () => {
      const user = userEvent.setup();
      const { onClose } = await renderViewer();

      await user.click(currentPhoto());
      expect(onClose).not.toHaveBeenCalled();

      await user.click(viewer());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the browser Back button is pressed', async () => {
      const { onClose } = await renderViewer();
      await waitFor(() => expect(window.history.state?.__overlayId).toBeDefined());

      act(() => window.history.back());

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('reports every photo the viewer saw when it closes', async () => {
      const user = userEvent.setup();
      const onPhotosViewed = vi.fn();
      const { onClose } = await renderViewer({ onPhotosViewed });

      await user.click(screen.getByRole('button', { name: 'Go to photo 3 of 3' }));
      await user.click(screen.getByRole('button', { name: 'Close' }));

      expect(onPhotosViewed).toHaveBeenCalledWith([101, 103]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not report views of your own story', async () => {
      const user = userEvent.setup();
      const onPhotosViewed = vi.fn();
      await renderViewer({ isOwnStory: true, onPhotosViewed });

      await user.click(screen.getByRole('button', { name: 'Close' }));

      expect(onPhotosViewed).not.toHaveBeenCalled();
    });
  });

  describe('owner profile link', () => {
    it('opens the owner profile from the header with a click or the keyboard', async () => {
      const user = userEvent.setup();
      const onProfileClick = vi.fn();
      await renderViewer({ onProfileClick });
      const profile = screen.getByRole('button', { name: /bob/ });

      await user.click(profile);
      profile.focus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');

      expect(onProfileClick).toHaveBeenCalledTimes(3);
      expect(onProfileClick).toHaveBeenCalledWith('bob');
    });

    it('is not interactive without a profile handler', async () => {
      const user = userEvent.setup();
      const { onClose } = await renderViewer();

      expect(screen.queryByRole('button', { name: /bob/ })).not.toBeInTheDocument();
      await user.click(within(viewer()).getByText('bob'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("someone else's story", () => {
    it('records one view per photo', async () => {
      const user = userEvent.setup();
      await renderViewer();

      await user.click(screen.getByRole('button', { name: 'Go to photo 2 of 3' }));
      await user.click(screen.getByRole('button', { name: 'Go to photo 1 of 3' }));

      expect(photoApi.recordView.mock.calls).toEqual([[101], [102]]);
      expect(gl.track).toHaveBeenCalledWith('story_viewed', { properties: { photoId: 101 } });
      expect(gl.track).toHaveBeenCalledWith('story_viewed', { properties: { photoId: 102 } });
    });

    it('keeps working when a view cannot be recorded', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('offline');
      photoApi.recordView.mockRejectedValue(failure);
      await renderViewer();

      expect(consoleError).toHaveBeenCalledWith('Failed to record view:', failure);
      expect(currentPhoto()).toBeInTheDocument();
    });

    it('remembers the like status of photos it has already loaded', async () => {
      const user = userEvent.setup();
      photoApi.getLikeStatus.mockImplementation(async (id: number) => ({
        success: true,
        liked: id === 102,
        like_count: 4,
      }));
      await renderViewer();
      expect(likeButton()).toHaveAccessibleName('Like photo');
      expect(likeButton()).toHaveAttribute('aria-pressed', 'false');

      await user.click(screen.getByRole('button', { name: 'Go to photo 2 of 3' }));
      await waitFor(() => expect(likeButton()).toHaveAccessibleName('Unlike photo'));
      expect(likeButton()).toHaveAttribute('aria-pressed', 'true');
      expect(photoApi.getLikeStatus).toHaveBeenLastCalledWith(102);
      const requests = photoApi.getLikeStatus.mock.calls.length;

      await user.click(screen.getByRole('button', { name: 'Go to photo 1 of 3' }));
      expect(likeButton()).toHaveAccessibleName('Like photo');
      expect(photoApi.getLikeStatus).toHaveBeenCalledTimes(requests);
    });

    it('requests the like status of the first photo only once when it opens', async () => {
      await renderViewer();

      expect(photoApi.getLikeStatus).toHaveBeenCalledTimes(1);
    });

    it('ignores a like status it cannot load', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      photoApi.getLikeStatus.mockRejectedValueOnce(new Error('offline'));
      await renderViewer();

      expect(consoleError).toHaveBeenCalledWith('Failed to fetch like status:', expect.any(Error));
      expect(likeButton()).toHaveAttribute('aria-pressed', 'false');
    });

    it('likes a photo optimistically with haptic feedback', async () => {
      const user = userEvent.setup();
      const vibrate = stubVibrate();
      const response = deferred<unknown>();
      photoApi.likePhoto.mockReturnValue(response.promise);
      await renderViewer();

      await user.click(likeButton());

      expect(likeButton()).toHaveAttribute('aria-pressed', 'true');
      expect(likeButton()).toBeDisabled();
      expect(vibrate).toHaveBeenCalledWith(50);
      expect(photoApi.likePhoto).toHaveBeenCalledWith(101);

      await act(async () => response.resolve({ success: true }));
      expect(likeButton()).toBeEnabled();
      expect(likeButton()).toHaveAccessibleName('Unlike photo');
      expect(gl.track).toHaveBeenCalledWith('story_liked', { properties: { photoId: 101 } });
    });

    it('unlikes a liked photo', async () => {
      const user = userEvent.setup();
      const vibrate = stubVibrate();
      photoApi.getLikeStatus.mockResolvedValue({ success: true, liked: true, like_count: 1 });
      await renderViewer();

      await user.click(screen.getByRole('button', { name: 'Unlike photo' }));

      expect(photoApi.unlikePhoto).toHaveBeenCalledWith(101);
      expect(vibrate).toHaveBeenCalledWith(30);
      expect(likeButton()).toHaveAttribute('aria-pressed', 'false');
      expect(gl.track).toHaveBeenCalledWith('story_unliked', { properties: { photoId: 101 } });
    });

    it('likes without haptics on devices that cannot vibrate', async () => {
      const user = userEvent.setup();
      expect('vibrate' in navigator).toBe(false);
      await renderViewer();

      await user.click(likeButton());

      expect(photoApi.likePhoto).toHaveBeenCalledWith(101);
      expect(likeButton()).toHaveAttribute('aria-pressed', 'true');
    });

    it('rolls the like back and explains when it fails', async () => {
      const user = userEvent.setup();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('offline');
      photoApi.likePhoto.mockRejectedValue(failure);
      await renderViewer();

      await user.click(likeButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update like');
      expect(likeButton()).toHaveAttribute('aria-pressed', 'false');
      expect(likeButton()).toBeEnabled();
      expect(consoleError).toHaveBeenCalledWith('Failed to toggle like:', failure);
    });

    it('keeps the error toast after the last photo goes away', async () => {
      const user = userEvent.setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      photoApi.likePhoto.mockRejectedValue(new Error('offline'));
      const { rerender } = await renderViewer({ photos: [SLEEP] });
      await user.click(likeButton());
      await screen.findByRole('alert');

      await rerender({ photos: [] });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to update like');
    });

    it('toggles the like with the L key', async () => {
      const user = userEvent.setup();
      await renderViewer();

      await user.keyboard('l');
      await waitFor(() => expect(likeButton()).toHaveAttribute('aria-pressed', 'true'));
      await user.keyboard('L');

      await waitFor(() => expect(photoApi.unlikePhoto).toHaveBeenCalledWith(101));
      expect(photoApi.likePhoto).toHaveBeenCalledWith(101);
    });

    it('likes the photo when it is double-tapped', async () => {
      const user = userEvent.setup();
      const { onClose } = await renderViewer();

      await user.dblClick(currentPhoto());

      expect(photoApi.likePhoto).toHaveBeenCalledWith(101);
      expect(likeButton()).toHaveAttribute('aria-pressed', 'true');
      expect(likeBurst()).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps a liked photo liked when it is double-tapped', async () => {
      const user = userEvent.setup();
      photoApi.getLikeStatus.mockResolvedValue({ success: true, liked: true, like_count: 1 });
      await renderViewer();

      await user.dblClick(currentPhoto());

      expect(photoApi.unlikePhoto).not.toHaveBeenCalled();
      expect(photoApi.likePhoto).not.toHaveBeenCalled();
      expect(likeButton()).toHaveAttribute('aria-pressed', 'true');
      expect(likeBurst()).not.toBeInTheDocument();
    });
  });

  describe('your own story', () => {
    it('shows how many people saw the photo instead of a like button', async () => {
      photoApi.getPhotoInteractions.mockResolvedValue({
        success: true,
        interactions: [],
        total: 3,
      });
      await renderViewer({ isOwnStory: true });

      expect(screen.getByRole('button', { name: 'Seen by 3' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /like photo/i })).not.toBeInTheDocument();
      expect(photoApi.getPhotoInteractions).toHaveBeenCalledWith(101);
      expect(photoApi.recordView).not.toHaveBeenCalled();
      expect(photoApi.getLikeStatus).not.toHaveBeenCalled();
    });

    it('shows a dash when nobody has seen the photo yet', async () => {
      await renderViewer({ isOwnStory: true });

      expect(screen.getByRole('button', { name: 'Seen by —' })).toBeInTheDocument();
    });

    it('ignores double-taps on your own photo', async () => {
      const user = userEvent.setup();
      const { onClose } = await renderViewer({ isOwnStory: true });

      await user.dblClick(currentPhoto());

      expect(photoApi.likePhoto).not.toHaveBeenCalled();
      expect(likeBurst()).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('ignores the like shortcut', async () => {
      const user = userEvent.setup();
      await renderViewer({ isOwnStory: true });

      await user.keyboard('l');

      expect(photoApi.likePhoto).not.toHaveBeenCalled();
    });

    it('logs when the view count cannot be loaded', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      photoApi.getPhotoInteractions.mockRejectedValue(new Error('offline'));
      await renderViewer({ isOwnStory: true });

      expect(consoleError).toHaveBeenCalledWith(
        'Failed to fetch interactions count:',
        expect.any(Error)
      );
      expect(screen.getByRole('button', { name: 'Seen by —' })).toBeInTheDocument();
    });

    it('lists who viewed and liked the photo', async () => {
      const user = userEvent.setup();
      const interactions = [
        photoInteraction({ user_id: 3, username: 'carol', interaction_type: 'view' }),
        photoInteraction({ user_id: 4, username: 'dan', interaction_type: 'like' }),
        photoInteraction({ user_id: 5, username: 'erin', interaction_type: 'both' }),
      ];
      photoApi.getPhotoInteractions.mockResolvedValue({ success: true, interactions, total: 3 });
      await renderViewer({ isOwnStory: true });
      const list = deferred<unknown>();
      photoApi.getPhotoInteractions.mockReturnValueOnce(list.promise);

      await user.click(screen.getByRole('button', { name: 'Seen by 3' }));

      const sheet = screen.getByRole('dialog', { name: 'Story activity' });
      expect(within(sheet).getByLabelText('Loading')).toHaveAttribute('aria-busy', 'true');
      expect(gl.track).toHaveBeenCalledWith('story_interactions_viewed', {
        properties: { photoId: 101 },
      });

      await act(async () => list.resolve({ success: true, interactions, total: 3 }));

      expect(within(sheet).getByText('3 people')).toBeInTheDocument();
      const rows = within(sheet).getAllByRole('listitem');
      expect(rows.map((row) => row.textContent)).toEqual(['Ccarol', 'Ddan', 'Eerin']);
      expect(within(rows[0]).getByLabelText('Viewed')).toBeInTheDocument();
      expect(within(rows[0]).queryByLabelText('Liked')).not.toBeInTheDocument();
      expect(within(rows[1]).getByLabelText('Liked')).toBeInTheDocument();
      expect(within(rows[1]).queryByLabelText('Viewed')).not.toBeInTheDocument();
      expect(within(rows[2]).getByLabelText('Viewed')).toBeInTheDocument();
      expect(within(rows[2]).getByLabelText('Liked')).toBeInTheDocument();
    });

    it('uses the singular for one viewer', async () => {
      const user = userEvent.setup();
      photoApi.getPhotoInteractions.mockResolvedValue({
        success: true,
        interactions: [photoInteraction()],
        total: 1,
      });
      await renderViewer({ isOwnStory: true });

      await user.click(screen.getByRole('button', { name: 'Seen by 1' }));

      expect(await screen.findByText('1 person')).toBeInTheDocument();
    });

    it('explains when nobody has viewed the photo', async () => {
      const user = userEvent.setup();
      await renderViewer({ isOwnStory: true });

      await user.click(screen.getByRole('button', { name: 'Seen by —' }));

      expect(await screen.findByRole('heading', { name: 'No views yet' })).toBeInTheDocument();
    });

    it('falls back to the empty state when the activity list fails to load', async () => {
      const user = userEvent.setup();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      await renderViewer({ isOwnStory: true });
      photoApi.getPhotoInteractions.mockRejectedValueOnce(new Error('offline'));

      await user.click(screen.getByRole('button', { name: 'Seen by —' }));

      expect(await screen.findByRole('heading', { name: 'No views yet' })).toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith('Failed to fetch interactions:', expect.any(Error));
    });

    it('closes the activity sheet before the viewer and pauses navigation keys meanwhile', async () => {
      const user = userEvent.setup();
      const { onClose } = await renderViewer({ isOwnStory: true });
      await user.click(screen.getByRole('button', { name: 'Seen by —' }));
      await screen.findByRole('heading', { name: 'No views yet' });

      await user.keyboard('{ArrowRight}');
      expect(swipeTrack()).not.toHaveClass(styles.trackAnimating);
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog', { name: 'Story activity' })).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    describe('deleting a photo', () => {
      it('asks for confirmation and shows the next photo once deleted', async () => {
        const user = userEvent.setup();
        const onPhotoDeleted = vi.fn();
        await renderViewer({ isOwnStory: true, onPhotoDeleted });

        await user.click(screen.getByRole('button', { name: 'Delete photo' }));
        const confirm = screen.getByRole('alertdialog', { name: 'Delete this photo?' });
        expect(confirm).toHaveTextContent('It will be removed from your story permanently.');
        await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
        expect(screen.getAllByRole('button', { name: /^Go to photo \d of 2$/ })).toHaveLength(2);
        expect(onPhotoDeleted).toHaveBeenCalledWith(101);
        expect(photoApi.deletePhoto).toHaveBeenCalledWith(101);
        expect(gl.track).toHaveBeenCalledWith('photo_deleted', { properties: { photoId: 101 } });
      });

      it('steps back when the last photo in the list is deleted', async () => {
        const user = userEvent.setup();
        await renderViewer({ isOwnStory: true, startIndex: 2 });

        await user.click(screen.getByRole('button', { name: 'Delete photo' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
      });

      it('closes the viewer when the only photo is deleted', async () => {
        const user = userEvent.setup();
        const onPhotoDeleted = vi.fn();
        const { onClose } = await renderViewer({
          isOwnStory: true,
          photos: [SLEEP],
          onPhotoDeleted,
        });

        await user.click(screen.getByRole('button', { name: 'Delete photo' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onPhotoDeleted).toHaveBeenCalledWith(101);
      });

      it('keeps the photo when deletion is cancelled', async () => {
        const user = userEvent.setup();
        const { onClose } = await renderViewer({ isOwnStory: true });

        await user.click(screen.getByRole('button', { name: 'Delete photo' }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
        expect(photoApi.deletePhoto).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
      });

      it('lets Escape dismiss the confirmation before the viewer and pauses gestures', async () => {
        const user = userEvent.setup();
        const { onClose } = await renderViewer({ isOwnStory: true });
        await user.click(screen.getByRole('button', { name: 'Delete photo' }));

        await user.keyboard('{ArrowRight}');
        expect(swipeTrack()).not.toHaveClass(styles.trackAnimating);
        fireEvent.touchStart(viewer(), { touches: [{ clientX: 300, clientY: 200 }] });
        fireEvent.touchMove(viewer(), { touches: [{ clientX: 100, clientY: 200 }] });
        expect(swipeTrack()).toHaveStyle({ transform: 'translateX(0px)' });
        fireEvent.touchEnd(viewer());

        await user.keyboard('{Escape}');

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(currentPhoto()).toHaveAttribute('alt', "bob's sleep activity");
      });

      it.each([
        [
          'the server refuses',
          () => photoApi.deletePhoto.mockResolvedValue({ success: false, error: 'Gone' }),
          'Gone',
        ],
        [
          'the request fails',
          () => photoApi.deletePhoto.mockRejectedValue(new Error('offline')),
          expect.any(Error),
        ],
      ])('logs when %s, keeping the optimistic removal', async (_label, fail, logged) => {
        const user = userEvent.setup();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        fail();
        await renderViewer({ isOwnStory: true });

        await user.click(screen.getByRole('button', { name: 'Delete photo' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(consoleError).toHaveBeenCalledWith('Delete failed:', logged));
        expect(currentPhoto()).toHaveAttribute('alt', "bob's workout activity");
      });
    });
  });

  it('follows photo list updates from the parent while open', async () => {
    const { rerender } = await renderViewer({ startIndex: 1 });

    await rerender({ photos: [SLEEP, GUITAR] });

    expect(currentPhoto()).toHaveAttribute('alt', "bob's custom:tile-1 activity");
    expect(screen.getAllByRole('button', { name: /^Go to photo \d of 2$/ })).toHaveLength(2);
  });
});
