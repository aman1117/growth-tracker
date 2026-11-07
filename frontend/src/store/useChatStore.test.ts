import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, chatApi } from '../services/api';
import { gl } from '../services/goodlogs';
import {
  at,
  inboxPage,
  makeChatMessage,
  makeConversation,
  ME,
  messagesPage,
  mine,
  PEER,
  reaction,
} from '../test/fixtures/chat';
import { deferred } from '../test/fixtures/shell';
import type { ChatMessagesResponse } from '../types/chat';
import { TYPING_EXPIRY_MS } from '../utils/chat';
import { GAP_FILL_MAX_PAGES, isChatEventType, SEND_TIMEOUT_MS, useChatStore } from './useChatStore';

vi.mock('../services/api', async (importOriginal) => {
  const { createChatApiMock } = await import('../test/fixtures/chat');
  return {
    ...(await importOriginal<typeof import('../services/api')>()),
    chatApi: createChatApiMock(),
  };
});

const api = vi.mocked(chatApi);
const store = () => useChatStore.getState();
const CID = 10;
const flush = () => act(async () => {});

const networkError = () => new TypeError('Failed to fetch');

/** Loads conversation CID with `messages` into the store */
async function openWith(
  messages = [makeChatMessage({ id: 1 }), mine({ id: 2 })],
  conversation = makeConversation({
    last_message: messages[messages.length - 1] ?? null,
    my_last_read_message_id: messages[messages.length - 1]?.id ?? 0,
  })
) {
  api.get.mockResolvedValue({ success: true, conversation });
  api.messages.mockResolvedValueOnce(messagesPage(messages));
  await act(() => store().openConversation(CID));
}

