import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, chatApi } from '../../services/api';
import { useChatStore } from '../../store/useChatStore';
import {
  at,
  CHAT_NOW,
  makeChatMessage,
  makeConversation,
  ME,
  messagesPage,
  mine,
  PEER,
  reaction,
} from '../../test/fixtures/chat';
import { deferred, renderWithHistory } from '../../test/fixtures/shell';
import { signIn } from '../../test/utils';
import type { ChatConversation, ChatMessage } from '../../types/chat';
import { ChatConversationPage } from './ChatConversationPage';
import bubbleStyles from './MessageBubble.module.css';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChatApiMock } = await import('../../test/fixtures/chat');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    chatApi: createChatApiMock(),
  };
});

const api = vi.mocked(chatApi);
const CID = 10;

const peerMessage = makeChatMessage({ id: 1, body: 'Hey Alice!', created_at: at(9, 0) });
const myMessage = mine({ id: 2, body: 'Hi Bob', created_at: at(9, 1) });

function setup({
  conversation = makeConversation({
    last_message: myMessage,
    my_last_read_message_id: 1,
    peer_last_delivered_message_id: 2,
  }),
  messages = [peerMessage, myMessage] as ChatMessage[],
  hasMore = false,
  path = `/chats/${CID}`,
}: {
  conversation?: ChatConversation;
  messages?: ChatMessage[];
  hasMore?: boolean;
  path?: string;
} = {}) {
  api.get.mockResolvedValue({ success: true, conversation });
  api.messages.mockResolvedValueOnce(messagesPage(messages, hasMore));
  return renderWithHistory(
    <Routes>
      <Route path="/chats" element={<p>Inbox screen</p>} />
      <Route path="/chats/:id" element={<ChatConversationPage />} />
      <Route path="/user/:username" element={<p>Profile screen</p>} />
    </Routes>,
    { entries: ['/chats', path] }
  );
}

const thread = () => screen.getByRole('log', { name: `Messages with ${PEER.username}` });
const bubble = (text: string) =>
  within(thread())
    .getAllByRole('article')
    .find((element) => element.textContent?.includes(text))!;
const row = (text: string) => bubble(text).closest('[data-message-id]') as HTMLElement;
const composer = () => screen.getByRole('textbox', { name: `Message ${PEER.username}` });
const ready = () => screen.findAllByText('Hey Alice!');

const openMenuFor = async (user: ReturnType<typeof setup>['user'], text: string) => {
  await user.click(within(row(text)).getByRole('button', { name: 'Message actions' }));
  return screen.findByRole('dialog', { name: 'Message actions' });
};

