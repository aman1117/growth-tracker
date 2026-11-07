import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../services/api';
import {
  at,
  CHAT_NOW,
  makeChatMessage,
  makeConversation,
  ME,
  mine,
  PEER,
  reaction,
} from '../test/fixtures/chat';
import type { ChatThreadMessage } from '../types/chat';
import {
  applyDeletedMessage,
  applyIncomingMessage,
  applyLocalRead,
  applyReactions,
  applyReceipt,
  buildThreadItems,
  calendarDaysAgo,
  CHAT_NOT_ALLOWED_MESSAGE,
  compareConversations,
  compareMessages,
  formatDayLabel,
  formatInboxTime,
  generateClientMessageId,
  getChatErrorMessage,
  getConversationPreview,
  getDayKey,
  getMessageKey,
  getMyReaction,
  getNewestConfirmedId,
  getOldestConfirmedId,
  getQuoteText,
  getTickStatus,
  isConversationNotFound,
  isEmojiOnly,
  isNearBottom,
  isPeerMessage,
  isPendingMessage,
  isRetryableError,
  isValidReceipt,
  mergeConversation,
  mergeMessages,
  parseChatMessage,
  summarizeReactions,
  toSingleLine,
  withMyReaction,
} from './chat';

const pending = (seq: number, clientId: string, overrides: Partial<ChatThreadMessage> = {}) =>
  mine({ id: -seq, client_message_id: clientId, send_status: 'pending', ...overrides });

const ids = (messages: ChatThreadMessage[]) => messages.map((message) => message.id);

describe('message identity and order', () => {
  it('treats negative ids and messages with a send status as pending', () => {
    expect(isPendingMessage(mine({ id: -1 }))).toBe(true);
    expect(isPendingMessage(mine({ id: 3, send_status: 'failed' }))).toBe(true);
    expect(isPendingMessage(mine({ id: 3 }))).toBe(false);
  });

  it('keys messages by their client id so the key survives confirmation', () => {
    expect(getMessageKey(mine({ id: -1, client_message_id: 'abc' }))).toBe('c:abc');
    expect(getMessageKey(mine({ id: 9, client_message_id: 'abc' }))).toBe('c:abc');
    expect(getMessageKey(mine({ id: 9 }))).toBe('m:9');
  });

  it('sorts confirmed messages by id, then pending ones in the order they were written', () => {
    const sorted = [pending(2, 'b'), makeChatMessage({ id: 7 }), pending(1, 'a'), mine({ id: 3 })]
      .slice()
      .sort(compareMessages);
    expect(ids(sorted)).toEqual([3, 7, -1, -2]);
  });

  it('finds the newest and oldest confirmed messages', () => {
    const list = [makeChatMessage({ id: 3 }), makeChatMessage({ id: 8 }), pending(1, 'a')];
    expect(getNewestConfirmedId(list)).toBe(8);
    expect(getOldestConfirmedId(list)).toBe(3);
    expect(getNewestConfirmedId([pending(1, 'a')])).toBeNull();
    expect(getOldestConfirmedId([])).toBeNull();
  });

  it('knows whether the peer wrote a message', () => {
    expect(isPeerMessage(makeChatMessage(), PEER.id)).toBe(true);
    expect(isPeerMessage(mine(), PEER.id)).toBe(false);
    expect(isPeerMessage(pending(1, 'a', { sender_id: PEER.id }), PEER.id)).toBe(false);
  });
});

