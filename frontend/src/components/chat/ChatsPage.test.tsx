import { act, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiClient, ApiError, chatApi, userApi } from '../../services/api';
import { useChatStore } from '../../store/useChatStore';
import {
  at,
  CHAT_NOW,
  inboxPage,
  makeChatMessage,
  makeConversation,
  ME,
  mine,
  PEER,
} from '../../test/fixtures/chat';
import { deferred, makeFollowUser, renderWithHistory } from '../../test/fixtures/shell';
import { signIn } from '../../test/utils';
import type { ChatInboxResponse } from '../../types/chat';
import { ChatsPage } from './ChatsPage';
import styles from './ChatsPage.module.css';
import sheetStyles from './NewChatSheet.module.css';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChatApiMock } = await import('../../test/fixtures/chat');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    chatApi: createChatApiMock(),
    apiClient: { get: vi.fn() },
    userApi: { autocomplete: vi.fn() },
  };
});

const api = vi.mocked(chatApi);
const get = vi.mocked(apiClient.get);
const autocomplete = vi.mocked(userApi.autocomplete);

/** IntersectionObserver whose callbacks the test fires */
const observers: { callback: IntersectionObserverCallback; disconnect: () => void }[] = [];
class TestIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = vi.fn(() => []);
}
const scrollIntoViewEnd = () =>
  act(() =>
    observers
      .at(-1)
      ?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
  );

function renderInbox() {
  return renderWithHistory(
    <Routes>
      <Route path="/" element={<p>Home screen</p>} />
      <Route path="/chats" element={<ChatsPage />} />
      <Route path="/chats/:id" element={<p>Conversation screen</p>} />
    </Routes>,
    { entries: ['/', '/chats'] }
  );
}

const rows = () =>
  within(screen.getByRole('region', { name: 'Conversations' })).getAllByRole('link');

