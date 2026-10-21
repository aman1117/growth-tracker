import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProfileSectionProps } from '../SettingsPage.types';
import { ProfileSection } from './ProfileSection';

function renderSection(props: Partial<ProfileSectionProps> = {}) {
  const handlers = {
    onProfilePicClick: vi.fn(),
    onEditPicClick: vi.fn(),
    onBioClick: vi.fn(),
    onFollowersClick: vi.fn(),
    onFollowingClick: vi.fn(),
  };
  render(
    <ProfileSection
      username="alice"
      bio="Reading 20 pages a day"
      profilePic={null}
      profilePicThumb={null}
      followersCount={12}
      followingCount={3}
      isUploadingPic={false}
      {...handlers}
      {...props}
    />
  );
  return { user: userEvent.setup(), ...handlers };
}

describe('ProfileSection', () => {
  it('shows who the profile belongs to', () => {
    renderSection();

    const card = screen.getByRole('region', { name: 'Your profile' });
    expect(within(card).getByRole('heading', { level: 2, name: 'alice' })).toBeInTheDocument();
    expect(within(card).getByText('A')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Verified account' })).not.toBeInTheDocument();
  });

  it('marks verified users', () => {
    renderSection({ isVerified: true });

    expect(
      within(screen.getByRole('heading', { level: 2 })).getByRole('img', {
        name: 'Verified account',
      })
    ).toBeInTheDocument();
  });

  it('offers to add a photo from the avatar and the camera button', async () => {
    const { user, onProfilePicClick, onEditPicClick } = renderSection();

    const [avatar, camera] = screen.getAllByRole('button', { name: 'Add a profile photo' });
    await user.click(avatar);
    await user.click(camera);

    expect(onProfilePicClick).toHaveBeenCalledTimes(1);
    expect(onEditPicClick).toHaveBeenCalledTimes(1);
  });

  it('lets the user view or change an existing photo', async () => {
    const { user, onProfilePicClick, onEditPicClick } = renderSection({
      profilePic: 'https://cdn.example/alice.jpg',
      profilePicThumb: 'https://cdn.example/alice-thumb.jpg',
    });

    const view = screen.getByRole('button', { name: 'View profile photo' });
    expect(within(view).getByRole('img', { name: 'alice' })).toHaveAttribute(
      'src',
      'https://cdn.example/alice-thumb.jpg'
    );

    await user.click(view);
    await user.click(screen.getByRole('button', { name: 'Change profile photo' }));

    expect(onProfilePicClick).toHaveBeenCalledTimes(1);
    expect(onEditPicClick).toHaveBeenCalledTimes(1);
  });

  it('blocks photo actions while an upload is in progress', () => {
    renderSection({ isUploadingPic: true });

    screen
      .getAllByRole('button', { name: 'Add a profile photo' })
      .forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole('status')).toHaveTextContent('Uploading photo…');
  });

  it('edits the trimmed bio', async () => {
    const { user, onBioClick } = renderSection({ bio: '  Growing every day  ' });

    await user.click(screen.getByRole('button', { name: 'Edit bio: Growing every day' }));

    expect(onBioClick).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, '', '   '])('invites the user to add a bio when it is %j', (bio) => {
    renderSection({ bio });

    expect(screen.getByRole('button', { name: 'Add a bio' })).toBeInTheDocument();
  });

  it.each([
    [0, /^0\s*Followers$/],
    [1, /^1\s*Follower$/],
    [9999, new RegExp(`^${(9999).toLocaleString()}\\s*Followers$`)],
    [12_345, /^12\.3k\s*Followers$/],
    [150_000, /^150k\s*Followers$/],
  ])('formats %i followers compactly', (followersCount, name) => {
    renderSection({ followersCount });

    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('opens the followers and following lists', async () => {
    const { user, onFollowersClick, onFollowingClick } = renderSection({
      followersCount: 12,
      followingCount: 10_000,
    });

    await user.click(screen.getByRole('button', { name: /^12\s*Followers$/ }));
    await user.click(screen.getByRole('button', { name: /^10\.0k\s*Following$/ }));

    expect(onFollowersClick).toHaveBeenCalledTimes(1);
    expect(onFollowingClick).toHaveBeenCalledTimes(1);
  });
});