describe('mergeMessages', () => {
  it('dedupes by id and sorts', () => {
    const merged = mergeMessages(
      [makeChatMessage({ id: 2 }), makeChatMessage({ id: 1 })],
      [makeChatMessage({ id: 2, body: 'edited copy' }), makeChatMessage({ id: 3 })]
    );
    expect(ids(merged)).toEqual([1, 2, 3]);
    expect(merged[1].body).toBe('edited copy');
  });

  it('replaces a pending message once the server copy with the same client id arrives', () => {
    const merged = mergeMessages(
      [makeChatMessage({ id: 1 }), pending(1, 'abc')],
      [mine({ id: 2, client_message_id: 'abc' })]
    );
    expect(ids(merged)).toEqual([1, 2]);
    expect(merged[1].send_status).toBeUndefined();
  });

  it('drops a pending message whose confirmed copy is already in the thread (WS echo first)', () => {
    const merged = mergeMessages([mine({ id: 2, client_message_id: 'abc' })], [pending(1, 'abc')]);
    expect(ids(merged)).toEqual([2]);
  });

  it('updates a pending message in place (e.g. marked failed)', () => {
    const merged = mergeMessages(
      [pending(1, 'abc')],
      [pending(1, 'abc', { send_status: 'failed' })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].send_status).toBe('failed');
  });

  it('keeps pending messages without a client id apart', () => {
    const merged = mergeMessages(
      [mine({ id: -1, client_message_id: null, send_status: 'pending' })],
      [mine({ id: -2, client_message_id: null, send_status: 'pending' })]
    );
    expect(ids(merged)).toEqual([-1, -2]);
  });

  it('never brings a deleted message back from a stale copy', () => {
    const deleted = makeChatMessage({ id: 4, is_deleted: true, body: '' });
    const merged = mergeMessages([deleted], [makeChatMessage({ id: 4, body: 'old' })]);
    expect(merged[0]).toBe(deleted);
  });

  it('marks quotes of deleted messages as deleted', () => {
    const reply = mine({
      id: 6,
      reply_to: { id: 4, sender_id: PEER.id, body: 'original', is_deleted: false },
    });
    const merged = mergeMessages([reply], [makeChatMessage({ id: 4, is_deleted: true, body: '' })]);
    expect(merged[1].reply_to).toEqual({ id: 4, sender_id: PEER.id, body: '', is_deleted: true });
  });
});

describe('reactions', () => {
  it('replaces the reactions of one message', () => {
    const list = [makeChatMessage({ id: 1 }), makeChatMessage({ id: 2 })];
    const next = applyReactions(list, 2, [reaction(ME.id, '😂')]);
    expect(next[0]).toBe(list[0]);
    expect(next[1].reactions).toEqual([reaction(ME.id, '😂')]);
  });

  it('sets, replaces and removes my reaction, keeping everyone else’s', () => {
    const others = [reaction(PEER.id, '❤️')];
    expect(withMyReaction(others, ME.id, '👍')).toEqual([...others, reaction(ME.id, '👍')]);
    expect(withMyReaction([reaction(ME.id, '👍'), ...others], ME.id, '😮')).toEqual([
      ...others,
      reaction(ME.id, '😮'),
    ]);
    expect(withMyReaction([reaction(ME.id, '👍'), ...others], ME.id, null)).toEqual(others);
  });

  it('finds my reaction', () => {
    expect(getMyReaction([reaction(PEER.id, '❤️'), reaction(ME.id, '😂')], ME.id)).toBe('😂');
    expect(getMyReaction([reaction(PEER.id, '❤️')], ME.id)).toBeNull();
  });

  it('groups reactions by emoji in order of first use', () => {
    expect(
      summarizeReactions([reaction(PEER.id, '❤️'), reaction(ME.id, '😂'), reaction(3, '❤️')], ME.id)
    ).toEqual([
      { emoji: '❤️', count: 2, userIds: [PEER.id, 3], mine: false },
      { emoji: '😂', count: 1, userIds: [ME.id], mine: true },
    ]);
  });
});

describe('getTickStatus', () => {
  const conversation = makeConversation({
    peer_last_delivered_message_id: 8,
    peer_last_read_message_id: 5,
  });

  it.each([
    [mine({ id: 4 }), 'read'],
    [mine({ id: 5 }), 'read'],
    [mine({ id: 7 }), 'delivered'],
    [mine({ id: 9 }), 'sent'],
    [pending(1, 'a'), 'pending'],
    [pending(1, 'a', { send_status: 'failed' }), 'failed'],
    [mine({ id: -3 }), 'pending'],
  ] as const)('%#: %s', (message, status) => {
    expect(getTickStatus(message, conversation)).toBe(status);
  });

  it('counts read messages as delivered even when the delivered pointer lags', () => {
    expect(
      getTickStatus(
        mine({ id: 6 }),
        makeConversation({ peer_last_delivered_message_id: 2, peer_last_read_message_id: 8 })
      )
    ).toBe('read');
  });

  it('shows "sent" without a conversation', () => {
    expect(getTickStatus(mine({ id: 3 }), null)).toBe('sent');
  });
});

