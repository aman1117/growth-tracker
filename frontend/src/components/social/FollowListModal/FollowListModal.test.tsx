import { screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFollowStore } from '../../../store';
import {
  captureIntersectionObservers,
  deferred,
  followUser,
  relationship,
} from '../../../test/fixtures/social';
import { renderWithRouter, signIn } from '../../../test/utils';
import type { FollowUser } from '../../../types/follow';
import FollowListModalDefault, { FollowListModal } from './FollowListModal';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api,
}));

// useThemeStore reads matchMedia while modules load, before setup.ts stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type Props = ComponentProps<typeof FollowListModal>;

const ALICE_ID = 1;
const bob = followUser({ id: 2, username: 'bob' });
const carol = followUser({ id: 3, username: 'carol', is_verified: true });

const page = (users: FollowUser[], extra: Record<string, unknown> = {}) => ({
  success: true,
  users,
  total_count: users.length,
  ...extra,
});

function renderModal(props: Partial<Props> = {}) {
  const onClose = vi.fn();
  const base: Props = {
    isOpen: true,
    onClose,
    userId: ALICE_ID,
    username: 'alice',
    type: 'followers',
    ...props,
  };
  const view = renderWithRouter(<FollowListModal {...base} />, { route: '/user/alice' });
  // Re-rendering inside the same router element updates the modal in place.
  const rerender = (next: Partial<Props>) =>
    view.rerender(
      <MemoryRouter>
        <FollowListModal {...base} {...next} />
      </MemoryRouter>
    );
  return { ...view, onClose, rerender };
}

/** The list row (identity button + actions) of a user. */
const rowOf = (username: string) => screen.getByText(username).closest('button')!.parentElement!;
const findRow = async (username: string) => {
  await screen.findByText(username);
  return rowOf(username);
};

