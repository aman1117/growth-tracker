import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { commentApi } from '../services/api';
import { gl } from '../services/goodlogs';
import { type Deferred, deferred, makeComment } from '../test/fixtures/shell';
import type {
  CommentActionResponse,
  CommentLikeResponse,
  CommentsListResponse,
} from '../types/comment';
import { useCommentStore } from './useCommentStore';

vi.mock('../services/api', () => ({
  commentApi: {
    getComments: vi.fn(),
    getReplies: vi.fn(),
    createComment: vi.fn(),
    createReply: vi.fn(),
    deleteComment: vi.fn(),
    editComment: vi.fn(),
    likeComment: vi.fn(),
    unlikeComment: vi.fn(),
    getCommentCount: vi.fn(),
  },
}));

const apiMock = vi.mocked(commentApi);
const store = () => useCommentStore.getState();

const USER = 'alice';
const DATE = '2024-03-01';
const DAY = 'alice:2024-03-01';
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000001';

/** Top-level comment #1 with a two-level thread: #10 replies to #1, #11 replies to #10. */
const thread = () => {
  const root = makeComment({ id: 1, reply_count: 2 });
  const reply = makeComment({ id: 10, parent_comment_id: 1, root_comment_id: 1, reply_count: 1 });
  const nested = makeComment({ id: 11, parent_comment_id: 10, root_comment_id: 1 });
  useCommentStore.setState({
    commentsByDay: { [DAY]: [root] },
    repliesByRoot: { 1: { comments: [reply, nested], hasMore: true, loading: false } },
  });
  return { root, reply, nested };
};

const dayComments = () => store().commentsByDay[DAY];
const replies = (rootId: number) => store().repliesByRoot[rootId]?.comments;