describe('applyReceipt', () => {
  const conversation = makeConversation({
    last_message: makeChatMessage({ id: 9 }),
    unread_count: 3,
    my_last_read_message_id: 4,
    peer_last_read_message_id: 5,
    peer_last_delivered_message_id: 6,
  });
  const receipt = (user_id: number, read: number, delivered: number) => ({
    conversation_id: conversation.id,
    user_id,
    last_read_message_id: read,
    last_delivered_message_id: delivered,
  });

  it('moves the peer’s pointers forward', () => {
    expect(applyReceipt(conversation, receipt(PEER.id, 7, 8))).toMatchObject({
      peer_last_read_message_id: 7,
      peer_last_delivered_message_id: 8,
    });
  });

  it('never moves pointers back (out-of-order receipts)', () => {
    expect(applyReceipt(conversation, receipt(PEER.id, 2, 3))).toBe(conversation);
  });

  it('treats a read pointer as delivered too', () => {
    expect(applyReceipt(conversation, receipt(PEER.id, 8, 0))).toMatchObject({
      peer_last_read_message_id: 8,
      peer_last_delivered_message_id: 8,
    });
  });

  it('syncs my read pointer from another device and clears unread at the newest message', () => {
    expect(applyReceipt(conversation, receipt(ME.id, 9, 9))).toMatchObject({
      my_last_read_message_id: 9,
      unread_count: 0,
    });
    expect(applyReceipt(conversation, receipt(ME.id, 6, 6))).toMatchObject({
      my_last_read_message_id: 6,
      unread_count: 3,
    });
    expect(applyReceipt(conversation, receipt(ME.id, 1, 1))).toBe(conversation);
  });

  it('handles a conversation without messages', () => {
    const empty = makeConversation({ last_message: null, my_last_read_message_id: 0 });
    expect(applyReceipt(empty, receipt(ME.id, 1, 1)).unread_count).toBe(0);
  });
});

describe('applyIncomingMessage', () => {
  const conversation = makeConversation({
    last_message: makeChatMessage({ id: 5, created_at: at(10, 5) }),
    updated_at: at(10, 5),
    unread_count: 1,
    my_last_read_message_id: 4,
  });

  it('counts a new peer message as unread and makes it the last message', () => {
    const message = makeChatMessage({ id: 6, created_at: at(11) });
    expect(applyIncomingMessage(conversation, message, true)).toMatchObject({
      last_message: message,
      updated_at: at(11),
      unread_count: 2,
    });
  });

  it('does not count it while the user is looking at the conversation', () => {
    expect(applyIncomingMessage(conversation, makeChatMessage({ id: 6 }), false).unread_count).toBe(
      1
    );
  });

  it('ignores a message it already has for the count, and older ones for the preview', () => {
    const again = applyIncomingMessage(conversation, makeChatMessage({ id: 5 }), true);
    expect(again.unread_count).toBe(1);
    const older = makeChatMessage({ id: 3, created_at: at(9) });
    const result = applyIncomingMessage(conversation, older, true);
    expect(result.last_message?.id).toBe(5);
    expect(result.updated_at).toBe(at(10, 5));
    expect(result.unread_count).toBe(1);
  });

  it('does not count deleted or already-read messages', () => {
    expect(
      applyIncomingMessage(conversation, makeChatMessage({ id: 6, is_deleted: true }), true)
        .unread_count
    ).toBe(1);
    expect(
      applyIncomingMessage(
        { ...conversation, my_last_read_message_id: 8 },
        makeChatMessage({ id: 6 }),
        true
      ).unread_count
    ).toBe(1);
  });

  it('keeps the newer activity time when a message carries an older timestamp', () => {
    const message = makeChatMessage({ id: 6, created_at: at(9) });
    expect(applyIncomingMessage(conversation, message, true).updated_at).toBe(at(10, 5));
  });

  it('marks the conversation read when I sent the message', () => {
    expect(applyIncomingMessage(conversation, mine({ id: 7 }), true)).toMatchObject({
      my_last_read_message_id: 7,
      unread_count: 0,
    });
  });

  it('works for a conversation without messages', () => {
    const empty = makeConversation({ last_message: null, unread_count: 0 });
    expect(applyIncomingMessage(empty, makeChatMessage({ id: 1 }), true).unread_count).toBe(0);
    expect(
      applyIncomingMessage(
        { ...empty, my_last_read_message_id: 0 },
        makeChatMessage({ id: 1 }),
        true
      ).unread_count
    ).toBe(1);
  });
});