describe('FollowListModal', () => {
  beforeEach(() => {
    signIn({ id: ALICE_ID, username: 'alice' });
    // Overlay history logs every modal open/close in development builds.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    api.post.mockResolvedValue({ success: true, relationships: {} });
  });

  it('lists people with their relationship to you and the total count', async () => {
    api.get.mockResolvedValue(page([bob, carol], { total_count: 1234 }));
    api.post.mockResolvedValue({
      success: true,
      relationships: {
        2: relationship({ following: true, followed_by: true, is_mutual: true }),
        3: relationship({ followed_by: true }),
      },
    });
    renderModal({ userId: 5, username: 'erin' });

    const dialog = screen.getByRole('dialog', { name: 'Followers' });
    expect(within(await findRow('bob')).getByRole('button', { name: /^Following/ })).toBeVisible();
    expect(within(rowOf('carol')).getByRole('button', { name: 'Follow' })).toBeVisible();
    expect(within(rowOf('carol')).getByText('Follows you')).toBeInTheDocument();
    expect(within(rowOf('carol')).getByRole('img', { name: 'Verified account' })).toBeVisible();
    expect(within(dialog).getByText('@erin · 1,234')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/users/5/followers?limit=20');
    expect(api.post).toHaveBeenCalledWith('/relationships/lookup', { target_ids: [2, 3] });
  });

  it.each([
    ['followers', undefined, 'Followers', '/users/1/followers?limit=20'],
    ['following', undefined, 'Following', '/users/1/following?limit=20'],
    ['mutuals', undefined, 'Mutual friends', '/users/1/mutuals?limit=20'],
    ['followers', 'Fans', 'Fans', '/users/1/followers?limit=20'],
  ] as const)('loads the %s list titled "%s"', async (type, title, heading, url) => {
    api.get.mockResolvedValue(type === 'mutuals' ? { success: true, users: [bob] } : page([bob]));
    renderModal({ type, title });

    const dialog = screen.getByRole('dialog', { name: heading });
    await findRow('bob');
    expect(within(dialog).getByText('@alice · 1')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(url);
  });

  it('shows skeleton rows while the list loads', async () => {
    const response = deferred<unknown>();
    api.get.mockReturnValue(response.promise);
    renderModal();

    const dialog = screen.getByRole('dialog', { name: 'Followers' });
    expect(dialog.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(within(dialog).queryByText('No followers yet')).not.toBeInTheDocument();

    response.resolve(page([bob]));
    await findRow('bob');
    expect(dialog.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it.each([
    ['followers', ALICE_ID, 'No followers yet', 'When people follow you, they’ll show up here.'],
    ['followers', 5, 'No followers yet', 'When people follow @erin, they’ll show up here.'],
    ['following', ALICE_ID, 'Not following anyone yet', 'Use search to find people to follow.'],
    ['following', 5, 'Not following anyone yet', '@erin isn’t following anyone yet.'],
    ['mutuals', ALICE_ID, 'No mutual friends', 'No mutual friends yet.'],
    ['mutuals', 5, 'No mutual friends', 'You and @erin have no mutual friends yet.'],
  ] as const)('explains an empty %s list (user %i)', async (type, userId, title, description) => {
    api.get.mockResolvedValue({ success: true, users: [], total_count: 0, has_more: false });
    renderModal({ type, userId, username: userId === ALICE_ID ? 'alice' : 'erin' });

    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(screen.getByText(userId === ALICE_ID ? '@alice' : '@erin')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    ['the request fails', () => api.get.mockRejectedValueOnce(new Error('Network down'))],
    ['the server rejects it', () => api.get.mockResolvedValueOnce({ success: false, users: [] })],
  ])('offers a retry when %s', async (_label, failOnce) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    failOnce();
    api.get.mockResolvedValue(page([bob]));
    const { user } = renderModal();

    expect(await screen.findByRole('heading', { name: "Couldn't load this list" })).toBeVisible();
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to fetch modal list data:',
      expect.any(Error)
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await findRow('bob')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this list")).not.toBeInTheDocument();
  });

  describe('infinite scroll', () => {
    it('loads the next page when the end of the list scrolls into view', async () => {
      const io = captureIntersectionObservers();
      const nextPage = deferred<unknown>();
      api.get.mockImplementation((url: string) =>
        url.includes('cursor=')
          ? nextPage.promise
          : page([bob], { total_count: 2, next_cursor: 'c2' })
      );
      renderModal();
      await findRow('bob');

      await io.intersect();

      expect(api.get).toHaveBeenCalledWith('/users/1/followers?cursor=c2&limit=20');
      expect(screen.getByRole('status')).toHaveTextContent('Loading more…');

      nextPage.resolve(page([carol], { total_count: 2 }));

      expect(await findRow('carol')).toBeInTheDocument();
      expect(rowOf('bob')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(api.post).toHaveBeenLastCalledWith('/relationships/lookup', { target_ids: [3] });

      await io.intersect();
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('waits until the sentinel is actually visible', async () => {
      const io = captureIntersectionObservers();
      api.get.mockResolvedValue(page([bob], { total_count: 2, next_cursor: 'c2' }));
      renderModal();
      await findRow('bob');

      await io.intersect(false);

      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('relationship states', () => {
    it.each([
      ['your following list', { type: 'following' }, /^Following/, true],
      ['your mutual friends', { type: 'mutuals' }, /^Following/, true],
      ['your followers', { type: 'followers' }, 'Follow', false],
      ['someone else’s list', { userId: 5, username: 'erin' }, 'Follow', false],
    ] as const)(
      'infers the relationship for %s when none is known',
      async (_label, props, buttonName, followsYou) => {
        api.get.mockResolvedValue({ success: true, users: [bob], total_count: 1 });
        renderModal(props);

        const row = await findRow('bob');
        expect(within(row).getByRole('button', { name: buttonName })).toBeInTheDocument();
        // Mutual friends follow you back; followers do too, but their row offers Remove instead.
        const shouldSay = followsYou && props.type === 'mutuals';
        expect(within(row).queryByText('Follows you') !== null).toBe(shouldSay);
      }
    );

    it('falls back to the state sent with the list when the lookup fails', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failure = new Error('lookup down');
      useFollowStore.setState({ lookupRelationships: vi.fn().mockRejectedValue(failure) });
      api.get.mockResolvedValue(
        page([{ ...bob, relationship_state: relationship({ pending: true }) }, carol])
      );
      renderModal({ userId: 5, username: 'erin' });

      expect(
        within(await findRow('bob')).getByRole('button', { name: /^Requested/ })
      ).toBeVisible();
      expect(within(rowOf('carol')).getByRole('button', { name: 'Follow' })).toBeVisible();
      expect(consoleWarn).toHaveBeenCalledWith('Failed to lookup relationships:', failure);
    });

    it('offers Follow rather than Accept/Decline to people who asked to follow you', async () => {
      api.get.mockResolvedValue(page([bob]));
      api.post.mockResolvedValue({
        success: true,
        relationships: { 2: relationship({ incoming_pending: true }) },
      });
      renderModal({ userId: 5, username: 'erin' });

      const row = await findRow('bob');
      expect(within(row).getByRole('button', { name: 'Follow' })).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
    });

    it('marks your own row and skips it in the relationship lookup', async () => {
      api.get.mockResolvedValue(page([followUser({ id: ALICE_ID, username: 'alice' }), bob]));
      renderModal({ userId: 5, username: 'erin' });

      await findRow('bob');
      expect(within(rowOf('alice')).getByText('You')).toBeInTheDocument();
      expect(api.post).toHaveBeenCalledWith('/relationships/lookup', { target_ids: [2] });
    });
  });

  describe('removing a follower', () => {
    const removeButton = (username: string) =>
      screen.getByRole('button', { name: `Remove ${username} from your followers` });

    it('removes the follower after confirmation', async () => {
      api.get.mockResolvedValue(page([bob, carol]));
      api.delete.mockResolvedValue({ success: true });
      const { user } = renderModal();
      await findRow('bob');

      await user.click(removeButton('bob'));
      const confirm = screen.getByRole('alertdialog', { name: 'Remove bob?' });
      expect(confirm).toHaveTextContent('They can follow you again later.');
      await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(screen.queryByText('bob')).not.toBeInTheDocument());
      expect(api.delete).toHaveBeenCalledWith('/me/followers/2');
      expect(screen.getByText('@alice · 1')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('keeps the follower when the confirmation is cancelled', async () => {
      api.get.mockResolvedValue(page([bob]));
      const { user } = renderModal();
      await findRow('bob');

      await user.click(removeButton('bob'));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(rowOf('bob')).toBeInTheDocument();
      expect(api.delete).not.toHaveBeenCalled();
    });

    it('disables the confirmation while the removal is in flight', async () => {
      const response = deferred<unknown>();
      api.get.mockResolvedValue(page([bob]));
      api.delete.mockReturnValue(response.promise);
      const { user } = renderModal();
      await findRow('bob');

      await user.click(removeButton('bob'));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      const confirm = screen.getByRole('alertdialog');
      expect(within(confirm).getByRole('button', { name: 'Remove' })).toBeDisabled();
      expect(within(confirm).getByRole('button', { name: 'Cancel' })).toBeDisabled();

      response.resolve({ success: true });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });

    it('explains when the server refuses the removal', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      api.get.mockResolvedValue(page([bob]));
      api.delete.mockResolvedValue({ success: false, error: 'Not allowed' });
      const { user } = renderModal();
      await findRow('bob');

      await user.click(removeButton('bob'));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't remove bob. Try again.");
      expect(rowOf('bob')).toBeInTheDocument();
      expect(consoleWarn).toHaveBeenCalledWith('[Social] Remove follower rejected', {
        error: 'Not allowed',
      });
    });

    it('explains when the removal throws, and clears the message on close', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('boom');
      useFollowStore.setState({ removeFollower: vi.fn().mockRejectedValue(failure) });
      api.get.mockResolvedValue(page([bob]));
      const { user, onClose } = renderModal();
      await findRow('bob');

      await user.click(removeButton('bob'));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't remove bob. Try again.");
      expect(consoleError).toHaveBeenCalledWith('[Social] Failed to remove follower', failure);

      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
      ['someone else’s followers', { userId: 5, username: 'erin' }],
      ['your following list', { type: 'following' }],
    ] as const)('is not offered for %s', async (_label, props) => {
      api.get.mockResolvedValue(page([bob]));
      renderModal(props);

      await findRow('bob');
      expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    });
  });

  it('opens a profile and closes the list', async () => {
    api.get.mockResolvedValue(page([bob]));
    const { user, onClose } = renderModal();

    await user.click(within(await findRow('bob')).getByText('bob'));

    expect(screen.getByTestId('location')).toHaveTextContent('/user/bob');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reloads when it switches to another list', async () => {
    api.get.mockResolvedValue(page([bob]));
    const { rerender } = renderModal();
    await findRow('bob');

    rerender({ type: 'following' });

    expect(await screen.findByRole('dialog', { name: 'Following' })).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/users/1/following?limit=20'));
  });

  it('renders nothing and loads nothing while closed', () => {
    renderModal({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('is exported as the default export', () => {
    expect(FollowListModalDefault).toBe(FollowListModal);
  });
});
