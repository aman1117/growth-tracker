import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { activityPhoto } from '../../test/fixtures/social';
import StoryCircleDefault, { StoryCircle } from './StoryCircle';
import ring from './StoryRing.module.css';

type Props = ComponentProps<typeof StoryCircle>;

const PHOTO = activityPhoto({ id: 5, activity_name: 'sleep' });

function renderCircle(props: Partial<Props> = {}) {
  const onClick = vi.fn();
  const onUpload = vi.fn();
  const view = render(
    <StoryCircle
      activityName="sleep"
      displayLabel="Sleep"
      color="#6366f1"
      onClick={onClick}
      onUpload={onUpload}
      {...props}
    />
  );
  return { ...view, onClick, onUpload, user: userEvent.setup() };
}

describe('StoryCircle', () => {
  it('shows the photo thumbnail and opens the photo', async () => {
    const { user, onClick, onUpload } = renderCircle({ photo: PHOTO, canUpload: true });

    const circle = screen.getByRole('button', { name: 'View Sleep photo' });
    expect(screen.getByRole('img', { name: 'Sleep activity' })).toHaveAttribute(
      'src',
      PHOTO.thumbnail_url
    );
    await user.click(circle);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('blocks the context menu on the photo', () => {
    renderCircle({ photo: PHOTO });

    expect(fireEvent.contextMenu(screen.getByRole('img', { name: 'Sleep activity' }))).toBe(false);
  });

  it('badges a photo with its activity icon', () => {
    renderCircle({ photo: PHOTO, icon: 'Bike' });

    expect(
      screen.getByRole('button', { name: 'View Sleep photo' }).querySelector('.lucide-bike')
    ).toBeInTheDocument();
  });

  it.each([
    ['an unseen photo', { photo: PHOTO }, ring.ringUnseen],
    ['a seen photo', { photo: PHOTO, isViewed: true }, ring.ringViewed],
    ['your own photo', { photo: PHOTO, isOwn: true }, ring.ringViewed],
    ['an empty activity', {}, ring.ringEmpty],
  ])('draws the ring for %s', (_label, props, ringClass) => {
    renderCircle(props);

    expect(screen.getByRole('button')).toHaveClass(ringClass);
  });

  it('offers an upload for an activity without a photo', async () => {
    const { user, onClick, onUpload } = renderCircle({ canUpload: true });

    const circle = screen.getByRole('button', { name: 'Upload photo for Sleep' });
    expect(circle.querySelector('.lucide-plus')).toBeInTheDocument();
    await user.click(circle);

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is busy and disabled while uploading', async () => {
    const { user, onUpload } = renderCircle({ canUpload: true, isUploading: true });

    const circle = screen.getByRole('button', { name: 'Upload photo for Sleep' });
    expect(circle).toHaveAttribute('aria-busy', 'true');
    expect(circle).toBeDisabled();
    expect(circle).toHaveClass(ring.ringUploading);
    expect(circle.querySelector('.lucide-plus')).not.toBeInTheDocument();
    await user.click(circle);

    expect(onUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['its icon', { icon: 'Guitar' }, '.lucide-guitar'],
    ['a camera', {}, '.lucide-camera'],
  ])('shows a disabled placeholder with %s when nothing can be uploaded', (_label, props, icon) => {
    renderCircle(props);

    const circle = screen.getByRole('button', { name: 'Sleep - no photo' });
    expect(circle).toBeDisabled();
    expect(circle.querySelector(icon)).toBeInTheDocument();
  });

  it('ignores clicks on a photo when there is no handler', async () => {
    const user = userEvent.setup();
    render(<StoryCircle activityName="sleep" displayLabel="Sleep" color="#6366f1" photo={PHOTO} />);

    await user.click(screen.getByRole('button', { name: 'View Sleep photo' }));

    expect(screen.getByRole('button', { name: 'View Sleep photo' })).toBeEnabled();
  });

  it.each([
    ['small', '16'],
    ['medium', '22'],
    ['large', '28'],
  ] as const)('scales the placeholder icon for the %s size', (size, iconSize) => {
    renderCircle({ size });

    expect(screen.getByRole('button').querySelector('svg')).toHaveAttribute('width', iconSize);
  });

  it('applies the ring size modifiers', () => {
    const { unmount } = renderCircle({ size: 'small' });
    expect(screen.getByRole('button')).toHaveClass(ring.small);
    unmount();

    renderCircle({ size: 'large' });
    expect(screen.getByRole('button')).toHaveClass(ring.large);
    expect(screen.getByRole('button')).not.toHaveClass(ring.small);
  });

  it('labels the circle with the activity name', () => {
    renderCircle();

    expect(screen.getByText('Sleep')).toHaveAttribute('title', 'Sleep');
  });

  it('is exported as the default export', () => {
    expect(StoryCircleDefault).toBe(StoryCircle);
  });
});