describe('applyDeletedMessage', () => {
  const last = makeChatMessage({ id: 6 });
  const conversation = makeConversation({
    last_message: last,
    unread_count: 2,
    my_last_read_message_id: 4,
  });

  it('updates the preview and the unread count for an unread peer message', () => {
    const deleted = { ...last, is_deleted: true, body: '' };
    expect(applyDeletedMessage(conversation, deleted)).toMatchObject({
      last_message: deleted,
      unread_count: 1,
    });
  });

  it('only updates the count for an older unread message', () => {
    const result = applyDeletedMessage(conversation, makeChatMessage({ id: 5, is_deleted: true }));
    expect(result.last_message).toBe(last);
    expect(result.unread_count).toBe(1);
  });

  it('only updates the preview for my own message', () => {
    const deleted = mine({ id: 6, is_deleted: true });
    expect(applyDeletedMessage(conversation, deleted).unread_count).toBe(2);
  });

  it('changes nothing for an old, read message', () => {
    expect(applyDeletedMessage(conversation, makeChatMessage({ id: 2, is_deleted: true }))).toBe(
      conversation
    );
  });
});

describe('applyLocalRead', () => {
  const conversation = makeConversation({
    last_message: makeChatMessage({ id: 9 }),
    unread_count: 4,
    my_last_read_message_id: 4,
  });
  const loaded = [
    makeChatMessage({ id: 5 }),
    makeChatMessage({ id: 6, is_deleted: true }),
    mine({ id: 7 }),
    makeChatMessage({ id: 8 }),
    makeChatMessage({ id: 9 }),
  ];

  it('clears unread when reading up to the newest message', () => {
    expect(applyLocalRead(conversation, 9, loaded)).toMatchObject({
      my_last_read_message_id: 9,
      unread_count: 0,
    });
  });

  it('counts the loaded peer messages still unread', () => {
    expect(applyLocalRead(conversation, 5, loaded).unread_count).toBe(2);
  });

  it('never moves the pointer back', () => {
    expect(applyLocalRead(conversation, 3, loaded)).toBe(conversation);
  });

  it('handles a conversation without messages', () => {
    const empty = makeConversation({ last_message: null, my_last_read_message_id: 0 });
    expect(applyLocalRead(empty, 2, []).unread_count).toBe(0);
  });
});

