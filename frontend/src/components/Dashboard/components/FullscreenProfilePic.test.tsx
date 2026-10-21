import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FullscreenProfilePic } from './FullscreenProfilePic';

// The theme store (reached through the ui barrel) reads matchMedia when its module loads,
// before the shared setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

/** Captures the background `Image` preloads so a test can finish loading them. */
function stubImagePreload() {
  const images: { src: string; onload: (() => void) | null }[] = [];
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      onload: (() => void) | null = null;
      constructor() {
        images.push(this);
      }
    }
  );
  return images;
}

function renderPhoto(props: Partial<ComponentProps<typeof FullscreenProfilePic>> = {}) {
  const onClose = vi.fn();
  const view = render(
    <FullscreenProfilePic
      profilePic="https://cdn.test/bob.jpg"
      username="bob"
      onClose={onClose}
      {...props}
    />
  );
  return { user: userEvent.setup(), onClose, ...view };
}

describe('FullscreenProfilePic', () => {
  beforeEach(() => {
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('shows the photo in a labelled modal dialog and focuses Close', () => {
    renderPhoto();

    const dialog = screen.getByRole('dialog', { name: "bob's profile photo" });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('img', { name: 'bob' })).toHaveAttribute(
      'src',
      'https://cdn.test/bob.jpg'
    );
    expect(dialog).toHaveTextContent('bob');
    expect(screen.getByRole('button', { name: 'Close photo' })).toHaveFocus();
  });

  it('locks page scrolling while open', () => {
    const { unmount } = renderPhoto();
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes from the Close button, a tap outside the photo or Escape', async () => {
    const { user, onClose } = renderPhoto();

    await user.click(screen.getByRole('button', { name: 'Close photo' }));
    expect(onClose).toHaveBeenCalled();

    onClose.mockClear();
    await user.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when the photo itself is tapped', async () => {
    const { user, onClose } = renderPhoto();

    await user.click(screen.getByRole('img', { name: 'bob' }).parentElement!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the thumbnail until the full-size photo has loaded', () => {
    const images = stubImagePreload();
    renderPhoto({ profilePicThumb: 'https://cdn.test/bob-thumb.jpg' });

    expect(screen.getByRole('presentation')).toHaveAttribute(
      'src',
      'https://cdn.test/bob-thumb.jpg'
    );
    expect(images).toHaveLength(1);
    expect(images[0].src).toBe('https://cdn.test/bob.jpg');

    act(() => images[0].onload?.());

    expect(screen.queryByRole('presentation')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'bob' })).toBeInTheDocument();
  });

  it('does not preload anything without a thumbnail', () => {
    const images = stubImagePreload();
    renderPhoto({ profilePicThumb: null });

    expect(images).toHaveLength(0);
    expect(screen.queryByRole('presentation')).not.toBeInTheDocument();
  });

  it('drops the preload callback when closed before the photo loads', () => {
    const images = stubImagePreload();
    const { unmount } = renderPhoto({ profilePicThumb: 'https://cdn.test/bob-thumb.jpg' });

    unmount();

    expect(images[0].onload).toBeNull();
  });
});
