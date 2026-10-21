import { screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { followUser, relationship } from '../../../test/fixtures/social';
import { renderWithRouter, signIn } from '../../../test/utils';
import UserCardDefault, { UserCard } from './UserCard';

// useThemeStore reads matchMedia while modules load, before setup.ts stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

const BOB = followUser({ id: 2, username: 'bob' });

function renderCard(props: Partial<ComponentProps<typeof UserCard>> = {}) {
  return renderWithRouter(<UserCard user={BOB} {...props} />, { route: '/user/alice' });
}

const identity = (username: string) =>
  screen.getByRole('button', { name: new RegExp(`\\b${username}\\b`) });

describe('UserCard', () => {
  beforeEach(() => {
    signIn({ id: 1, username: 'alice' });
  });

  it('shows the username, verified badge and display name', () => {
    renderCard({
      user: followUser({ id: 2, username: 'bob', display_name: 'Bob Builder', is_verified: true }),
    });

    expect(identity('bob')).toHaveTextContent('bob');
    expect(screen.getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(screen.getByText('Bob Builder')).toBeInTheDocument();
  });

  it('shows the avatar image when the user has one', () => {
    renderCard({
      user: followUser({ id: 2, username: 'bob', profile_pic_thumb: 'https://cdn.test/bob.jpg' }),
    });

    expect(screen.getByRole('img', { name: 'bob' })).toHaveAttribute(
      'src',
      'https://cdn.test/bob.jpg'
    );
  });

  it('mentions when the user follows you', () => {
    renderCard({ user: { ...BOB, relationship_state: relationship({ followed_by: true }) } });

    expect(screen.getByText('Follows you')).toBeInTheDocument();
  });

  it.each([
    ['a remove action is shown', { showRemoveButton: true }, {}],
    ['the user has a display name', {}, { display_name: 'Bobby' }],
  ])('does not say "Follows you" when %s', (_label, props, userOverrides) => {
    renderCard({
      ...props,
      user: { ...BOB, ...userOverrides, relationship_state: relationship({ followed_by: true }) },
    });

    expect(screen.queryByText('Follows you')).not.toBeInTheDocument();
  });

  it('opens the profile and reports the click', async () => {
    const onUserClick = vi.fn();
    const { user } = renderCard({ onUserClick });

    await user.click(identity('bob'));

    expect(screen.getByTestId('location')).toHaveTextContent('/user/bob');
    expect(onUserClick).toHaveBeenCalledWith('bob');
  });

  it('shows a follow button that reflects the relationship', () => {
    renderCard({
      user: { ...BOB, is_private: true, relationship_state: relationship({ pending: true }) },
    });

    expect(screen.getByRole('button', { name: /^Requested/ })).toBeInTheDocument();
  });

  it('can hide the follow button', () => {
    renderCard({ showFollowButton: false });

    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
  });

  describe('when the user asked to follow you', () => {
    const requester = { ...BOB, relationship_state: relationship({ incoming_pending: true }) };

    it('offers Accept and Decline', () => {
      renderCard({ user: requester });

      expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    });

    it('can hide Accept and Decline', () => {
      renderCard({ user: requester, showRequestActions: false });

      expect(screen.getByRole('button', { name: 'Follow' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    });
  });

  it('shows "You" instead of actions on the signed-in user’s own row', () => {
    renderCard({ user: followUser({ id: 1, username: 'alice' }), showRemoveButton: true });

    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /follow/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('asks to remove a follower', async () => {
    const onRemove = vi.fn();
    const { user } = renderCard({ showRemoveButton: true, onRemove });

    await user.click(screen.getByRole('button', { name: 'Remove bob from your followers' }));

    expect(onRemove).toHaveBeenCalledWith(BOB.id);
  });

  it('disables the remove action while the follower is being removed', () => {
    renderCard({ showRemoveButton: true, isRemoving: true });

    expect(screen.getByRole('button', { name: 'Remove bob from your followers' })).toBeDisabled();
  });

  it('is exported as the default export', () => {
    expect(UserCardDefault).toBe(UserCard);
  });
});
