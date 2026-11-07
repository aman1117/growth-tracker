import { act, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, chatApi } from '../../services/api';
import { useChatStore } from '../../store/useChatStore';
import { makeConversation, PEER } from '../../test/fixtures/chat';
import { deferred, renderWithHistory } from '../../test/fixtures/shell';
import { ChatHeaderButton } from './ChatHeaderButton';
import { MessageButton } from './MessageButton';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChatApiMock } = await import('../../test/fixtures/chat');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    chatApi: createChatApiMock(),
  };
});

const api = vi.mocked(chatApi);

const unread = (conversations: number) =>
  api.unreadCount.mockResolvedValue({
    success: true,
    unread_conversations: conversations,
    unread_messages: conversations * 2,
  });

describe('ChatHeaderButton', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });

  const renderButton = (path = '/') =>
    renderWithHistory(
      <Routes>
        <Route path="*" element={<ChatHeaderButton />} />
      </Routes>,
      { entries: [path] }
    );

  it('shows the number of unread conversations and opens the inbox', async () => {
    unread(3);
    const { user } = renderButton();
    const button = await screen.findByRole('button', { name: 'Messages (3 unread)' });
    expect(button).toHaveTextContent('3');

    await user.click(button);
    expect(screen.getByTestId('location')).toHaveTextContent('/chats');
    expect(screen.getByRole('button', { name: 'Messages (3 unread)' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('caps the badge and hides it when everything is read', async () => {
    unread(120);
    renderButton();
    expect(await screen.findByRole('button', { name: 'Messages (120 unread)' })).toHaveTextContent(
      '99+'
    );
    unread(0);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByRole('button', { name: 'Messages' })).toHaveTextContent('');
  });
});

describe('MessageButton', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const renderMessageButton = () =>
    renderWithHistory(
      <Routes>
        <Route
          path="/user/:username"
          element={<MessageButton userId={PEER.id} username={PEER.username} />}
        />
        <Route path="/chats/:id" element={<p>Conversation screen</p>} />
      </Routes>,
      { entries: ['/user/bob'] }
    );

  it('opens the conversation with the user', async () => {
    const start = deferred<{
      success: boolean;
      conversation: ReturnType<typeof makeConversation>;
      created: boolean;
    }>();
    api.start.mockReturnValueOnce(start.promise);
    const { user } = renderMessageButton();

    await user.click(screen.getByRole('button', { name: 'Message bob' }));
    expect(screen.getByRole('button', { name: 'Message bob' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Message bob' }));
    expect(api.start).toHaveBeenCalledTimes(1);

    await act(async () =>
      start.resolve({ success: true, conversation: makeConversation({ id: 31 }), created: false })
    );
    expect(screen.getByText('Conversation screen')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/chats/31');
  });

  it('explains when the user cannot be messaged', async () => {
    api.start.mockRejectedValueOnce(new ApiError('no', 403, 'CHAT_NOT_ALLOWED'));
    const { user } = renderMessageButton();
    await user.click(screen.getByRole('button', { name: 'Message bob' }));
    expect(
      await screen.findByText('You can message people you follow or who follow you')
    ).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Message bob' })).toBeEnabled());
  });

  it('does nothing once the profile is left', async () => {
    const start = deferred<never>();
    api.start.mockReturnValueOnce(start.promise);
    const { user, unmount } = renderMessageButton();
    await user.click(screen.getByRole('button', { name: 'Message bob' }));
    unmount();
    await act(async () => start.reject(new TypeError('Failed to fetch')));
    expect(screen.queryByText(/Couldn't open the chat/)).not.toBeInTheDocument();
  });
});