describe('useCommentStore', () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(IDEMPOTENCY_KEY);
  });

  describe('fetchComments', () => {
    it('loads the first page behind a spinner and remembers the sort', async () => {
      const first = makeComment({ id: 1 });
      const second = makeComment({ id: 2 });
      const request = deferred<Awaited<ReturnType<typeof commentApi.getComments>>>();
      apiMock.getComments.mockReturnValue(request.promise);

      const loading = store().fetchComments(USER, DATE);
      expect(store().loading).toBe(true);
      expect(apiMock.getComments).toHaveBeenCalledWith(USER, DATE, 'top', undefined, 20);

      request.resolve({ success: true, comments: [first, second], has_more: true });
      await loading;

      expect(store()).toMatchObject({ hasMore: true, loading: false, sort: 'top' });
      expect(dayComments()).toEqual([first, second]);
    });

    it('appends the next page after the last loaded comment, without a spinner', async () => {
      const loaded = [makeComment({ id: 1 }), makeComment({ id: 2 })];
      useCommentStore.setState({ commentsByDay: { [DAY]: loaded }, hasMore: true });
      const next = makeComment({ id: 3 });
      apiMock.getComments.mockResolvedValue({ success: true, comments: [next], has_more: false });

      const loading = store().fetchComments(USER, DATE);
      expect(store().loading).toBe(false);
      await loading;

      expect(apiMock.getComments).toHaveBeenCalledWith(USER, DATE, 'top', 2, 20);
      expect(dayComments()).toEqual([...loaded, next]);
      expect(store().hasMore).toBe(false);
    });

    it('reloads from the start when reset, using the requested sort', async () => {
      useCommentStore.setState({ commentsByDay: { [DAY]: [makeComment({ id: 1 })] } });
      const newest = makeComment({ id: 9 });
      apiMock.getComments.mockResolvedValue({ success: true, comments: [newest], has_more: false });

      await store().fetchComments(USER, DATE, 'newest', true);

      expect(apiMock.getComments).toHaveBeenCalledWith(USER, DATE, 'newest', undefined, 20);
      expect(dayComments()).toEqual([newest]);
      expect(store().sort).toBe('newest');
    });

    it('uses the current sort when none is given', async () => {
      store().setSort('newest');
      apiMock.getComments.mockResolvedValue({ success: true, comments: [], has_more: false });

      await store().fetchComments(USER, DATE);

      expect(apiMock.getComments).toHaveBeenCalledWith(USER, DATE, 'newest', undefined, 20);
    });

    it('stops the spinner when loading fails', async () => {
      const error = new Error('Network down');
      apiMock.getComments.mockRejectedValue(error);

      await store().fetchComments(USER, DATE);

      expect(store().loading).toBe(false);
      expect(dayComments()).toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] fetchComments failed:', error);
    });

    // Regression: an unsuccessful response used to leave `loading` true, so the spinner never stopped.
    it('stops the spinner when the server refuses to load comments', async () => {
      const request = deferred<CommentsListResponse>();
      apiMock.getComments.mockReturnValue(request.promise);

      const loading = store().fetchComments(USER, DATE);
      expect(store().loading).toBe(true);
      request.resolve({ success: false, comments: [], has_more: false });
      await loading;

      expect(store().loading).toBe(false);
      expect(dayComments()).toBeUndefined();
    });

    it('keeps the loaded comments when the server refuses the next page', async () => {
      const loaded = [makeComment({ id: 1 }), makeComment({ id: 2 })];
      useCommentStore.setState({ commentsByDay: { [DAY]: loaded }, hasMore: true });
      apiMock.getComments.mockResolvedValue({ success: false, comments: [], has_more: false });

      await store().fetchComments(USER, DATE);

      expect(dayComments()).toEqual(loaded);
      expect(store()).toMatchObject({ hasMore: true, loading: false });
    });
  });

  describe('fetchReplies', () => {
    it('loads a thread, flagging it as loading meanwhile', async () => {
      const reply = makeComment({ id: 10, parent_comment_id: 1, root_comment_id: 1 });
      const request = deferred<Awaited<ReturnType<typeof commentApi.getReplies>>>();
      apiMock.getReplies.mockReturnValue(request.promise);

      const loading = store().fetchReplies(1);
      expect(store().repliesByRoot[1]).toEqual({ comments: [], hasMore: true, loading: true });
      expect(apiMock.getReplies).toHaveBeenCalledWith(1, undefined, 20);

      request.resolve({ success: true, comments: [reply], has_more: false });
      await loading;

      expect(store().repliesByRoot[1]).toEqual({
        comments: [reply],
        hasMore: false,
        loading: false,
      });
    });

    it('loads more replies after the last one', async () => {
      const loaded = makeComment({ id: 10 });
      const more = makeComment({ id: 12 });
      useCommentStore.setState({
        repliesByRoot: { 1: { comments: [loaded], hasMore: true, loading: false } },
      });
      apiMock.getReplies.mockResolvedValue({ success: true, comments: [more], has_more: true });

      await store().fetchReplies(1);

      expect(apiMock.getReplies).toHaveBeenCalledWith(1, 10, 20);
      expect(store().repliesByRoot[1]).toEqual({
        comments: [loaded, more],
        hasMore: true,
        loading: false,
      });
    });

    it('replaces the thread when reset', async () => {
      useCommentStore.setState({
        repliesByRoot: {
          1: { comments: [makeComment({ id: 10 })], hasMore: false, loading: false },
        },
      });
      const fresh = makeComment({ id: 13 });
      apiMock.getReplies.mockResolvedValue({ success: true, comments: [fresh], has_more: false });

      const loading = store().fetchReplies(1, true);
      expect(replies(1)).toEqual([]);
      await loading;

      expect(apiMock.getReplies).toHaveBeenCalledWith(1, undefined, 20);
      expect(replies(1)).toEqual([fresh]);
    });

    it('keeps loaded replies when loading more fails', async () => {
      const loaded = makeComment({ id: 10 });
      useCommentStore.setState({
        repliesByRoot: { 1: { comments: [loaded], hasMore: true, loading: false } },
      });
      const error = new Error('Network down');
      apiMock.getReplies.mockRejectedValue(error);

      await store().fetchReplies(1);

      expect(store().repliesByRoot[1]).toEqual({
        comments: [loaded],
        hasMore: true,
        loading: false,
      });
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] fetchReplies failed:', error);
    });

    // Regression: an unsuccessful response used to leave the thread flagged as loading.
    it('stops the thread spinner when the server refuses to load replies', async () => {
      const request = deferred<CommentsListResponse>();
      apiMock.getReplies.mockReturnValue(request.promise);

      const loading = store().fetchReplies(1);
      expect(store().repliesByRoot[1].loading).toBe(true);
      request.resolve({ success: false, comments: [], has_more: false });
      await loading;

      expect(store().repliesByRoot[1]).toEqual({ comments: [], hasMore: true, loading: false });
    });

    it('keeps loaded replies when the server refuses the next page', async () => {
      const loaded = makeComment({ id: 10 });
      useCommentStore.setState({
        repliesByRoot: { 1: { comments: [loaded], hasMore: true, loading: false } },
      });
      apiMock.getReplies.mockResolvedValue({ success: false, comments: [], has_more: false });

      await store().fetchReplies(1);

      expect(store().repliesByRoot[1]).toEqual({
        comments: [loaded],
        hasMore: true,
        loading: false,
      });
    });

    it.each([
      [
        'is refused',
        (request: Deferred<CommentsListResponse>) =>
          request.resolve({ success: false, comments: [], has_more: false }),
      ],
      [
        'fails',
        (request: Deferred<CommentsListResponse>) => request.reject(new Error('Network down')),
      ],
    ])('does not bring back a thread cleared while its request %s', async (_, settle) => {
      const request = deferred<CommentsListResponse>();
      apiMock.getReplies.mockReturnValue(request.promise);

      const loading = store().fetchReplies(1);
      store().clearComments();
      settle(request);
      await loading;

      expect(store().repliesByRoot).toEqual({});
    });
  });

  describe('createComment', () => {
    it('adds the new comment on top, bumps the count and refreshes the preview', async () => {
      const existing = makeComment({ id: 1 });
      useCommentStore.setState({
        commentsByDay: { [DAY]: [existing] },
        counts: { [DAY]: 4 },
        previewsByDay: { [DAY]: [existing] },
      });
      const created = makeComment({ id: 2, body: 'Great day!' });
      apiMock.createComment.mockResolvedValue({ success: true, comment: created });

      await expect(store().createComment(USER, DATE, 'Great day!')).resolves.toBe(created);

      expect(apiMock.createComment).toHaveBeenCalledWith(USER, DATE, 'Great day!', IDEMPOTENCY_KEY);
      expect(dayComments()).toEqual([created, existing]);
      expect(store().counts[DAY]).toBe(5);
      expect(store().previewsByDay[DAY]).toBeUndefined();
      expect(gl.track).toHaveBeenCalledWith('comment_created', {
        properties: { username: USER, date: DATE },
      });
    });

    it('starts the list and count for a day without comments', async () => {
      const created = makeComment({ id: 2 });
      apiMock.createComment.mockResolvedValue({ success: true, comment: created });

      await store().createComment(USER, DATE, 'First!');

      expect(dayComments()).toEqual([created]);
      expect(store().counts[DAY]).toBe(1);
    });

    it('returns null when the server does not return a comment', async () => {
      apiMock.createComment.mockResolvedValueOnce({ success: false });
      await expect(store().createComment(USER, DATE, 'x')).resolves.toBeNull();

      apiMock.createComment.mockResolvedValueOnce({ success: true });
      await expect(store().createComment(USER, DATE, 'x')).resolves.toBeNull();

      expect(dayComments()).toBeUndefined();
      expect(gl.track).not.toHaveBeenCalled();
    });

    it('returns null when the request fails', async () => {
      const error = new Error('Network down');
      apiMock.createComment.mockRejectedValue(error);

      await expect(store().createComment(USER, DATE, 'x')).resolves.toBeNull();
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] createComment failed:', error);
    });
  });

  describe('createReply', () => {
    it('adds a reply to a top-level comment’s thread and bumps the counts', async () => {
      const { root, reply, nested } = thread();
      const other = makeComment({ id: 2, reply_count: 5 });
      useCommentStore.setState({ commentsByDay: { [DAY]: [root, other] }, counts: { [DAY]: 3 } });
      const created = makeComment({ id: 12, parent_comment_id: 1, root_comment_id: 1 });
      apiMock.createReply.mockResolvedValue({ success: true, comment: created });

      await expect(store().createReply(USER, DATE, 1, 'Thanks')).resolves.toBe(created);

      expect(apiMock.createReply).toHaveBeenCalledWith(USER, DATE, 1, 'Thanks', IDEMPOTENCY_KEY);
      expect(store().repliesByRoot[1]).toEqual({
        comments: [reply, nested, created],
        hasMore: true,
        loading: false,
      });
      expect(store().counts[DAY]).toBe(4);
      expect(dayComments()).toEqual([{ ...root, reply_count: 3 }, other]);
      expect(gl.track).toHaveBeenCalledWith('reply_created', {
        properties: { username: USER, date: DATE, commentId: 1 },
      });
    });

    it('files a reply to a reply under the root thread and bumps every ancestor', async () => {
      const { root, reply, nested } = thread();
      const created = makeComment({ id: 12, parent_comment_id: 11, root_comment_id: 1 });
      apiMock.createReply.mockResolvedValue({ success: true, comment: created });

      await store().createReply(USER, DATE, 11, '@bob agreed');

      expect(dayComments()).toEqual([{ ...root, reply_count: 3 }]);
      expect(replies(1)).toEqual([
        { ...reply, reply_count: 2 },
        { ...nested, reply_count: 1 },
        created,
      ]);
    });

    it('uses the root id the server gave the parent comment', async () => {
      const parent = makeComment({ id: 7, root_comment_id: 3 });
      useCommentStore.setState({ commentsByDay: { [DAY]: [parent] } });
      const created = makeComment({ id: 8, parent_comment_id: 7, root_comment_id: 3 });
      apiMock.createReply.mockResolvedValue({ success: true, comment: created });

      await store().createReply(USER, DATE, 7, 'Reply');

      expect(store().repliesByRoot[3]).toEqual({
        comments: [created],
        hasMore: false,
        loading: false,
      });
      expect(dayComments()).toEqual([{ ...parent, reply_count: 1 }]);
    });

    it('treats a loaded reply without a root id as its own thread root', async () => {
      const orphan = makeComment({ id: 20 });
      useCommentStore.setState({
        repliesByRoot: { 5: { comments: [orphan], hasMore: false, loading: false } },
      });
      const created = makeComment({ id: 21, parent_comment_id: 20 });
      apiMock.createReply.mockResolvedValue({ success: true, comment: created });

      await store().createReply(USER, DATE, 20, 'Reply');

      expect(replies(20)).toEqual([created]);
    });

    it('starts a thread for a comment that is not loaded', async () => {
      const created = makeComment({ id: 100, parent_comment_id: 99, root_comment_id: 99 });
      apiMock.createReply.mockResolvedValue({ success: true, comment: created });

      await store().createReply(USER, DATE, 99, 'Reply');

      expect(store().repliesByRoot[99]).toEqual({
        comments: [created],
        hasMore: false,
        loading: false,
      });
      expect(store().counts[DAY]).toBe(1);
      expect(dayComments()).toBeUndefined();
    });

    it('returns null when the reply is not created', async () => {
      thread();
      apiMock.createReply.mockResolvedValueOnce({ success: false });
      await expect(store().createReply(USER, DATE, 1, 'x')).resolves.toBeNull();

      const error = new Error('Network down');
      apiMock.createReply.mockRejectedValueOnce(error);
      await expect(store().createReply(USER, DATE, 1, 'x')).resolves.toBeNull();

      expect(replies(1)).toHaveLength(2);
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] createReply failed:', error);
    });
  });

  describe('deleteComment', () => {
    it('soft-deletes a top-level comment and refreshes the preview', async () => {
      const { root } = thread();
      useCommentStore.setState({ counts: { [DAY]: 3 }, previewsByDay: { [DAY]: [root] } });
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await expect(store().deleteComment(1, DAY)).resolves.toBe(true);

      expect(apiMock.deleteComment).toHaveBeenCalledWith(1);
      expect(dayComments()).toEqual([{ ...root, is_deleted: true, body: '[Deleted]' }]);
      expect(store().previewsByDay[DAY]).toBeUndefined();
      expect(store().counts[DAY]).toBe(2);
      expect(gl.track).toHaveBeenCalledWith('comment_deleted', { properties: { commentId: 1 } });
    });

    it('decrements every ancestor when a leaf reply is deleted', async () => {
      const { root, reply, nested } = thread();
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await store().deleteComment(11, DAY);

      expect(replies(1)).toEqual([
        { ...reply, reply_count: 0 },
        { ...nested, is_deleted: true, body: '[Deleted]' },
      ]);
      expect(dayComments()).toEqual([{ ...root, reply_count: 1 }]);
      expect(store().counts[DAY]).toBe(0);
    });

    it('keeps ancestor counts when the deleted reply still has replies', async () => {
      const { root, reply } = thread();
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await store().deleteComment(10, DAY);

      expect(replies(1)?.[0]).toEqual({ ...reply, is_deleted: true, body: '[Deleted]' });
      expect(dayComments()).toEqual([root]);
    });

    it('decrements ancestors inside a thread whose day list is not loaded', async () => {
      const { reply, nested } = thread();
      useCommentStore.setState({ commentsByDay: {} });
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await store().deleteComment(11, DAY);

      expect(replies(1)).toEqual([
        { ...reply, reply_count: 0 },
        { ...nested, is_deleted: true, body: '[Deleted]' },
      ]);
      expect(dayComments()).toBeUndefined();
    });

    it('handles a leaf reply that is listed with the day’s comments', async () => {
      const root = makeComment({ id: 1, reply_count: 2 });
      const listed = makeComment({ id: 5, parent_comment_id: 1, root_comment_id: 1 });
      const sibling = makeComment({ id: 6, parent_comment_id: 1, root_comment_id: 1 });
      useCommentStore.setState({
        commentsByDay: { [DAY]: [root, listed] },
        repliesByRoot: { 1: { comments: [sibling], hasMore: false, loading: false } },
      });
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await store().deleteComment(5, DAY);

      expect(dayComments()).toEqual([
        { ...root, reply_count: 1 },
        { ...listed, is_deleted: true, body: '[Deleted]' },
      ]);
      expect(replies(1)).toEqual([sibling]);
    });

    it('handles a listed leaf reply whose thread is not loaded', async () => {
      const root = makeComment({ id: 1, reply_count: 1 });
      const listed = makeComment({ id: 5, parent_comment_id: 1, root_comment_id: 1 });
      useCommentStore.setState({ commentsByDay: { [DAY]: [root, listed] } });
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await store().deleteComment(5, DAY);

      expect(dayComments()?.[0]).toEqual({ ...root, reply_count: 0 });
      expect(store().repliesByRoot).toEqual({});
    });

    it('handles a listed leaf reply that has no root id', async () => {
      const root = makeComment({ id: 1, reply_count: 1 });
      const listed = makeComment({ id: 5, parent_comment_id: 1 });
      useCommentStore.setState({ commentsByDay: { [DAY]: [root, listed] } });
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await store().deleteComment(5, DAY);

      expect(dayComments()?.[0]).toEqual({ ...root, reply_count: 0 });
      expect(store().repliesByRoot).toEqual({});
    });

    it('still updates the count for a comment that is not loaded', async () => {
      useCommentStore.setState({ counts: { [DAY]: 2 } });
      apiMock.deleteComment.mockResolvedValue({ success: true, message: 'deleted' });

      await expect(store().deleteComment(404, DAY)).resolves.toBe(true);

      expect(store().counts[DAY]).toBe(1);
    });

    it('returns false and keeps the comment when deleting fails', async () => {
      const { root } = thread();
      apiMock.deleteComment.mockResolvedValueOnce({ success: false, message: 'Forbidden' });
      await expect(store().deleteComment(1, DAY)).resolves.toBe(false);

      const error = new Error('Network down');
      apiMock.deleteComment.mockRejectedValueOnce(error);
      await expect(store().deleteComment(1, DAY)).resolves.toBe(false);

      expect(dayComments()).toEqual([root]);
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] deleteComment failed:', error);
    });
  });

  describe('editComment', () => {
    it('shows the edit immediately, then applies the server version', async () => {
      const original = makeComment({ id: 1, body: 'Old' });
      useCommentStore.setState({
        commentsByDay: { [DAY]: [original] },
        previewsByDay: { [DAY]: [original] },
      });
      const request = deferred<CommentActionResponse>();
      apiMock.editComment.mockReturnValue(request.promise);

      const editing = store().editComment(1, 'New', DAY);
      expect(dayComments()).toEqual([{ ...original, body: 'New', is_edited: true }]);
      expect(store().previewsByDay[DAY]).toEqual([{ ...original, body: 'New', is_edited: true }]);

      const saved = { ...original, body: 'New (saved)', is_edited: true };
      request.resolve({ success: true, comment: saved });
      await expect(editing).resolves.toBe(saved);

      expect(apiMock.editComment).toHaveBeenCalledWith(1, 'New');
      expect(dayComments()).toEqual([saved]);
      expect(store().previewsByDay[DAY]).toBeUndefined();
      expect(gl.track).toHaveBeenCalledWith('comment_edited', { properties: { commentId: 1 } });
    });

    it('edits a reply inside its thread', async () => {
      const { reply } = thread();
      const saved = { ...reply, body: 'Edited reply', is_edited: true };
      apiMock.editComment.mockResolvedValue({ success: true, comment: saved });

      await store().editComment(10, 'Edited reply', DAY);

      expect(replies(1)?.[0]).toEqual(saved);
    });

    it('reverts a reply edit even when the day list is not loaded', async () => {
      const { reply } = thread();
      useCommentStore.setState({ commentsByDay: {} });
      apiMock.editComment.mockRejectedValue(new Error('Network down'));

      await store().editComment(10, 'Nope', DAY);

      expect(replies(1)?.[0]).toEqual(reply);
    });

    it('reverts the edit when the server refuses', async () => {
      const { reply } = thread();
      apiMock.editComment.mockResolvedValue({ success: false });

      await expect(store().editComment(10, 'Nope', DAY)).resolves.toBeNull();

      expect(replies(1)?.[0]).toEqual(reply);
    });

    it('reverts the edit when the request fails', async () => {
      const { root } = thread();
      const error = new Error('Network down');
      apiMock.editComment.mockRejectedValue(error);

      await expect(store().editComment(1, 'Nope', DAY)).resolves.toBeNull();

      expect(dayComments()).toEqual([root]);
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] editComment failed:', error);
    });

    it('leaves state untouched for a comment that is not loaded', async () => {
      thread();
      const before = store();
      apiMock.editComment.mockRejectedValue(new Error('Not found'));

      await expect(store().editComment(404, 'x', DAY)).resolves.toBeNull();

      expect(store().commentsByDay).toBe(before.commentsByDay);
      expect(store().repliesByRoot).toBe(before.repliesByRoot);
    });
  });

  describe('likeComment', () => {
    it('likes optimistically, then trusts the server count', async () => {
      const comment = makeComment({ id: 1, like_count: 2 });
      useCommentStore.setState({ commentsByDay: { [DAY]: [comment] } });
      const request = deferred<CommentLikeResponse>();
      apiMock.likeComment.mockReturnValue(request.promise);

      const liking = store().likeComment(1, DAY);
      expect(dayComments()?.[0]).toMatchObject({ liked_by_me: true, like_count: 3 });
      expect(gl.track).toHaveBeenCalledWith('comment_liked', { properties: { commentId: 1 } });

      request.resolve({ success: true, liked: true, new_count: 5 });
      await liking;

      expect(apiMock.likeComment).toHaveBeenCalledWith(1);
      expect(dayComments()?.[0]).toMatchObject({ liked_by_me: true, like_count: 5 });
    });

    it('rolls the like back when the request fails', async () => {
      useCommentStore.setState({
        commentsByDay: { [DAY]: [makeComment({ id: 1, like_count: 2 })] },
      });
      const error = new Error('Network down');
      apiMock.likeComment.mockRejectedValue(error);

      await store().likeComment(1, DAY);

      expect(dayComments()?.[0]).toMatchObject({ liked_by_me: false, like_count: 2 });
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] likeComment failed:', error);
    });

    it('updates a comment shown only in the day preview', async () => {
      useCommentStore.setState({
        previewsByDay: { [DAY]: [makeComment({ id: 1, like_count: 0 })] },
      });
      apiMock.likeComment.mockResolvedValue({ success: true, liked: true, new_count: 1 });

      await store().likeComment(1, DAY);

      expect(store().previewsByDay[DAY][0]).toMatchObject({ liked_by_me: true, like_count: 1 });
      expect(dayComments()).toBeUndefined();
    });

    it('likes a reply inside its thread', async () => {
      thread();
      apiMock.likeComment.mockResolvedValue({ success: true, liked: true, new_count: 4 });

      await store().likeComment(11, DAY);

      expect(replies(1)?.[1]).toMatchObject({ liked_by_me: true, like_count: 4 });
    });
  });

  describe('unlikeComment', () => {
    it('unlikes optimistically, then trusts the server count', async () => {
      const comment = makeComment({ id: 1, like_count: 3, liked_by_me: true });
      useCommentStore.setState({ commentsByDay: { [DAY]: [comment] } });
      const request = deferred<CommentLikeResponse>();
      apiMock.unlikeComment.mockReturnValue(request.promise);

      const unliking = store().unlikeComment(1, DAY);
      expect(dayComments()?.[0]).toMatchObject({ liked_by_me: false, like_count: 2 });
      expect(gl.track).toHaveBeenCalledWith('comment_unliked', { properties: { commentId: 1 } });

      request.resolve({ success: true, liked: false, new_count: 1 });
      await unliking;

      expect(apiMock.unlikeComment).toHaveBeenCalledWith(1);
      expect(dayComments()?.[0]).toMatchObject({ liked_by_me: false, like_count: 1 });
    });

    it('never shows a negative count', async () => {
      useCommentStore.setState({
        commentsByDay: { [DAY]: [makeComment({ id: 1, like_count: 0, liked_by_me: true })] },
      });
      apiMock.unlikeComment.mockReturnValue(new Promise(() => {}));

      void store().unlikeComment(1, DAY);

      expect(dayComments()?.[0]).toMatchObject({ liked_by_me: false, like_count: 0 });
    });

    it('restores the like when the request fails', async () => {
      useCommentStore.setState({
        commentsByDay: { [DAY]: [makeComment({ id: 1, like_count: 3, liked_by_me: true })] },
      });
      const error = new Error('Network down');
      apiMock.unlikeComment.mockRejectedValue(error);

      await store().unlikeComment(1, DAY);

      expect(dayComments()?.[0]).toMatchObject({ liked_by_me: true, like_count: 3 });
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] unlikeComment failed:', error);
    });
  });

  describe('counts and previews', () => {
    it('fetchCommentCount stores the count for the day', async () => {
      apiMock.getCommentCount.mockResolvedValue({ success: true, count: 7 });

      await store().fetchCommentCount(USER, DATE);

      expect(apiMock.getCommentCount).toHaveBeenCalledWith(USER, DATE);
      expect(store().counts[DAY]).toBe(7);
    });

    it('fetchCommentCount keeps the old count when the request fails', async () => {
      useCommentStore.setState({ counts: { [DAY]: 2 } });

      apiMock.getCommentCount.mockResolvedValueOnce({ success: false, count: 0 });
      await store().fetchCommentCount(USER, DATE);

      const error = new Error('Network down');
      apiMock.getCommentCount.mockRejectedValueOnce(error);
      await store().fetchCommentCount(USER, DATE);

      expect(store().counts[DAY]).toBe(2);
      expect(consoleError).toHaveBeenCalledWith('[CommentStore] fetchCommentCount failed:', error);
    });

    it('fetchPreviewComments keeps the top two visible comments', async () => {
      const top = makeComment({ id: 1 });
      const removed = makeComment({ id: 2, is_deleted: true });
      apiMock.getComments.mockResolvedValue({
        success: true,
        comments: [top, removed],
        has_more: true,
      });

      await store().fetchPreviewComments(USER, DATE);

      expect(apiMock.getComments).toHaveBeenCalledWith(USER, DATE, 'top', undefined, 2);
      expect(store().previewsByDay[DAY]).toEqual([top]);
    });

    it('fetchPreviewComments ignores failures silently', async () => {
      apiMock.getComments.mockResolvedValueOnce({ success: false, comments: [], has_more: false });
      await store().fetchPreviewComments(USER, DATE);

      apiMock.getComments.mockRejectedValueOnce(new Error('Network down'));
      await store().fetchPreviewComments(USER, DATE);

      expect(store().previewsByDay[DAY]).toBeUndefined();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('clearPreview drops one day’s preview', () => {
      useCommentStore.setState({
        previewsByDay: { [DAY]: [makeComment()], 'bob:2024-03-02': [makeComment()] },
      });

      store().clearPreview(DAY);

      expect(Object.keys(store().previewsByDay)).toEqual(['bob:2024-03-02']);
    });
  });

  describe('setSort and clearComments', () => {
    it('setSort switches between top and newest', () => {
      store().setSort('newest');
      expect(store().sort).toBe('newest');

      store().setSort('top');
      expect(store().sort).toBe('top');
    });

    it('clearComments(dayKey) drops that day and every open thread', () => {
      thread();
      useCommentStore.setState((state) => ({
        hasMore: true,
        commentsByDay: { ...state.commentsByDay, 'bob:2024-03-02': [makeComment({ id: 50 })] },
      }));

      store().clearComments(DAY);

      expect(Object.keys(store().commentsByDay)).toEqual(['bob:2024-03-02']);
      expect(store().repliesByRoot).toEqual({});
      expect(store().hasMore).toBe(false);
    });

    it('clearComments() drops everything', () => {
      thread();
      useCommentStore.setState({ hasMore: true });

      store().clearComments();

      expect(store()).toMatchObject({ commentsByDay: {}, repliesByRoot: {}, hasMore: false });
    });
  });
});