describe('useChatStore', () => {
  beforeEach(() => {
    store().reset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('recognises chat event types', () => {
    expect(isChatEventType('chat_message')).toBe(true);
    expect(isChatEventType('notification')).toBe(false);
    expect(isChatEventType(42)).toBe(false);
  });

  describe('inbox', () => {
    it('loads the first page and pages on with the cursor', async () => {
      const first = makeConversation({ id: 1, updated_at: at(12) });
      const second = makeConversation({ id: 2, updated_at: at(11) });
      api.list.mockResolvedValueOnce(inboxPage([first], 'cursor-2'));
      await act(() => store().fetchInbox());
      expect(store()).toMatchObject({
        inboxStatus: 'ready',
        inboxCursor: 'cursor-2',
        inboxHasMore: true,
      });
      expect(api.list).toHaveBeenCalledWith({ limit: 20 });

      api.list.mockResolvedValueOnce(inboxPage([second]));
      await act(() => store().loadMoreInbox());
      expect(api.list).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 20 });
      expect(Object.keys(store().conversations)).toEqual(['1', '2']);
      expect(store().inboxHasMore).toBe(false);

      // Nothing more to load
      await act(() => store().loadMoreInbox());
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('shares a load in flight unless forced, and ignores a superseded one', async () => {
      const slow = deferred<ReturnType<typeof inboxPage>>();
      api.list.mockReturnValueOnce(slow.promise);
      const first = store().fetchInbox();
      expect(store().fetchInbox()).toBe(first);
      expect(store().inboxStatus).toBe('loading');

      api.list.mockResolvedValueOnce(inboxPage([makeConversation({ id: 2 })]));
      await act(() => store().fetchInbox({ force: true }));
      await act(async () => slow.resolve(inboxPage([makeConversation({ id: 1 })])));
      expect(Object.keys(store().conversations)).toEqual(['2']);
    });

    it('shows an error without a loaded list and keeps a loaded one', async () => {
      api.list.mockRejectedValueOnce(networkError());
      await act(() => store().fetchInbox());
      expect(store().inboxStatus).toBe('error');
      expect(gl.warn).toHaveBeenCalledWith(
        'chat_inbox_load_failed',
        expect.objectContaining({ metadata: expect.objectContaining({ recovery: 'show_retry' }) })
      );

      api.list.mockResolvedValueOnce(inboxPage([makeConversation()]));
      await act(() => store().fetchInbox());
      api.list.mockRejectedValueOnce(new ApiError('x', 500));
      await act(() => store().fetchInbox({ force: true }));
      expect(store().inboxStatus).toBe('ready');
    });

    it('treats a missing list as empty', async () => {
      api.list.mockResolvedValueOnce({ success: true } as never);
      await act(() => store().fetchInbox());
      expect(store()).toMatchObject({ inboxStatus: 'ready', inboxHasMore: false });
    });

    it('flags a failed next page for a retry', async () => {
      api.list.mockResolvedValueOnce(inboxPage([makeConversation({ id: 1 })], 'c2'));
      await act(() => store().fetchInbox());
      api.list.mockRejectedValueOnce(networkError());
      await act(() => store().loadMoreInbox());
      expect(store()).toMatchObject({ inboxLoadingMore: false, inboxMoreError: true });
      api.list.mockResolvedValueOnce({ success: true } as never);
      await act(() => store().loadMoreInbox());
      expect(store()).toMatchObject({ inboxMoreError: false, inboxHasMore: false });
    });

    it('drops responses that arrive after a reset', async () => {
      const slow = deferred<ReturnType<typeof inboxPage>>();
      api.list.mockReturnValueOnce(slow.promise);
      const load = store().fetchInbox();
      store().reset();
      await act(async () => {
        slow.resolve(inboxPage([makeConversation()]));
        await load;
      });
      expect(store().conversations).toEqual({});
      expect(store().inboxStatus).toBe('idle');
    });
  });

  describe('unread totals', () => {
    it('loads the totals once at a time and keeps them on failure', async () => {
      api.unreadCount.mockResolvedValueOnce({
        success: true,
        unread_conversations: 2,
        unread_messages: 5,
      });
      const first = store().fetchUnreadCount();
      expect(store().fetchUnreadCount()).toBe(first);
      await act(() => first);
      expect(store()).toMatchObject({ unreadConversations: 2, unreadMessages: 5 });

      api.unreadCount.mockRejectedValueOnce(networkError());
      await act(() => store().fetchUnreadCount());
      expect(store().unreadConversations).toBe(2);
    });

    it('ignores malformed totals', async () => {
      api.unreadCount.mockResolvedValueOnce({ success: true } as never);
      await act(() => store().fetchUnreadCount());
      expect(store()).toMatchObject({ unreadConversations: 0, unreadMessages: 0 });
    });

    it('follows changes of each conversation’s unread count', async () => {
      api.unreadCount.mockResolvedValueOnce({
        success: true,
        unread_conversations: 1,
        unread_messages: 2,
      });
      await act(() => store().fetchUnreadCount());
      await openWith(
        [makeChatMessage({ id: 1 }), makeChatMessage({ id: 2 })],
        makeConversation({
          last_message: makeChatMessage({ id: 2 }),
          unread_count: 2,
          my_last_read_message_id: 0,
        })
      );
      act(() => store().markRead(CID, 2));
      expect(store()).toMatchObject({ unreadConversations: 0, unreadMessages: 0 });
    });
  });

  describe('opening a conversation', () => {
    it('loads the conversation and its newest messages', async () => {
      await openWith();
      expect(api.messages).toHaveBeenCalledWith(CID, { limit: 30 });
      expect(store().activeConversationId).toBe(CID);
      expect(store().conversationStatus[CID]).toBe('ready');
      expect(store().threads[CID]).toMatchObject({ status: 'ready', hasOlder: false });
      expect(store().threads[CID].messages.map((message) => message.id)).toEqual([1, 2]);
      expect(gl.info).toHaveBeenCalledWith('chat_conversation_opened', {
        metadata: { conversationId: CID, cached: false },
      });
    });

    it('catches up with messages after the newest one when the thread is cached', async () => {
      await openWith();
      api.messages.mockResolvedValueOnce(messagesPage([makeChatMessage({ id: 3 })]));
      await act(() => store().openConversation(CID));
      expect(api.messages).toHaveBeenLastCalledWith(CID, { after: 2, limit: 100 });
      expect(store().threads[CID].messages.map((message) => message.id)).toEqual([1, 2, 3]);
      expect(store().conversations[CID].last_message?.id).toBe(3);
    });

    it('pages through a long gap and stops after a few pages', async () => {
      await openWith();
      for (let page = 0; page < GAP_FILL_MAX_PAGES; page++) {
        api.messages.mockResolvedValueOnce(
          messagesPage([makeChatMessage({ id: 10 + page })], true)
        );
      }
      await act(() => store().refreshConversation(CID));
      expect(api.messages).toHaveBeenCalledTimes(1 + GAP_FILL_MAX_PAGES);
      expect(api.messages).toHaveBeenLastCalledWith(CID, { after: 13, limit: 100 });
      expect(gl.debug).toHaveBeenCalledWith('chat_gap_fill_truncated', expect.anything());
    });

    it('stops a gap fill at an empty page and survives a failed one', async () => {
      await openWith();
      api.messages.mockResolvedValueOnce({ success: true, has_more: true } as never);
      await act(() => store().refreshConversation(CID));
      expect(api.messages).toHaveBeenCalledTimes(2);

      api.messages.mockRejectedValueOnce(networkError());
      await act(() => store().refreshConversation(CID));
      expect(store().threads[CID].status).toBe('ready');
      expect(gl.warn).toHaveBeenCalledWith('chat_gap_fill_failed', expect.anything());
    });

    it('loads the newest page instead when there is nothing to fill from', async () => {
      await openWith([]);
      api.messages.mockResolvedValueOnce(messagesPage([makeChatMessage({ id: 1 })]));
      await act(() => store().refreshConversation(CID));
      expect(api.messages).toHaveBeenLastCalledWith(CID, { limit: 30 });
    });

    it('marks a missing conversation as not found', async () => {
      api.get.mockRejectedValue(new ApiError('nope', 404, 'CONVERSATION_NOT_FOUND'));
      api.messages.mockRejectedValue(new ApiError('nope', 404, 'CONVERSATION_NOT_FOUND'));
      await act(() => store().openConversation(CID));
      expect(store().conversationStatus[CID]).toBe('not_found');
      expect(store().threads[CID].status).toBe('not_found');
    });

    it('shows a retry for failed loads, but keeps what was loaded', async () => {
      api.get.mockRejectedValueOnce(networkError());
      api.messages.mockRejectedValueOnce(networkError());
      await act(() => store().openConversation(CID));
      expect(store().conversationStatus[CID]).toBe('error');
      expect(store().threads[CID].status).toBe('error');

      store().reset();
      await openWith();
      api.get.mockRejectedValueOnce(new ApiError('x', 500));
      await act(() => store().refreshConversation(CID));
      expect(store().conversationStatus[CID]).toBe('ready');
    });

    it('keeps a deeper history when the newest page is reloaded', async () => {
      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockResolvedValueOnce(messagesPage([makeChatMessage({ id: 5 })], true));
      await act(() => store().openConversation(CID));
      api.messages.mockRejectedValueOnce(networkError());
      // A failed gap fill falls back to nothing; a newest-page reload keeps hasOlder
      expect(store().threads[CID].hasOlder).toBe(true);
    });

    it('shares the newest-page load while it is running', async () => {
      const page = deferred<ChatMessagesResponse>();
      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockReturnValueOnce(page.promise);
      const first = store().openConversation(CID);
      const second = store().openConversation(CID);
      await act(async () => {
        page.resolve(messagesPage([makeChatMessage({ id: 1 })]));
        await Promise.all([first, second]);
      });
      expect(api.messages).toHaveBeenCalledTimes(1);
    });

    it('treats a missing message list as empty', async () => {
      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockResolvedValueOnce({ success: true } as never);
      await act(() => store().openConversation(CID));
      expect(store().threads[CID]).toMatchObject({ status: 'ready', messages: [] });
    });

    it('forgets the active conversation when it closes', async () => {
      await openWith();
      store().closeConversation(99);
      expect(store().activeConversationId).toBe(CID);
      store().closeConversation(CID);
      expect(store().activeConversationId).toBeNull();
    });
  });

  describe('older messages', () => {
    it('loads the page before the oldest message', async () => {
      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockResolvedValueOnce(messagesPage([makeChatMessage({ id: 5 })], true));
      await act(() => store().openConversation(CID));
      api.messages.mockResolvedValueOnce(messagesPage([makeChatMessage({ id: 4 })], false));
      await act(() => store().loadOlder(CID));
      expect(api.messages).toHaveBeenLastCalledWith(CID, { before: 5, limit: 30 });
      expect(store().threads[CID]).toMatchObject({ hasOlder: false, loadingOlder: false });
      expect(store().threads[CID].messages.map((message) => message.id)).toEqual([4, 5]);

      await act(() => store().loadOlder(CID));
      expect(api.messages).toHaveBeenCalledTimes(2);
    });

    it('flags a failure for a retry, and treats a missing list as empty', async () => {
      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockResolvedValueOnce(messagesPage([makeChatMessage({ id: 5 })], true));
      await act(() => store().openConversation(CID));
      api.messages.mockRejectedValueOnce(networkError());
      await act(() => store().loadOlder(CID));
      expect(store().threads[CID]).toMatchObject({ olderError: true, loadingOlder: false });
      api.messages.mockResolvedValueOnce({ success: true, has_more: false } as never);
      await act(() => store().loadOlder(CID));
      expect(store().threads[CID]).toMatchObject({ olderError: false, hasOlder: false });
    });

    it('does nothing without a loaded thread or a confirmed message', async () => {
      await act(() => store().loadOlder(CID));
      api.get.mockResolvedValue({ success: true, conversation: makeConversation() });
      api.messages.mockResolvedValueOnce(messagesPage([], true));
      await act(() => store().openConversation(CID));
      await act(() => store().loadOlder(CID));
      expect(api.messages).toHaveBeenCalledTimes(1);
    });
  });

  describe('starting a conversation', () => {
    it('get-or-creates it and keeps it', async () => {
      const conversation = makeConversation({ id: 77, last_message: null });
      api.start.mockResolvedValueOnce({ success: true, conversation, created: true });
      await expect(act(() => store().startConversation(PEER.id))).resolves.toEqual(conversation);
      expect(api.start).toHaveBeenCalledWith(PEER.id);
      expect(store().conversationStatus[77]).toBe('ready');
      expect(gl.info).toHaveBeenCalledWith('chat_conversation_started', {
        metadata: { conversationId: 77, created: true },
      });
    });

    it('logs and rethrows a refusal', async () => {
      const refusal = new ApiError('no', 403, 'CHAT_NOT_ALLOWED');
      api.start.mockRejectedValueOnce(refusal);
      await expect(store().startConversation(PEER.id)).rejects.toBe(refusal);
      expect(gl.warn).toHaveBeenCalledWith(
        'chat_conversation_start_failed',
        expect.objectContaining({
          metadata: expect.objectContaining({ errorCode: 'CHAT_NOT_ALLOWED', status: 403 }),
        })
      );
    });
  });

  describe('sending', () => {
    beforeEach(() => {
      vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'client-1') });
    });

    it('shows the message at once and swaps it for the server copy', async () => {
      await openWith();
      const sent = deferred<{ success: boolean; message: ReturnType<typeof mine> }>();
      api.send.mockReturnValueOnce(sent.promise);
      act(() => store().sendMessage(CID, '  Hello  ', { meId: ME.id }));

      const optimistic = store().threads[CID].messages.at(-1)!;
      expect(optimistic).toMatchObject({
        body: 'Hello',
        sender_id: ME.id,
        client_message_id: 'client-1',
        send_status: 'pending',
      });
      expect(optimistic.id).toBeLessThan(0);
      expect(api.send).toHaveBeenCalledWith(CID, { body: 'Hello', client_message_id: 'client-1' });

      await act(async () =>
        sent.resolve({
          success: true,
          message: mine({ id: 3, body: 'Hello', client_message_id: 'client-1' }),
        })
      );
      const messages = store().threads[CID].messages;
      expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
      expect(messages[2].send_status).toBeUndefined();
      expect(store().conversations[CID].last_message?.id).toBe(3);
      expect(gl.info).toHaveBeenCalledWith('chat_message_sent', {
        metadata: { conversationId: CID, messageId: 3, retry: false, isReply: false },
      });
    });

    it('ignores blank messages', () => {
      store().sendMessage(CID, '   ', { meId: ME.id });
      expect(api.send).not.toHaveBeenCalled();
    });

    it('sends a reply with the quoted message', async () => {
      await openWith();
      api.send.mockResolvedValueOnce({
        success: true,
        message: mine({ id: 3, client_message_id: 'client-1' }),
      });
      const target = store().threads[CID].messages[0];
      await act(async () => store().sendMessage(CID, 'Yes', { meId: ME.id, replyTo: target }));
      expect(api.send).toHaveBeenCalledWith(CID, {
        body: 'Yes',
        client_message_id: 'client-1',
        reply_to_message_id: 1,
      });
    });

    it('quotes a deleted target without its text', async () => {
      await openWith();
      api.send.mockReturnValueOnce(new Promise(() => {}));
      act(() =>
        store().sendMessage(CID, 'Hm', {
          meId: ME.id,
          replyTo: makeChatMessage({ id: 1, is_deleted: true, body: 'gone' }),
        })
      );
      expect(store().threads[CID].messages.at(-1)!.reply_to).toEqual({
        id: 1,
        sender_id: PEER.id,
        body: '',
        is_deleted: true,
      });
    });

    it('marks a failed send and retries it with the same client id', async () => {
      await openWith();
      api.send.mockRejectedValueOnce(networkError());
      await act(async () => store().sendMessage(CID, 'Hi', { meId: ME.id }));
      let message = store().threads[CID].messages.at(-1)!;
      expect(message).toMatchObject({ send_status: 'failed', send_error: undefined });
      expect(gl.warn).toHaveBeenCalledWith('chat_message_send_failed', expect.anything());

      api.send.mockResolvedValueOnce({
        success: true,
        message: mine({ id: 3, body: 'Hi', client_message_id: 'client-1' }),
      });
      await act(async () => store().retryMessage(CID, 'client-1'));
      expect(api.send).toHaveBeenLastCalledWith(CID, { body: 'Hi', client_message_id: 'client-1' });
      message = store().threads[CID].messages.at(-1)!;
      expect(message).toMatchObject({ id: 3 });
      expect(message.send_status).toBeUndefined();
    });

    it('explains specific refusals and closes the conversation for messages', async () => {
      await openWith();
      api.send.mockRejectedValueOnce(new ApiError('no', 403, 'CHAT_NOT_ALLOWED'));
      await act(async () => store().sendMessage(CID, 'Hi', { meId: ME.id }));
      expect(store().threads[CID].messages.at(-1)!.send_error).toBe(
        'You can message people you follow or who follow you'
      );
      expect(store().conversations[CID].can_message).toBe(false);
    });

    it('fails a malformed server response', async () => {
      await openWith();
      api.send.mockResolvedValueOnce({ success: true, message: { id: 'x' } } as never);
      await act(async () => store().sendMessage(CID, 'Hi', { meId: ME.id }));
      expect(store().threads[CID].messages.at(-1)!.send_status).toBe('failed');
    });

    it('fails at once while offline and keeps retries local until back online', async () => {
      await openWith();
      act(() => store().sendMessage(CID, 'Hi', { meId: ME.id, offline: true }));
      expect(store().threads[CID].messages.at(-1)).toMatchObject({
        send_status: 'failed',
        send_error: "You're offline.",
      });
      store().retryMessage(CID, 'client-1', { offline: true });
      expect(api.send).not.toHaveBeenCalled();
    });

    it('ignores a second retry while one is in flight, and unknown messages', async () => {
      await openWith();
      act(() => store().sendMessage(CID, 'Hi', { meId: ME.id, offline: true }));
      api.send.mockReturnValue(new Promise(() => {}));
      store().retryMessage(CID, 'client-1');
      store().retryMessage(CID, 'client-1');
      store().retryMessage(CID, 'unknown');
      await flush();
      expect(api.send).toHaveBeenCalledTimes(1);
    });

    it('lets the WebSocket echo confirm the message before the response', async () => {
      await openWith();
      const sent = deferred<never>();
      api.send.mockReturnValueOnce(sent.promise);
      act(() => store().sendMessage(CID, 'Hi', { meId: ME.id }));
      act(() => {
        store().handleSocketEvent('chat_message', {
          conversation_id: CID,
          message: mine({ id: 3, body: 'Hi', client_message_id: 'client-1' }),
        });
      });
      expect(store().threads[CID].messages.map((message) => message.id)).toEqual([1, 2, 3]);
      await act(async () => sent.reject(networkError()));
      // The failure can't resurrect the pending copy
      expect(store().threads[CID].messages.map((message) => message.id)).toEqual([1, 2, 3]);
    });

    it('marks a send that gets no answer as failed, and still takes a late success', async () => {
      await openWith();
      const sent = deferred<{ success: boolean; message: ReturnType<typeof mine> }>();
      api.send.mockReturnValueOnce(sent.promise);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      act(() => store().sendMessage(CID, 'Hi', { meId: ME.id }));
      act(() => vi.advanceTimersByTime(SEND_TIMEOUT_MS));
      vi.useRealTimers();
      expect(store().threads[CID].messages.at(-1)!.send_status).toBe('failed');
      expect(gl.warn).toHaveBeenCalledWith('chat_message_send_timeout', expect.anything());

      // The user retries; the first request then answers after all
      const retried = deferred<never>();
      api.send.mockReturnValueOnce(retried.promise);
      act(() => store().retryMessage(CID, 'client-1'));
      expect(api.send).toHaveBeenCalledTimes(2);
      await act(async () =>
        sent.resolve({
          success: true,
          message: mine({ id: 3, body: 'Hi', client_message_id: 'client-1' }),
        })
      );
      await act(async () => retried.reject(new TypeError('Failed to fetch')));
      const last = store().threads[CID].messages.at(-1)!;
      expect(last.id).toBe(3);
      expect(last.send_status).toBeUndefined();
    });

    it('discards a failed message', async () => {
      await openWith();
      act(() => store().sendMessage(CID, 'Hi', { meId: ME.id, offline: true }));
      act(() => store().discardMessage(CID, 'client-1'));
      expect(store().threads[CID].messages.map((message) => message.id)).toEqual([1, 2]);
    });

    it('sends to a conversation that is not loaded yet', async () => {
      api.send.mockResolvedValueOnce({
        success: true,
        message: mine({ id: 3, client_message_id: 'client-1' }),
      });
      await act(async () => store().sendMessage(CID, 'Hi', { meId: ME.id }));
      expect(store().threads[CID].messages.map((message) => message.id)).toEqual([3]);
    });
  });

  describe('unsending', () => {
    it('replaces the message with its deleted form', async () => {
      await openWith([makeChatMessage({ id: 1 }), mine({ id: 2 })]);
      api.unsend.mockResolvedValueOnce({
        success: true,
        message: mine({ id: 2, is_deleted: true, body: '' }),
      });
      await act(() => store().unsendMessage(CID, 2));
      expect(store().threads[CID].messages[1]).toMatchObject({ is_deleted: true, body: '' });
      expect(store().conversations[CID].last_message?.is_deleted).toBe(true);
      expect(gl.info).toHaveBeenCalledWith('chat_message_unsent', expect.anything());
    });

    it('falls back to the held copy when the response is malformed', async () => {
      await openWith();
      api.unsend.mockResolvedValueOnce({ success: true } as never);
      await act(() => store().unsendMessage(CID, 2));
      expect(store().threads[CID].messages[1]).toMatchObject({ id: 2, is_deleted: true });
      api.unsend.mockResolvedValueOnce({ success: true } as never);
      await act(() => store().unsendMessage(CID, 404));
    });

    it('rethrows failures', async () => {
      await openWith();
      const failure = new ApiError('no', 403, 'MESSAGE_FORBIDDEN');
      api.unsend.mockRejectedValueOnce(failure);
      await expect(store().unsendMessage(CID, 1)).rejects.toBe(failure);
    });
  });

  describe('reactions', () => {
    it('applies my reaction at once and then the server’s list', async () => {
      await openWith([makeChatMessage({ id: 1, reactions: [reaction(PEER.id, '😂')] })]);
      const done = deferred<{ success: boolean; message_id: number; reactions: never[] }>();
      api.react.mockReturnValueOnce(done.promise as never);
      const pending = store().setReaction(CID, 1, '❤️', ME.id);
      expect(store().threads[CID].messages[0].reactions).toEqual([
        reaction(PEER.id, '😂'),
        reaction(ME.id, '❤️'),
      ]);
      await act(async () => {
        done.resolve({
          success: true,
          message_id: 1,
          reactions: [reaction(PEER.id, '😂'), reaction(ME.id, '❤️')] as never[],
        });
        await pending;
      });
      expect(api.react).toHaveBeenCalledWith(CID, 1, '❤️');
      expect(gl.info).toHaveBeenCalledWith('chat_reaction_set', expect.anything());
    });

    it('removes my reaction', async () => {
      await openWith([makeChatMessage({ id: 1, reactions: [reaction(ME.id, '❤️')] })]);
      api.unreact.mockResolvedValueOnce({ success: true, message_id: 1, reactions: [] });
      await act(() => store().setReaction(CID, 1, null, ME.id));
      expect(api.unreact).toHaveBeenCalledWith(CID, 1);
      expect(store().threads[CID].messages[0].reactions).toEqual([]);
    });

    it('rolls back and rethrows when it fails', async () => {
      const before = [reaction(PEER.id, '😂')];
      await openWith([makeChatMessage({ id: 1, reactions: before })]);
      api.react.mockRejectedValueOnce(networkError());
      await expect(act(() => store().setReaction(CID, 1, '👍', ME.id))).rejects.toThrow();
      expect(store().threads[CID].messages[0].reactions).toEqual(before);
    });

    it('lets only the latest of quick changes decide', async () => {
      await openWith([makeChatMessage({ id: 1 })]);
      const first = deferred<never>();
      api.react.mockReturnValueOnce(first.promise);
      api.unreact.mockResolvedValueOnce({ success: true, message_id: 1, reactions: [] });
      const a = store().setReaction(CID, 1, '❤️', ME.id);
      // A real-time update for the message is ignored while mine is in flight
      act(() => {
        store().handleSocketEvent('chat_reaction', {
          conversation_id: CID,
          message_id: 1,
          reactions: [reaction(PEER.id, '😮')],
        });
      });
      await act(() => store().setReaction(CID, 1, null, ME.id));
      await act(async () => {
        first.reject(networkError());
        await a;
      });
      expect(store().threads[CID].messages[0].reactions).toEqual([]);
    });

    it('ignores a superseded success', async () => {
      await openWith([makeChatMessage({ id: 1 })]);
      const first = deferred<{ success: boolean; message_id: number; reactions: never[] }>();
      api.react.mockReturnValueOnce(first.promise as never);
      api.react.mockResolvedValueOnce({
        success: true,
        message_id: 1,
        reactions: [reaction(ME.id, '😂')],
      });
      const a = store().setReaction(CID, 1, '❤️', ME.id);
      await act(() => store().setReaction(CID, 1, '😂', ME.id));
      await act(async () => {
        first.resolve({ success: true, message_id: 1, reactions: [] });
        await a;
      });
      expect(store().threads[CID].messages[0].reactions).toEqual([reaction(ME.id, '😂')]);
    });

    it('skips deleted, pending or unknown messages', async () => {
      await openWith([makeChatMessage({ id: 1, is_deleted: true })]);
      await store().setReaction(CID, 1, '❤️', ME.id);
      await store().setReaction(CID, 99, '❤️', ME.id);
      await store().setReaction(55, 1, '❤️', ME.id);
      expect(api.react).not.toHaveBeenCalled();
    });
  });

  describe('read and delivered receipts', () => {
    it('marks read once per newer message and forgets failures', async () => {
      await openWith(
        [makeChatMessage({ id: 1 }), makeChatMessage({ id: 2 })],
        makeConversation({
          last_message: makeChatMessage({ id: 2 }),
          unread_count: 2,
          my_last_read_message_id: 0,
        })
      );
      act(() => store().markRead(CID, 1));
      expect(store().conversations[CID]).toMatchObject({
        my_last_read_message_id: 1,
        unread_count: 1,
      });
      act(() => store().markRead(CID, 1));
      expect(api.markRead).toHaveBeenCalledTimes(1);

      api.markRead.mockRejectedValueOnce(networkError());
      act(() => store().markRead(CID, 2));
      expect(store().conversations[CID].unread_count).toBe(0);
      await flush();
      expect(gl.warn).toHaveBeenCalledWith('chat_mark_read_failed', expect.anything());
      // Undone, since the server still counts the message as unread
      expect(store().conversations[CID]).toMatchObject({
        my_last_read_message_id: 1,
        unread_count: 1,
      });
      // Sent again next time
      act(() => store().markRead(CID, 2));
      expect(api.markRead).toHaveBeenCalledTimes(3);
    });

    it('marks read for a conversation that is not loaded', () => {
      store().markRead(55, 3);
      expect(api.markRead).toHaveBeenCalledWith(55, 3);
    });

    it('marks delivered once per newer message and forgets failures', async () => {
      store().markDelivered(CID, 3);
      store().markDelivered(CID, 2);
      expect(api.markDelivered).toHaveBeenCalledTimes(1);
      api.markDelivered.mockRejectedValueOnce(networkError());
      store().markDelivered(CID, 4);
      await flush();
      store().markDelivered(CID, 4);
      expect(api.markDelivered).toHaveBeenCalledTimes(3);
    });

    it('sends typing signals and swallows their failures', async () => {
      api.typing.mockRejectedValueOnce(new ApiError('slow down', 429, 'RATE_LIMIT_EXCEEDED'));
      store().sendTyping(CID, true);
      await flush();
      expect(api.typing).toHaveBeenCalledWith(CID, true);
      expect(gl.debug).toHaveBeenCalledWith('chat_typing_failed', {
        metadata: { conversationId: CID, errorCode: 'RATE_LIMIT_EXCEEDED' },
      });
    });
  });

  describe('real-time events', () => {
    const event = (type: string, payload: unknown) => {
      let handled = false;
      act(() => {
        handled = store().handleSocketEvent(type, payload);
      });
      return handled;
    };

    it('ignores other event types', () => {
      expect(event('notification', {})).toBe(false);
    });

    it('logs and rejects malformed payloads', () => {
      expect(event('chat_message', { message: { id: 'x' } })).toBe(false);
      expect(event('chat_message_deleted', null)).toBe(false);
      expect(event('chat_reaction', { conversation_id: 1, message_id: 2, reactions: 'x' })).toBe(
        false
      );
      expect(event('chat_receipt', { conversation_id: 1 })).toBe(false);
      expect(event('chat_typing', { conversation_id: 1 })).toBe(false);
      expect(gl.warn).toHaveBeenCalledWith(
        'chat_ws_event_failed',
        expect.objectContaining({
          metadata: expect.objectContaining({ type: 'chat_typing', recovery: 'ignore_event' }),
        })
      );
    });

    describe('chat_message', () => {
      it('adds a peer message to the open, visible conversation without counting it', async () => {
        await openWith();
        expect(
          event('chat_message', { conversation_id: CID, message: makeChatMessage({ id: 3 }) })
        ).toBe(true);
        expect(store().threads[CID].messages.map((message) => message.id)).toEqual([1, 2, 3]);
        expect(store().conversations[CID].unread_count).toBe(0);
        expect(api.markDelivered).not.toHaveBeenCalled();
      });

      it('counts it and confirms delivery when the conversation is not on screen', async () => {
        await openWith();
        store().closeConversation(CID);
        event('chat_message', { conversation_id: CID, message: makeChatMessage({ id: 3 }) });
        expect(store().conversations[CID].unread_count).toBe(1);
        expect(store()).toMatchObject({ unreadConversations: 1, unreadMessages: 1 });
        expect(api.markDelivered).toHaveBeenCalledWith(CID, 3);
      });

      it('confirms delivery while the page is hidden', async () => {
        await openWith();
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        event('chat_message', { conversation_id: CID, message: makeChatMessage({ id: 3 }) });
        expect(api.markDelivered).toHaveBeenCalledWith(CID, 3);
        visibility.mockRestore();
      });

      it('clears the peer’s typing indicator', async () => {
        await openWith();
        event('chat_typing', { conversation_id: CID, user_id: PEER.id, is_typing: true });
        event('chat_message', { conversation_id: CID, message: makeChatMessage({ id: 3 }) });
        expect(store().typing[CID]).toBeUndefined();
      });

      it('applies my own message from another device', async () => {
        await openWith();
        event('chat_message', { conversation_id: CID, message: mine({ id: 3 }) });
        expect(store().conversations[CID]).toMatchObject({
          my_last_read_message_id: 3,
          last_message: { id: 3 },
        });
      });

      it('loads a conversation it does not know yet', async () => {
        const conversation = makeConversation({ id: 42 });
        api.get.mockResolvedValueOnce({ success: true, conversation });
        event('chat_message', {
          conversation_id: 42,
          message: makeChatMessage({ id: 9, conversation_id: 42 }),
        });
        await flush();
        expect(api.get).toHaveBeenCalledWith(42);
        expect(api.unreadCount).toHaveBeenCalled();
        expect(api.markDelivered).toHaveBeenCalledWith(42, 9);
        expect(store().conversations[42]).toEqual(conversation);
        // The thread isn't loaded, so the message waits for it
        expect(store().threads[42]).toBeUndefined();
      });
    });

    it('applies an unsent message', async () => {
      await openWith(
        [makeChatMessage({ id: 1 }), makeChatMessage({ id: 2 })],
        makeConversation({
          last_message: makeChatMessage({ id: 2 }),
          unread_count: 1,
          my_last_read_message_id: 1,
        })
      );
      event('chat_message_deleted', {
        conversation_id: CID,
        message: makeChatMessage({ id: 2, body: 'still here' }),
      });
      expect(store().threads[CID].messages[1]).toMatchObject({ is_deleted: true, body: '' });
      expect(store().conversations[CID].unread_count).toBe(0);
      // Unknown conversations are ignored
      expect(
        event('chat_message_deleted', {
          conversation_id: 77,
          message: makeChatMessage({ id: 3, conversation_id: 77 }),
        })
      ).toBe(true);
    });

    it('applies reactions', async () => {
      await openWith();
      event('chat_reaction', {
        conversation_id: CID,
        message_id: 1,
        reactions: [reaction(PEER.id, '🙏')],
      });
      expect(store().threads[CID].messages[0].reactions).toEqual([reaction(PEER.id, '🙏')]);
      expect(event('chat_reaction', { conversation_id: 77, message_id: 1, reactions: [] })).toBe(
        true
      );
    });

    it('applies receipts and refreshes the totals for unknown conversations', async () => {
      await openWith();
      event('chat_receipt', {
        conversation_id: CID,
        user_id: PEER.id,
        last_read_message_id: 2,
        last_delivered_message_id: 2,
      });
      expect(store().conversations[CID].peer_last_read_message_id).toBe(2);
      event('chat_receipt', {
        conversation_id: 77,
        user_id: ME.id,
        last_read_message_id: 2,
        last_delivered_message_id: 2,
      });
      expect(api.unreadCount).toHaveBeenCalled();
    });

    it('shows the peer typing until it stops or expires', () => {
      vi.useFakeTimers();
      event('chat_typing', { conversation_id: CID, user_id: PEER.id, is_typing: true });
      expect(store().typing[CID]).toBe(true);
      act(() => vi.advanceTimersByTime(TYPING_EXPIRY_MS - 1));
      // A refresh restarts the countdown
      event('chat_typing', { conversation_id: CID, user_id: PEER.id, is_typing: true });
      act(() => vi.advanceTimersByTime(TYPING_EXPIRY_MS - 1));
      expect(store().typing[CID]).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(store().typing[CID]).toBeUndefined();

      event('chat_typing', { conversation_id: CID, user_id: PEER.id, is_typing: true });
      event('chat_typing', { conversation_id: CID, user_id: PEER.id, is_typing: false });
      expect(store().typing[CID]).toBeUndefined();
      event('chat_typing', { conversation_id: CID, user_id: PEER.id, is_typing: false });
      vi.useRealTimers();
    });
  });

  describe('after the WebSocket (re)connects', () => {
    it('refreshes the totals, the open conversation and a loaded inbox', async () => {
      await openWith();
      await act(() => store().fetchInbox());
      api.list.mockClear();
      api.messages.mockClear();
      act(() => store().onSocketConnected());
      await flush();
      expect(api.unreadCount).toHaveBeenCalled();
      expect(api.messages).toHaveBeenCalledWith(CID, { after: 2, limit: 100 });
      expect(api.list).toHaveBeenCalled();
    });

    it('only refreshes the totals when nothing else is shown', async () => {
      act(() => store().onSocketConnected());
      await flush();
      expect(api.unreadCount).toHaveBeenCalled();
      expect(api.messages).not.toHaveBeenCalled();
      expect(api.list).not.toHaveBeenCalled();
    });
  });

  it('reset forgets everything, including typing timers', () => {
    vi.useFakeTimers();
    act(() => {
      store().handleSocketEvent('chat_typing', {
        conversation_id: CID,
        user_id: PEER.id,
        is_typing: true,
      });
    });
    store().reset();
    expect(store().typing).toEqual({});
    vi.advanceTimersByTime(TYPING_EXPIRY_MS);
    expect(store().typing).toEqual({});
    vi.useRealTimers();
  });
});