describe('ChatsPage', () => {
  beforeEach(() => {
    vi.setSystemTime(CHAT_NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    observers.length = 0;
    useChatStore.getState().reset();
    signIn(ME);
  });

  it('shows skeletons, then the conversations newest first', async () => {
    const response = deferred<ChatInboxResponse>();
    api.list.mockReturnValueOnce(response.promise);
    const { container } = renderInbox();

    expect(screen.getByRole('heading', { level: 1, name: 'Messages' })).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();

    await act(async () =>
      response.resolve(
        inboxPage([
          makeConversation({
            id: 1,
            peer: { ...PEER, id: 3, username: 'carol', is_verified: true },
            last_message: makeChatMessage({
              id: 3,
              sender_id: 3,
              body: 'Old news',
              created_at: at(9, 0, 1),
            }),
            updated_at: at(9, 0, 1),
          }),
          makeConversation({
            id: 2,
            last_message: makeChatMessage({ id: 9, body: 'See you\nsoon' }),
            unread_count: 2,
            my_last_read_message_id: 7,
            updated_at: at(14, 30),
          }),
        ])
      )
    );

    const [first, second] = rows();
    expect(first).toHaveAttribute('href', '/chats/2');
    expect(first).toHaveTextContent('bob');
    expect(first).toHaveTextContent('See you soon');
    expect(first).toHaveTextContent('2 unread');
    expect(first).toHaveClass(styles.rowUnread);
    expect(second).toHaveTextContent('carol');
    expect(second).toHaveTextContent('Yesterday');
    expect(within(second).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(second).not.toHaveClass(styles.rowUnread);
  });

  it('marks my last message with "You:" and its ticks, and unsent ones as deleted', async () => {
    api.list.mockResolvedValueOnce(
      inboxPage([
        makeConversation({
          id: 1,
          last_message: mine({ id: 4, body: 'On my way' }),
          peer_last_read_message_id: 4,
          updated_at: at(14),
        }),
        makeConversation({
          id: 2,
          peer: { ...PEER, id: 3, username: 'carol' },
          last_message: makeChatMessage({ id: 6, sender_id: 3, is_deleted: true, body: '' }),
          updated_at: at(13),
        }),
      ])
    );
    renderInbox();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]).toHaveTextContent('You: On my way');
    expect(within(rows()[0]).getByRole('img', { name: 'Read' })).toBeInTheDocument();
    expect(within(rows()[1]).getByText('This message was deleted')).toHaveClass(styles.rowDeleted);
  });

  it('shows "typing…" instead of the preview while the peer types', async () => {
    api.list.mockResolvedValueOnce(inboxPage([makeConversation()]));
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(1));

    act(() => {
      useChatStore.getState().handleSocketEvent('chat_typing', {
        conversation_id: 10,
        user_id: PEER.id,
        is_typing: true,
      });
    });
    expect(rows()[0]).toHaveTextContent('typing…');
    expect(rows()[0]).not.toHaveTextContent('Message 5');
  });

  it('opens a conversation', async () => {
    api.list.mockResolvedValueOnce(inboxPage([makeConversation()]));
    const { user } = renderInbox();
    await user.click(await screen.findByRole('link', { name: /bob/ }));
    expect(screen.getByText('Conversation screen')).toBeInTheDocument();
  });

  it('invites to start a chat when there are none', async () => {
    get.mockResolvedValue({ success: true, users: [] });
    const { user } = renderInbox();

    expect(await screen.findByRole('heading', { name: 'No messages yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start a chat' }));
    expect(await screen.findByRole('dialog', { name: 'New message' })).toBeInTheDocument();
    expect(await screen.findByText('Follow people to start chatting with them.')).toBeVisible();
  });

  it('offers a retry when the inbox cannot load', async () => {
    api.list.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { user } = renderInbox();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your messages");
    api.list.mockResolvedValueOnce(inboxPage([makeConversation()]));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(api.unreadCount).toHaveBeenCalled();
  });

  it('loads more conversations as the end of the list comes into view', async () => {
    api.list.mockResolvedValueOnce(inboxPage([makeConversation({ id: 1 })], 'next'));
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(1));

    const more = deferred<ChatInboxResponse>();
    api.list.mockReturnValueOnce(more.promise);
    scrollIntoViewEnd();
    expect(screen.getByRole('status')).toHaveTextContent('Loading more conversations');
    await act(async () =>
      more.resolve(inboxPage([makeConversation({ id: 2, updated_at: at(8) })]))
    );
    expect(api.list).toHaveBeenLastCalledWith({ cursor: 'next', limit: 20 });
    expect(rows()).toHaveLength(2);
  });

  it('offers to retry a page that failed', async () => {
    api.list.mockResolvedValueOnce(inboxPage([makeConversation({ id: 1 })], 'next'));
    const { user } = renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(1));

    api.list.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    scrollIntoViewEnd();
    const retry = await screen.findByRole('button', { name: 'Load more' });
    api.list.mockResolvedValueOnce(inboxPage([makeConversation({ id: 2, updated_at: at(8) })]));
    await user.click(retry);
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('goes back', async () => {
    const { user } = renderInbox();
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.getByText('Home screen')).toBeInTheDocument();
  });

  describe('new message', () => {
    const following = [
      makeFollowUser({ id: 2, username: 'bob' }),
      makeFollowUser({ id: 4, username: 'dave', is_verified: true }),
    ];
    const followers = [
      makeFollowUser({ id: 4, username: 'dave' }),
      makeFollowUser({ id: 5, username: 'erin' }),
      makeFollowUser({ id: ME.id, username: ME.username }),
    ];

    beforeEach(() => {
      get.mockImplementation(async (url: string) => ({
        success: true,
        users: url.includes('/following') ? following : followers,
      }));
      autocomplete.mockResolvedValue({ query: '', requestId: 'r', suggestions: [] });
    });

    const openSheet = async () => {
      const view = renderInbox();
      await view.user.click(screen.getByRole('button', { name: 'New message' }));
      const dialog = await screen.findByRole('dialog', { name: 'New message' });
      await within(dialog).findByRole('list', { name: 'People you follow or who follow you' });
      return { ...view, dialog };
    };

    /** Usernames in a list, with "+" for a Mutual tag */
    const people = (dialog: HTMLElement, list = 'People you follow or who follow you') =>
      within(within(dialog).getByRole('list', { name: list }))
        .getAllByRole('button')
        .map(
          (button) =>
            `${button.querySelector(`.${sheetStyles.username}`)?.textContent}${
              within(button).queryByText('Mutual') ? '+' : ''
            }`
        );

    it('lists mutuals first, then everyone else by name, never me', async () => {
      const { dialog } = await openSheet();
      expect(get).toHaveBeenCalledWith(`/users/${ME.id}/following?limit=50`);
      expect(get).toHaveBeenCalledWith(`/users/${ME.id}/followers?limit=50`);
      expect(people(dialog)).toEqual(['dave+', 'bob', 'erin']);
    });

    it('filters by username and searches for anyone else', async () => {
      autocomplete.mockResolvedValue({
        query: 'e',
        requestId: 'r',
        suggestions: [
          { text: 'erin', kind: 'user', score: 1, meta: { userId: 5 } },
          { text: 'eve', kind: 'user', score: 1, meta: { userId: 6, isVerified: true } },
          { text: 'alice', kind: 'user', score: 1, meta: { userId: ME.id } },
          { text: 'e', kind: 'query', score: 1 },
        ],
      });
      const { user, dialog } = await openSheet();
      await user.type(within(dialog).getByRole('searchbox', { name: 'Search people' }), 'E');

      await within(dialog).findByRole('list', { name: 'More people' });
      expect(people(dialog)).toEqual(['dave+', 'erin']);
      expect(people(dialog, 'More people')).toEqual(['eve']);
      expect(autocomplete).toHaveBeenLastCalledWith('e', 8, expect.any(AbortSignal));
    });

    it('says when nobody matches, and survives a failed search', async () => {
      autocomplete.mockRejectedValue(new TypeError('Failed to fetch'));
      const { user, dialog } = await openSheet();
      await user.type(within(dialog).getByRole('searchbox'), 'zed');
      expect(await within(dialog).findByText('No one called “zed”.')).toBeVisible();
    });

    it('opens the conversation with the person picked', async () => {
      api.start.mockResolvedValueOnce({
        success: true,
        conversation: makeConversation({ id: 77, last_message: null }),
        created: true,
      });
      const { user, dialog } = await openSheet();
      await user.click(within(dialog).getByRole('button', { name: /erin/ }));

      expect(api.start).toHaveBeenCalledWith(5);
      expect(await screen.findByText('Conversation screen')).toBeInTheDocument();
      expect(screen.getByTestId('location')).toHaveTextContent('/chats/77');
    });

    it('explains who can be messaged when the server refuses', async () => {
      const start = deferred<never>();
      api.start.mockReturnValueOnce(start.promise);
      const { user, dialog } = await openSheet();
      await user.click(within(dialog).getByRole('button', { name: /bob/ }));
      // One pick at a time
      expect(within(dialog).getByRole('button', { name: /erin/ })).toBeDisabled();

      await act(async () => start.reject(new ApiError('no', 403, 'CHAT_NOT_ALLOWED')));
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'You can message people you follow or who follow you'
      );
      expect(within(dialog).getByRole('button', { name: /erin/ })).toBeEnabled();
    });

    it('shows a retry when the people cannot load, and uses whatever list did load', async () => {
      get.mockRejectedValue(new TypeError('Failed to fetch'));
      const { user } = renderInbox();
      await user.click(screen.getByRole('button', { name: 'New message' }));
      const dialog = await screen.findByRole('dialog', { name: 'New message' });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        "Couldn't load people you follow."
      );

      get.mockImplementation(async (url: string) => {
        if (url.includes('/following')) throw new TypeError('Failed to fetch');
        return { success: true, users: followers };
      });
      await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(people(dialog)).toEqual(['dave', 'erin']));
    });

    it('closes', async () => {
      const { user, dialog } = await openSheet();
      await user.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'New message' })).not.toBeInTheDocument()
      );
    });
  });
});