describe('mergeConversation', () => {
  const base = makeConversation({
    last_message: makeChatMessage({ id: 5 }),
    unread_count: 1,
    my_last_read_message_id: 4,
    peer_last_read_message_id: 3,
    peer_last_delivered_message_id: 4,
    updated_at: at(10, 5),
  });

  it('takes the incoming copy when nothing is held', () => {
    expect(mergeConversation(undefined, base)).toBe(base);
  });

  it('keeps pointers moving forward and the newest last message', () => {
    const fresher = {
      ...base,
      last_message: makeChatMessage({ id: 7 }),
      unread_count: 3,
      peer_last_read_message_id: 6,
      peer_last_delivered_message_id: 6,
      updated_at: at(12),
    };
    const merged = mergeConversation(fresher, { ...base, can_message: false });
    expect(merged).toMatchObject({
      last_message: { id: 7 },
      unread_count: 3,
      peer_last_read_message_id: 6,
      peer_last_delivered_message_id: 6,
      updated_at: at(12),
      can_message: false,
    });
  });

  it('takes newer server data', () => {
    const incoming = {
      ...base,
      last_message: makeChatMessage({ id: 8 }),
      unread_count: 2,
      updated_at: at(13),
    };
    expect(mergeConversation(base, incoming)).toMatchObject({
      last_message: { id: 8 },
      unread_count: 2,
      updated_at: at(13),
    });
  });

  it('keeps a deletion of the last message', () => {
    const deleted = { ...base, last_message: makeChatMessage({ id: 5, is_deleted: true }) };
    expect(mergeConversation(deleted, base).last_message?.is_deleted).toBe(true);
  });

  it('keeps a held last message when the server copy has none', () => {
    expect(mergeConversation(base, { ...base, last_message: null }).last_message?.id).toBe(5);
  });

  it('clears unread once my pointer reaches the last message', () => {
    expect(
      mergeConversation({ ...base, my_last_read_message_id: 5 }, { ...base, unread_count: 1 })
        .unread_count
    ).toBe(0);
  });

  it('handles conversations without messages', () => {
    const empty = { ...base, last_message: null, my_last_read_message_id: 0 };
    expect(mergeConversation(empty, empty).unread_count).toBe(0);
  });
});

describe('inbox order and previews', () => {
  it('orders by latest activity, then by id', () => {
    const a = makeConversation({ id: 1, updated_at: at(9) });
    const b = makeConversation({ id: 2, updated_at: at(11) });
    const c = makeConversation({ id: 3, updated_at: at(9) });
    expect([a, b, c].sort(compareConversations).map((conversation) => conversation.id)).toEqual([
      2, 3, 1,
    ]);
  });

  it('previews the peer’s last message on one line', () => {
    const conversation = makeConversation({
      last_message: makeChatMessage({ body: 'Hi\n\nthere  you' }),
    });
    expect(getConversationPreview(conversation)).toEqual({
      text: 'Hi there you',
      isMine: false,
      isDeleted: false,
    });
  });

  it('marks my last message and deleted ones', () => {
    expect(
      getConversationPreview(makeConversation({ last_message: mine({ body: 'Sure' }) }))
    ).toEqual({ text: 'Sure', isMine: true, isDeleted: false });
    expect(
      getConversationPreview(
        makeConversation({ last_message: makeChatMessage({ is_deleted: true, body: '' }) })
      )
    ).toEqual({ text: 'This message was deleted', isMine: false, isDeleted: true });
  });

  it('invites to say hi when there is no message', () => {
    expect(getConversationPreview(makeConversation({ last_message: null })).text).toBe('Say hi 👋');
  });

  it('describes quotes', () => {
    expect(getQuoteText({ id: 1, sender_id: 2, body: 'a\nb', is_deleted: false })).toBe('a b');
    expect(getQuoteText({ id: 1, sender_id: 2, body: '', is_deleted: true })).toBe(
      'This message was deleted'
    );
    expect(toSingleLine('  x \t y  ')).toBe('x y');
  });
});