describe('ChatConversationPage', () => {
  beforeEach(() => {
    vi.setSystemTime(CHAT_NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'client-1') });
    useChatStore.getState().reset();
    signIn(ME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loading', () => {
    it('shows the peer and the thread with day separators and ticks', async () => {
      setup();
      await ready();

      expect(screen.getByRole('link', { name: /bob/ })).toHaveAttribute('href', '/user/bob');
      expect(within(thread()).getByText('Today')).toBeInTheDocument();
      expect(within(row('Hi Bob')).getByRole('img', { name: 'Delivered' })).toBeInTheDocument();
      expect(row('Hi Bob')).toHaveClass(bubbleStyles.mine);
      expect(row('Hey Alice!')).toHaveClass(bubbleStyles.theirs);
      expect(screen.getByText('This is the start of your chat with bob')).toBeInTheDocument();
      expect(api.messages).toHaveBeenCalledWith(CID, { limit: 30 });
    });

    it('shows read ticks and the unread divider, then marks the newest message read', async () => {
      setup({
        conversation: makeConversation({
          last_message: makeChatMessage({ id: 4 }),
          unread_count: 2,
          my_last_read_message_id: 2,
          peer_last_read_message_id: 2,
        }),
        messages: [
          peerMessage,
          myMessage,
          makeChatMessage({ id: 3, body: 'Are you there?', created_at: at(9, 30) }),
          makeChatMessage({ id: 4, body: 'Hello?', created_at: at(9, 31) }),
        ],
      });
      await ready();
      expect(within(row('Hi Bob')).getByRole('img', { name: 'Read' })).toBeInTheDocument();
      expect(screen.getByText('2 unread messages')).toBeInTheDocument();

      await waitFor(() => expect(api.markRead).toHaveBeenCalledWith(CID, 4));
      expect(useChatStore.getState().conversations[CID].unread_count).toBe(0);
    });

    it('invites to say hi in an empty conversation', async () => {
      setup({ conversation: makeConversation({ last_message: null }), messages: [] });
      expect(await screen.findByText('Say hi to bob 👋')).toBeInTheDocument();
    });

    it.each(['/chats/abc', '/chats/0'])('shows "not found" for %s', async (path) => {
      setup({ path });
      expect(screen.getByRole('heading', { name: 'Chat not found' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to messages' })).toHaveAttribute(
        'href',
        '/chats'
      );
      expect(api.get).not.toHaveBeenCalled();
    });

    it('shows "not found" for a conversation the user is not part of', async () => {
      api.get.mockRejectedValue(new ApiError('nope', 404, 'CONVERSATION_NOT_FOUND'));
      api.messages.mockRejectedValue(new ApiError('nope', 404, 'CONVERSATION_NOT_FOUND'));
      renderWithHistory(
        <Routes>
          <Route path="/chats/:id" element={<ChatConversationPage />} />
        </Routes>,
        { entries: ['/chats/99'] }
      );
      expect(await screen.findByRole('heading', { name: 'Chat not found' })).toBeInTheDocument();
    });

    it('offers a retry when the conversation cannot load', async () => {
      api.get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      api.messages.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { user } = renderWithHistory(
        <Routes>
          <Route path="/chats/:id" element={<ChatConversationPage />} />
        </Routes>,
        { entries: [`/chats/${CID}`] }
      );
      expect(await screen.findByRole('heading', { name: "Couldn't open this chat" })).toBeVisible();

      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockResolvedValueOnce(messagesPage([peerMessage]));
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await ready();
    });

    it('offers a retry when only the messages cannot load', async () => {
      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockRejectedValueOnce(new ApiError('x', 500));
      const { user } = renderWithHistory(
        <Routes>
          <Route path="/chats/:id" element={<ChatConversationPage />} />
        </Routes>,
        { entries: [`/chats/${CID}`] }
      );
      expect(await screen.findByText("Couldn't load messages.")).toBeVisible();
      api.messages.mockResolvedValueOnce(messagesPage([peerMessage]));
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await ready();
    });

    it('loads earlier messages, and offers a retry when that fails', async () => {
      const { user } = setup({ hasMore: true });
      api.messages.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      // The thread does not fill the screen yet, so history loads straight away
      await waitFor(() => expect(api.messages).toHaveBeenCalledWith(CID, { before: 1, limit: 30 }));
      api.messages.mockResolvedValueOnce(messagesPage([]));

      await user.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
      await waitFor(() => expect(api.messages).toHaveBeenCalledTimes(3));
    });

    it('goes back to the inbox and opens the peer’s profile', async () => {
      const { user } = setup();
      await ready();
      await user.click(screen.getByRole('link', { name: /bob/ }));
      expect(screen.getByText('Profile screen')).toBeInTheDocument();
    });

    it('goes back with the back button', async () => {
      const { user } = setup();
      await ready();
      await user.click(screen.getByRole('button', { name: 'Back to messages' }));
      expect(screen.getByText('Inbox screen')).toBeInTheDocument();
    });
  });

  describe('sending', () => {
    it('shows the message at once, then as sent, and keeps the input focused', async () => {
      const sent = deferred<{ success: boolean; message: ChatMessage }>();
      api.send.mockReturnValueOnce(sent.promise);
      const { user } = setup();
      await ready();

      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      await user.type(composer(), '  See you at 5  {Enter}');

      expect(api.send).toHaveBeenCalledWith(CID, {
        body: 'See you at 5',
        client_message_id: 'client-1',
      });
      expect(composer()).toHaveValue('');
      expect(composer()).toHaveFocus();
      expect(within(row('See you at 5')).getByRole('img', { name: 'Sending' })).toBeVisible();

      await act(async () =>
        sent.resolve({
          success: true,
          message: mine({ id: 3, body: 'See you at 5', client_message_id: 'client-1' }),
        })
      );
      expect(within(row('See you at 5')).getByRole('img', { name: 'Sent' })).toBeVisible();
    });

    it('adds a new line with Shift+Enter and sends with the button', async () => {
      api.send.mockResolvedValueOnce({
        success: true,
        message: mine({ id: 3, body: 'a\nb', client_message_id: 'client-1' }),
      });
      const { user } = setup();
      await ready();
      await user.type(composer(), 'a{Shift>}{Enter}{/Shift}b');
      expect(composer()).toHaveValue('a\nb');
      await user.click(screen.getByRole('button', { name: 'Send message' }));
      expect(api.send).toHaveBeenCalledWith(CID, { body: 'a\nb', client_message_id: 'client-1' });
    });

    it('keeps Enter for new lines on touch screens', async () => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
          matches: query === '(pointer: coarse)',
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }))
      );
      const { user } = setup();
      await ready();
      await user.type(composer(), 'a{Enter}b');
      expect(composer()).toHaveValue('a\nb');
      expect(api.send).not.toHaveBeenCalled();
    });

    it('marks a failed message and retries it with the same id', async () => {
      api.send.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { user } = setup();
      await ready();
      await user.type(composer(), 'Ping{Enter}');

      const retry = await screen.findByRole('button', { name: 'Not sent. Tap to retry' });
      expect(within(row('Ping')).getByRole('img', { name: 'Not sent' })).toBeVisible();

      api.send.mockResolvedValueOnce({
        success: true,
        message: mine({ id: 3, body: 'Ping', client_message_id: 'client-1' }),
      });
      await user.click(retry);
      expect(api.send).toHaveBeenLastCalledWith(CID, {
        body: 'Ping',
        client_message_id: 'client-1',
      });
      await waitFor(() =>
        expect(within(row('Ping')).getByRole('img', { name: 'Sent' })).toBeVisible()
      );
    });

    it('fails at once while offline, and does not retry until back online', async () => {
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const { user } = setup();
      await ready();
      await user.type(composer(), 'Offline hello{Enter}');

      expect(api.send).not.toHaveBeenCalled();
      await user.click(await screen.findByRole('button', { name: "You're offline. Tap to retry" }));
      expect(api.send).not.toHaveBeenCalled();
      expect(await screen.findByText("You're offline. Try again when you're back.")).toBeVisible();
      online.mockRestore();
    });

    it('can retry or delete a failed message from its menu', async () => {
      api.send.mockRejectedValueOnce(new ApiError('slow down', 429, 'RATE_LIMIT_EXCEEDED'));
      const { user } = setup();
      await ready();
      await user.type(composer(), 'Ping{Enter}');
      await screen.findByRole('button', { name: 'Not sent. Tap to retry' });

      let menu = await openMenuFor(user, 'Ping');
      expect(within(menu).queryByRole('group', { name: 'React' })).not.toBeInTheDocument();
      api.send.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await user.click(within(menu).getByRole('menuitem', { name: 'Try again' }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));

      menu = await openMenuFor(user, 'Ping');
      await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
      expect(within(thread()).queryByText('Ping')).not.toBeInTheDocument();
    });

    it('shows a counter near the limit and refuses too-long messages', async () => {
      const { user } = setup();
      await ready();
      await user.click(composer());
      await user.paste('x'.repeat(3800));
      expect(screen.getByText('3800/4000')).toBeInTheDocument();
      await user.paste('x'.repeat(201));
      expect(screen.getByText('4001/4000')).toBeInTheDocument();
      expect(composer()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(api.send).not.toHaveBeenCalled();
    });

    it('tells the peer while the user types, and when they stop', async () => {
      const { user } = setup();
      await ready();
      await user.type(composer(), 'Hel');
      expect(api.typing).toHaveBeenCalledTimes(1);
      expect(api.typing).toHaveBeenCalledWith(CID, true);
      await user.clear(composer());
      expect(api.typing).toHaveBeenLastCalledWith(CID, false);
      await user.type(composer(), 'x');
      await user.tab();
      expect(api.typing).toHaveBeenLastCalledWith(CID, false);
    });

    it('shows big emoji for emoji-only messages and keeps whitespace', async () => {
      setup({
        messages: [
          peerMessage,
          makeChatMessage({ id: 2, body: '😂😂', created_at: at(9, 2) }),
          makeChatMessage({ id: 3, body: 'line 1\n  line 2', created_at: at(9, 3) }),
        ],
      });
      await ready();
      expect(within(bubble('😂😂')).getByText('😂😂')).toHaveClass(bubbleStyles.emojiText);
      expect(within(bubble('line 1')).getByText(/line 1/)).toHaveClass(bubbleStyles.text);
    });
  });

  describe('replying', () => {
    it('replies from the menu, cancels with Escape and sends with the quote', async () => {
      api.send.mockResolvedValueOnce({
        success: true,
        message: mine({
          id: 3,
          body: 'Sure',
          client_message_id: 'client-1',
          reply_to: { id: 1, sender_id: PEER.id, body: 'Hey Alice!', is_deleted: false },
        }),
      });
      const { user } = setup();
      await ready();

      let menu = await openMenuFor(user, 'Hey Alice!');
      await user.click(within(menu).getByRole('menuitem', { name: 'Reply' }));
      expect(screen.getByText('Replying to bob')).toBeInTheDocument();
      expect(composer()).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByText('Replying to bob')).not.toBeInTheDocument();

      menu = await openMenuFor(user, 'Hi Bob');
      await user.click(within(menu).getByRole('menuitem', { name: 'Reply' }));
      expect(screen.getByText('Replying to You')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel reply' }));

      menu = await openMenuFor(user, 'Hey Alice!');
      await user.click(within(menu).getByRole('menuitem', { name: 'Reply' }));
      await user.type(composer(), 'Sure{Enter}');
      expect(api.send).toHaveBeenCalledWith(CID, {
        body: 'Sure',
        client_message_id: 'client-1',
        reply_to_message_id: 1,
      });
      expect(screen.queryByText('Replying to bob')).not.toBeInTheDocument();
      expect(
        await within(row('Sure')).findByRole('button', { name: /Reply to bob: Hey Alice!/ })
      ).toBeVisible();
    });

    it('replies when a message is swiped to the right', async () => {
      setup();
      await ready();
      const target = bubble('Hey Alice!');
      fireEvent.pointerDown(target, {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 10,
        clientY: 50,
      });
      fireEvent.pointerMove(target, {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 40,
        clientY: 52,
      });
      fireEvent.pointerMove(target, {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 95,
        clientY: 53,
      });
      expect(row('Hey Alice!')).toHaveClass(bubbleStyles.swiping);
      fireEvent.pointerUp(target, { pointerType: 'touch', pointerId: 1, clientX: 95, clientY: 53 });

      expect(screen.getByText('Replying to bob')).toBeInTheDocument();
      expect(row('Hey Alice!')).not.toHaveClass(bubbleStyles.swiping);
    });

    it('ignores short swipes, vertical drags and cancelled gestures', async () => {
      setup();
      await ready();
      const target = bubble('Hey Alice!');
      fireEvent.pointerDown(target, {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 10,
        clientY: 50,
      });
      fireEvent.pointerMove(target, {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 40,
        clientY: 50,
      });
      fireEvent.pointerUp(target, { pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 50 });

      fireEvent.pointerDown(target, {
        pointerType: 'touch',
        pointerId: 2,
        clientX: 10,
        clientY: 50,
      });
      fireEvent.pointerMove(target, {
        pointerType: 'touch',
        pointerId: 2,
        clientX: 12,
        clientY: 90,
      });
      fireEvent.pointerMove(target, {
        pointerType: 'touch',
        pointerId: 2,
        clientX: 80,
        clientY: 90,
      });
      fireEvent.pointerUp(target, { pointerType: 'touch', pointerId: 2, clientX: 80, clientY: 90 });

      fireEvent.pointerDown(target, {
        pointerType: 'touch',
        pointerId: 3,
        clientX: 10,
        clientY: 50,
      });
      fireEvent.pointerMove(target, {
        pointerType: 'touch',
        pointerId: 3,
        clientX: 90,
        clientY: 50,
      });
      fireEvent.pointerCancel(target, { pointerType: 'touch', pointerId: 3 });

      expect(screen.queryByText('Replying to bob')).not.toBeInTheDocument();
    });

    it('drops the reply when its message is unsent meanwhile', async () => {
      const { user } = setup();
      await ready();
      const menu = await openMenuFor(user, 'Hey Alice!');
      await user.click(within(menu).getByRole('menuitem', { name: 'Reply' }));

      act(() => {
        useChatStore.getState().handleSocketEvent('chat_message_deleted', {
          conversation_id: CID,
          message: { ...peerMessage, is_deleted: true, body: '' },
        });
      });
      expect(screen.queryByText('Replying to bob')).not.toBeInTheDocument();
      expect(await screen.findByText('The message you were replying to was deleted')).toBeVisible();
      expect(within(thread()).getByText('This message was deleted')).toBeInTheDocument();
    });

    it('jumps to the quoted message and highlights it', async () => {
      const { user } = setup({
        messages: [
          peerMessage,
          mine({
            id: 2,
            body: 'Answer',
            reply_to: { id: 1, sender_id: PEER.id, body: 'Hey Alice!', is_deleted: false },
          }),
        ],
      });
      await ready();
      await user.click(within(row('Answer')).getByRole('button', { name: /Reply to bob/ }));
      await waitFor(() => expect(row('Hey Alice!')).toHaveClass(bubbleStyles.highlighted));
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });

    it('loads history to find a quoted message, and says when it cannot', async () => {
      // A tall thread, so history only loads on demand
      const scrollHeight = vi
        .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
        .mockReturnValue(2000);
      const clientHeight = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockReturnValue(500);
      const { user } = setup({
        messages: [
          makeChatMessage({ id: 10, body: 'Hey Alice!', created_at: at(9) }),
          mine({
            id: 15,
            body: 'About that',
            reply_to: { id: 3, sender_id: PEER.id, body: 'Older', is_deleted: false },
            created_at: at(9, 5),
          }),
          mine({
            id: 16,
            body: 'And this',
            reply_to: { id: 1, sender_id: PEER.id, body: 'Ancient', is_deleted: false },
            created_at: at(9, 6),
          }),
        ],
        hasMore: true,
      });
      await ready();
      expect(api.messages).toHaveBeenCalledTimes(1);

      api.messages.mockResolvedValueOnce(
        messagesPage([makeChatMessage({ id: 3, body: 'Older', created_at: at(8) })], true)
      );
      await user.click(within(row('About that')).getByRole('button', { name: /Reply to bob/ }));
      await waitFor(() =>
        expect(within(thread()).getAllByRole('article')[0]).toHaveTextContent('Older')
      );
      expect(api.messages).toHaveBeenLastCalledWith(CID, { before: 10, limit: 30 });

      api.messages.mockResolvedValueOnce(messagesPage([], false));
      await user.click(within(row('And this')).getByRole('button', { name: /Reply to bob/ }));
      expect(await screen.findByText("The original message isn't available")).toBeVisible();
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    });
  });
  describe('message menu', () => {
    it('opens with the keyboard, moves through reactions and closes with Escape', async () => {
      const { user } = setup();
      await ready();
      bubble('Hey Alice!').focus();
      await user.keyboard('{Enter}');

      const menu = await screen.findByRole('dialog', { name: 'Message actions' });
      const reactions = within(menu).getAllByRole('button', { name: /^React/ });
      expect(reactions).toHaveLength(6);
      expect(reactions[0]).toHaveFocus();
      await user.keyboard('{ArrowRight}');
      expect(reactions[1]).toHaveFocus();

      const items = within(menu).getAllByRole('menuitem');
      expect(items.map((item) => item.textContent)).toEqual(['Reply', 'Copy']);
      items[0].focus();
      await user.keyboard('{ArrowDown}');
      expect(items[1]).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(items[0]).toHaveFocus();
      await user.keyboard('{End}');
      expect(items[1]).toHaveFocus();
      await user.keyboard('{Home}');
      expect(items[0]).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(items[1]).toHaveFocus();
      await user.keyboard('x');

      await user.keyboard('{Escape}');
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Message actions' })).not.toBeInTheDocument()
      );
      expect(bubble('Hey Alice!')).toHaveFocus();
    });

    it('opens on right-click and with the context-menu key, and closes on a tap outside', async () => {
      const { user } = setup();
      await ready();
      fireEvent.contextMenu(bubble('Hi Bob'));
      let menu = await screen.findByRole('dialog', { name: 'Message actions' });
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent)
      ).toEqual(['Reply', 'Copy', 'Unsend']);
      await user.click(menu.parentElement!);
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Message actions' })).not.toBeInTheDocument()
      );

      fireEvent.keyDown(bubble('Hi Bob'), { key: 'ContextMenu' });
      menu = await screen.findByRole('dialog', { name: 'Message actions' });
      fireEvent.contextMenu(menu.parentElement!);
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Message actions' })).not.toBeInTheDocument()
      );

      // Other keys do nothing
      fireEvent.keyDown(bubble('Hi Bob'), { key: 'a' });
      expect(screen.queryByRole('dialog', { name: 'Message actions' })).not.toBeInTheDocument();
    });

    it('opens on a long press, with a little vibration', async () => {
      const vibrate = vi.fn();
      Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
      setup();
      await ready();
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const target = bubble('Hey Alice!');
      fireEvent.pointerDown(target, {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 10,
        clientY: 50,
      });
      act(() => vi.advanceTimersByTime(400));
      fireEvent.pointerUp(target, { pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 50 });
      // The tap that ends the press and the browser's context menu don't do anything more
      fireEvent.click(target);
      fireEvent.contextMenu(target);
      vi.useRealTimers();

      expect(screen.getByRole('dialog', { name: 'Message actions' })).toBeInTheDocument();
      expect(vibrate).toHaveBeenCalledWith(10);
      Reflect.deleteProperty(navigator, 'vibrate');
    });

    it('copies a message', async () => {
      const { user } = setup();
      await ready();
      // user-event installs its own clipboard; watch what the app writes to it
      const writeText = vi.spyOn(navigator.clipboard, 'writeText');
      const menu = await openMenuFor(user, 'Hey Alice!');
      await user.click(within(menu).getByRole('menuitem', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith('Hey Alice!');
      expect(await screen.findByText('Copied')).toBeVisible();

      writeText.mockRejectedValueOnce(new Error('denied'));
      await user.click(
        within(await openMenuFor(user, 'Hey Alice!')).getByRole('menuitem', { name: 'Copy' })
      );
      expect(await screen.findByText("Couldn't copy the message")).toBeVisible();
    });
  });

  describe('reactions', () => {
    it('reacts from the menu, shows who reacted and removes my reaction', async () => {
      api.react.mockResolvedValueOnce({
        success: true,
        message_id: 1,
        reactions: [reaction(ME.id, '😂')],
      });
      api.unreact.mockResolvedValueOnce({ success: true, message_id: 1, reactions: [] });
      const { user } = setup();
      await ready();

      const menu = await openMenuFor(user, 'Hey Alice!');
      await user.click(within(menu).getByRole('button', { name: 'React 😂' }));
      expect(api.react).toHaveBeenCalledWith(CID, 1, '😂');
      const chip = await within(row('Hey Alice!')).findByRole('button', {
        name: 'Reactions: 😂 1',
      });

      await user.click(chip);
      const sheet = await screen.findByRole('dialog', { name: 'Reactions' });
      await user.click(within(sheet).getByRole('button', { name: 'Remove your 😂 reaction' }));
      expect(api.unreact).toHaveBeenCalledWith(CID, 1);
      await waitFor(() =>
        expect(
          within(row('Hey Alice!')).queryByRole('button', { name: /^Reactions/ })
        ).not.toBeInTheDocument()
      );
    });

    it('lists the peer’s reaction and closes the sheet', async () => {
      const { user } = setup({
        messages: [{ ...peerMessage, reactions: [reaction(PEER.id, '❤️'), reaction(ME.id, '❤️')] }],
      });
      await ready();
      await user.click(within(row('Hey Alice!')).getByRole('button', { name: 'Reactions: ❤️ 2' }));
      const sheet = await screen.findByRole('dialog', { name: 'Reactions' });
      expect(within(sheet).getByText('bob')).toBeInTheDocument();
      expect(within(sheet).getByText('You')).toBeInTheDocument();
      await user.click(within(sheet).getByRole('button', { name: 'Close' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Reactions' })).not.toBeInTheDocument()
      );
    });

    it('removes my reaction when I pick it again in the menu', async () => {
      api.unreact.mockResolvedValueOnce({ success: true, message_id: 1, reactions: [] });
      const { user } = setup({
        messages: [{ ...peerMessage, reactions: [reaction(ME.id, '👍')] }],
      });
      await ready();
      const menu = await openMenuFor(user, 'Hey Alice!');
      const selected = within(menu).getByRole('button', { name: 'Remove 👍 reaction' });
      expect(selected).toHaveAttribute('aria-pressed', 'true');
      expect(selected).toHaveFocus();
      await user.click(selected);
      expect(api.unreact).toHaveBeenCalledWith(CID, 1);
    });

    it('reacts ❤️ on a double tap of the peer’s message, only once', async () => {
      api.react.mockResolvedValue({
        success: true,
        message_id: 1,
        reactions: [reaction(ME.id, '❤️')],
      });
      const { user } = setup();
      await ready();
      await user.dblClick(bubble('Hey Alice!'));
      expect(api.react).toHaveBeenCalledWith(CID, 1, '❤️');
      await within(row('Hey Alice!')).findByRole('button', { name: 'Reactions: ❤️ 1' });
      await user.dblClick(bubble('Hey Alice!'));
      // My own messages don't react to taps
      await user.dblClick(bubble('Hi Bob'));
      expect(api.react).toHaveBeenCalledTimes(1);
    });

    it('takes a failed reaction back and says so', async () => {
      api.react.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { user } = setup();
      await ready();
      const menu = await openMenuFor(user, 'Hey Alice!');
      await user.click(within(menu).getByRole('button', { name: 'React 🙏' }));
      expect(
        await screen.findByText(
          "Couldn't react to the message. Check your connection and try again."
        )
      ).toBeVisible();
      expect(
        within(row('Hey Alice!')).queryByRole('button', { name: /^Reactions/ })
      ).not.toBeInTheDocument();
    });
  });

  describe('unsending', () => {
    it('asks first, then shows the message as deleted', async () => {
      api.unsend.mockResolvedValueOnce({
        success: true,
        message: { ...myMessage, is_deleted: true, body: '' },
      });
      const { user } = setup();
      await ready();
      const menu = await openMenuFor(user, 'Hi Bob');
      await user.click(within(menu).getByRole('menuitem', { name: 'Unsend' }));

      const dialog = await screen.findByRole('alertdialog', { name: 'Unsend message?' });
      await user.click(within(dialog).getByRole('button', { name: 'Unsend' }));
      expect(api.unsend).toHaveBeenCalledWith(CID, 2);
      expect(await within(thread()).findByText('This message was deleted')).toBeInTheDocument();
      expect(
        within(row('This message was deleted')).queryByRole('button', { name: 'Message actions' })
      ).not.toBeInTheDocument();
    });

    it('can be cancelled, and explains a failure', async () => {
      api.unsend.mockRejectedValueOnce(new ApiError('no', 403, 'MESSAGE_FORBIDDEN'));
      const { user } = setup();
      await ready();
      await user.click(
        within(await openMenuFor(user, 'Hi Bob')).getByRole('menuitem', { name: 'Unsend' })
      );
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' })
      );
      expect(api.unsend).not.toHaveBeenCalled();

      await user.click(
        within(await openMenuFor(user, 'Hi Bob')).getByRole('menuitem', { name: 'Unsend' })
      );
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unsend' })
      );
      expect(await screen.findByText('You can only unsend your own messages')).toBeVisible();
      expect(within(thread()).getByText('Hi Bob')).toBeInTheDocument();
    });
  });

  describe('when the user can no longer reply', () => {
    it('shows the history with a notice instead of the composer', async () => {
      const { user } = setup({
        conversation: makeConversation({ last_message: myMessage, can_message: false }),
      });
      await ready();
      expect(screen.getByRole('note')).toHaveTextContent("You can't reply to this conversation");
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

      const menu = await openMenuFor(user, 'Hey Alice!');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent)
      ).toEqual(['Copy']);
    });

    it('says "No messages yet" in an empty conversation', async () => {
      setup({
        conversation: makeConversation({ last_message: null, can_message: false }),
        messages: [],
      });
      expect(await screen.findByText('No messages yet')).toBeInTheDocument();
    });
  });

  describe('real-time', () => {
    it('shows the peer typing in the header and the thread', async () => {
      setup();
      await ready();
      act(() => {
        useChatStore.getState().handleSocketEvent('chat_typing', {
          conversation_id: CID,
          user_id: PEER.id,
          is_typing: true,
        });
      });
      expect(screen.getByText('typing…')).toBeInTheDocument();
      expect(screen.getByLabelText('bob is typing')).toBeInTheDocument();
    });

    it('follows new messages at the bottom, and offers a pill when scrolled up', async () => {
      setup();
      await ready();
      act(() => {
        useChatStore.getState().handleSocketEvent('chat_message', {
          conversation_id: CID,
          message: makeChatMessage({ id: 3, body: 'New one', created_at: at(10) }),
        });
      });
      expect(within(thread()).getByText('New one')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /new message/ })).not.toBeInTheDocument();

      // Scroll up
      const list = thread();
      Object.defineProperty(list, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true });
      list.scrollTop = 600;
      fireEvent.scroll(list);
      expect(screen.getByRole('button', { name: 'Go to latest message' })).toBeVisible();

      act(() => {
        useChatStore.getState().handleSocketEvent('chat_message', {
          conversation_id: CID,
          message: makeChatMessage({ id: 4, body: 'Another', created_at: at(10, 1) }),
        });
      });
      const pill = screen.getByRole('button', { name: '1 new message, go to latest' });
      expect(pill).toHaveTextContent('1 new');

      fireEvent.click(pill);
      expect(list.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
      expect(screen.queryByRole('button', { name: /go to latest/i })).not.toBeInTheDocument();
    });

    it('catches up when the app regains focus', async () => {
      setup();
      await ready();
      api.messages.mockResolvedValueOnce(
        messagesPage([makeChatMessage({ id: 3, body: 'Missed it', created_at: at(10) })])
      );
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(await within(thread()).findByText('Missed it')).toBeInTheDocument();
      expect(api.messages).toHaveBeenLastCalledWith(CID, { after: 2, limit: 100 });
    });
  });
});