describe('dates', () => {
  it('counts calendar days, not 24-hour periods', () => {
    expect(calendarDaysAgo(new Date(2026, 10, 7, 23, 59), new Date(2026, 10, 8, 0, 1))).toBe(1);
    expect(calendarDaysAgo(new Date(2026, 10, 8, 0, 1), CHAT_NOW)).toBe(0);
  });

  it('keys a timestamp by its local day', () => {
    expect(getDayKey(new Date(2026, 0, 5, 23, 30).toISOString())).toBe('2026-01-05');
  });

  it('formats inbox times like WhatsApp', () => {
    expect(formatInboxTime(at(9, 41), CHAT_NOW)).toBe(
      new Date(at(9, 41)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    );
    expect(formatInboxTime(at(9, 0, 1), CHAT_NOW)).toBe('Yesterday');
    expect(formatInboxTime(at(9, 0, 3), CHAT_NOW)).toBe('Thursday');
    expect(formatInboxTime(at(9, 0, 10), CHAT_NOW)).toBe('Oct 29');
    expect(formatInboxTime(new Date(2025, 5, 1).toISOString(), CHAT_NOW)).toBe('Jun 1, 2025');
    expect(formatInboxTime('not a date', CHAT_NOW)).toBe('');
  });

  it('labels days in the thread', () => {
    expect(formatDayLabel(at(9), CHAT_NOW)).toBe('Today');
    expect(formatDayLabel(at(9, 0, 1), CHAT_NOW)).toBe('Yesterday');
    expect(formatDayLabel(at(9, 0, 2), CHAT_NOW)).toBe('Friday');
    expect(formatDayLabel(at(9, 0, 9), CHAT_NOW)).toBe('Fri, Oct 30');
    expect(formatDayLabel(new Date(2025, 11, 31).toISOString(), CHAT_NOW)).toBe(
      'Wed, Dec 31, 2025'
    );
  });

  it('defaults to the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(CHAT_NOW);
    expect(formatDayLabel(at(8))).toBe('Today');
    expect(formatInboxTime(at(8, 0, 1))).toBe('Yesterday');
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe('buildThreadItems', () => {
  const kinds = (items: ReturnType<typeof buildThreadItems>) =>
    items.map((item) =>
      item.kind === 'message'
        ? `${item.message.id}${item.isMine ? 'm' : 'p'}${item.isFirstInGroup ? '<' : ''}${
            item.isLastInGroup ? '>' : ''
          }`
        : item.kind === 'day'
          ? `[${item.label}]`
          : `(${item.count} unread)`
    );

  it('separates days and groups runs from the same sender', () => {
    const items = buildThreadItems(
      [
        makeChatMessage({ id: 1, created_at: at(9, 0, 1) }),
        makeChatMessage({ id: 2, created_at: at(9, 1, 1) }),
        mine({ id: 3, created_at: at(9, 2, 1) }),
        mine({ id: 4, created_at: at(10, 0) }),
        mine({ id: 5, created_at: at(10, 1) }),
        mine({ id: 6, created_at: at(10, 30) }),
        pending(1, 'a', { created_at: at(10, 31) }),
      ],
      { peerId: PEER.id, now: CHAT_NOW }
    );
    expect(kinds(items)).toEqual([
      '[Yesterday]',
      '1p<',
      '2p>',
      '3m<>',
      '[Today]',
      '4m<',
      '5m>',
      '6m<',
      '-1m>',
    ]);
  });

  it('puts the unread divider before the first unread peer message', () => {
    const items = buildThreadItems(
      [
        makeChatMessage({ id: 1 }),
        mine({ id: 2 }),
        makeChatMessage({ id: 3 }),
        makeChatMessage({ id: 4 }),
      ],
      { peerId: PEER.id, unreadAfterId: 2, now: CHAT_NOW }
    );
    expect(kinds(items)).toEqual(['[Today]', '1p<>', '2m<>', '(2 unread)', '3p<', '4p>']);
  });

  it('shows no divider when nothing is unread', () => {
    const items = buildThreadItems([makeChatMessage({ id: 1 })], {
      peerId: PEER.id,
      unreadAfterId: 1,
      now: CHAT_NOW,
    });
    expect(items.some((item) => item.kind === 'unread')).toBe(false);
  });

  it('lays out an empty thread as nothing', () => {
    expect(buildThreadItems([], { peerId: PEER.id })).toEqual([]);
  });
});

describe('isEmojiOnly', () => {
  it.each([
    ['👍', true],
    ['❤️', true],
    ['😂😂😂', true],
    ['👨‍👩‍👧 🇮🇳', true],
    ['😂😂😂😂', false],
    ['ok 👍', false],
    ['1️⃣', false],
    ['', false],
    ['   ', false],
    ['!!', false],
  ])('%s → %s', (text, expected) => {
    expect(isEmojiOnly(text)).toBe(expected);
  });
});

describe('generateClientMessageId', () => {
  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
    expect(generateClientMessageId()).toBe('uuid-1');
  });

  it('falls back to a random id of at most 64 characters', () => {
    vi.stubGlobal('crypto', {});
    const first = generateClientMessageId();
    const second = generateClientMessageId();
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toMatch(/^[a-z0-9]+-[a-z0-9]{8}-[a-z0-9]{8}-[a-z0-9]{8}$/);
  });
});

describe('real-time payload validation', () => {
  const raw = {
    id: 3,
    conversation_id: 10,
    sender_id: 2,
    body: 'hi',
    client_message_id: 'c1',
    reply_to: { id: 1, sender_id: 1, body: 'q', is_deleted: false },
    reactions: [{ user_id: 1, emoji: '❤️' }],
    is_deleted: false,
    created_at: at(10),
  };

  it('accepts a well-formed message', () => {
    expect(parseChatMessage(raw)).toEqual(raw);
  });

  it('fills in missing optional fields', () => {
    expect(
      parseChatMessage({
        ...raw,
        client_message_id: undefined,
        reply_to: { id: 1 },
        reactions: 'nope',
        is_deleted: 'yes',
      })
    ).toEqual({
      ...raw,
      client_message_id: null,
      reply_to: { id: 1, sender_id: 0, body: '', is_deleted: false },
      reactions: [],
      is_deleted: false,
    });
    expect(parseChatMessage({ ...raw, reply_to: { id: 'x' } })?.reply_to).toBeNull();
  });

  it.each([
    null,
    [],
    'message',
    { ...raw, id: 0 },
    { ...raw, id: 1.5 },
    { ...raw, conversation_id: '10' },
    { ...raw, sender_id: undefined },
    { ...raw, body: 4 },
    { ...raw, created_at: null },
  ])('rejects %j', (value) => {
    expect(parseChatMessage(value)).toBeNull();
  });

  it('validates receipts', () => {
    const receipt = {
      conversation_id: 1,
      user_id: 2,
      last_read_message_id: 0,
      last_delivered_message_id: 4,
    };
    expect(isValidReceipt(receipt)).toBe(true);
    expect(isValidReceipt({ ...receipt, last_read_message_id: -1 })).toBe(false);
    expect(isValidReceipt({ ...receipt, user_id: null })).toBe(false);
    expect(isValidReceipt(null)).toBe(false);
  });
});

describe('errors', () => {
  it('explains known error codes', () => {
    expect(getChatErrorMessage(new ApiError('x', 403, 'CHAT_NOT_ALLOWED'), 'start')).toBe(
      CHAT_NOT_ALLOWED_MESSAGE
    );
    expect(getChatErrorMessage(new ApiError('x', 400, 'MESSAGE_TOO_LONG'), 'send')).toBe(
      'Messages can be up to 4000 characters'
    );
  });

  it('falls back to the action, with a connection hint for network failures', () => {
    expect(getChatErrorMessage(new TypeError('Failed to fetch'), 'send')).toBe(
      "Couldn't send the message. Check your connection and try again."
    );
    expect(getChatErrorMessage(new ApiError('x', 500), 'react')).toBe(
      "Couldn't react to the message. Try again."
    );
    expect(getChatErrorMessage(new ApiError('x', 500, 'SOMETHING_NEW'), 'load')).toBe(
      "Couldn't load messages. Try again."
    );
  });

  it('recognises a missing conversation', () => {
    expect(isConversationNotFound(new ApiError('x', 404))).toBe(true);
    expect(isConversationNotFound(new ApiError('x', 400, 'CONVERSATION_NOT_FOUND'))).toBe(true);
    expect(isConversationNotFound(new ApiError('x', 500))).toBe(false);
  });

  it.each([
    [new TypeError('Failed to fetch'), true],
    [new ApiError('x', 503), true],
    [new ApiError('x', 429), true],
    [new ApiError('x', 408), true],
    [new ApiError('x', 403, 'CHAT_NOT_ALLOWED'), false],
    [new ApiError('x', 400), false],
  ])('retryable %#', (error, expected) => {
    expect(isRetryableError(error)).toBe(expected);
  });
});

describe('isNearBottom', () => {
  it('measures the distance from the bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 }, 400)).toBe(true);
  });
});
