import { act, fireEvent, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommentStore } from '../../../store/useCommentStore';
import { createDeferred, enableFakeTimers, makeComment } from '../../../test/fixtures/ui';
import { renderWithRouter, signIn } from '../../../test/utils';
import type { Comment } from '../../../types/comment';
import { CommentItem } from './CommentItem';
import styles from './CommentItem.module.css';

vi.mock('../../../services/api', () => ({ commentApi: {} }));

const NOW = new Date('2026-10-21T10:00:00.000Z');
const DAY_KEY = 'alice:2026-10-20';
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** Replaces the store actions CommentItem calls with spies. */
function seedActions() {
  const actions = {
    likeComment: vi.fn(),
    unlikeComment: vi.fn(),
    deleteComment: vi.fn(async () => true),
    editComment: vi.fn<(id: number, body: string, dayKey: string) => Promise<Comment | null>>(
      async (id, body) => makeComment({ id, body, is_edited: true })
    ),
    fetchReplies: vi.fn(async () => {}),
  };
  useCommentStore.setState(actions);
  return actions;
}

function renderItem(comment: Comment = makeComment(), { isTopLevel = false } = {}) {
  const onReply = vi.fn();
  const utils = renderWithRouter(
    <CommentItem
      comment={comment}
      dayKey={DAY_KEY}
      username="alice"
      date="2026-10-20"
      onReply={onReply}
      isTopLevel={isTopLevel}
    />,
    { route: '/user/alice?date=2026-10-20' }
  );
  return { onReply, unmount: utils.unmount };
}

const location = () => screen.getByTestId('location');

/** Lets a pending store action settle and React apply the update it triggers. */
const settle = () => act(async () => {});

describe('CommentItem', () => {
  let user: UserEvent;
  let actions: ReturnType<typeof seedActions>;

  beforeEach(() => {
    // Fake clock: relative times, the 1-hour edit window and the delete confirmation
    user = enableFakeTimers();
    vi.setSystemTime(NOW);
    actions = seedActions();
  });

  describe('content', () => {
    it('shows the author, verified badge, age and body', () => {
      renderItem(makeComment({ author_verified: true, author_avatar: 'https://cdn.test/bob.jpg' }));

      expect(screen.getByText('bob')).toHaveClass(styles.username);
      expect(screen.getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'bob' })).toHaveAttribute(
        'src',
        'https://cdn.test/bob.jpg'
      );
      expect(screen.getByText('2h')).toHaveClass(styles.timestamp);
      expect(screen.getByText('Great day!')).toHaveClass(styles.body);
      expect(screen.queryByText('(edited)')).not.toBeInTheDocument();
    });

    it.each([
      [0.5, 'now'],
      [5, '5m'],
      [3 * 60, '3h'],
      [2 * 24 * 60, '2d'],
      [15 * 24 * 60, '2w'],
      [400 * 24 * 60, '1y'],
    ])('shows a comment from %s minutes ago as "%s"', (minutes, label) => {
      renderItem(makeComment({ created_at: minutesAgo(minutes) }));
      expect(screen.getByText(label)).toHaveClass(styles.timestamp);
    });

    it('calls the current user "You" and marks edits', () => {
      signIn({ id: 2, username: 'bob' });
      renderItem(makeComment({ is_edited: true }));

      expect(screen.getByText('You')).toBeInTheDocument();
      expect(screen.getByText('(edited)')).toBeInTheDocument();
    });

    it('shows who a reply answers and links to them', async () => {
      renderItem(makeComment({ reply_to_username: 'carol' }));

      expect(screen.getByText('Replying to')).toHaveTextContent('Replying to @carol');
      await user.click(screen.getByText('@carol'));
      expect(location()).toHaveTextContent('/user/carol?date=2026-10-20');
    });

    it('says "@You" when the reply answers the current user', () => {
      signIn({ id: 5, username: 'carol' });
      renderItem(makeComment({ reply_to_username: 'carol' }));

      expect(screen.getByText('Replying to')).toHaveTextContent('Replying to @You');
    });

    it.each([
      ['avatar', () => screen.getByText('B')],
      ['name', () => screen.getByText('bob')],
    ])('opens the author profile from the %s', async (_part, getTarget) => {
      renderItem();

      await user.click(getTarget());
      expect(location()).toHaveTextContent('/user/bob?date=2026-10-20');
    });

    it('links known mentions and URLs inside the body', async () => {
      const longUrl = 'https://example.com/a/very/long/path/that/keeps/going/on';
      renderItem(
        makeComment({
          body: `Thanks @carol and @dave! Docs: https://example.com/docs and ${longUrl}`,
          mentions: [{ user_id: 3, username: 'carol' }],
        })
      );

      const mention = screen.getByRole('link', { name: '@carol' });
      expect(mention).toHaveClass(styles.mention);
      expect(screen.queryByRole('link', { name: '@dave' })).not.toBeInTheDocument();
      expect(screen.getByText(/and @dave!/)).toBeInTheDocument();

      const docs = screen.getByRole('link', { name: 'https://example.com/docs' });
      expect(docs).toHaveAttribute('href', 'https://example.com/docs');
      expect(docs).toHaveAttribute('target', '_blank');
      expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByRole('link', { name: `${longUrl.slice(0, 40)}…` })).toHaveAttribute(
        'href',
        longUrl
      );

      await user.click(mention);
      expect(location()).toHaveTextContent('/user/carol?date=2026-10-20');
    });

    it('collapses long comments behind "more"', async () => {
      const body = `${'a'.repeat(195)} bbbbbbbbbb tail`;
      renderItem(makeComment({ body }));

      expect(screen.getByText(/^a+ bbbb\.\.\.$/)).toBeInTheDocument();
      expect(screen.queryByText(/tail/)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'more' }));
      expect(screen.getByText(body)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'more' })).not.toBeInTheDocument();
    });

    it('does not collapse an emoji-only comment at the 200-character threshold', () => {
      // 200 characters, but 400 UTF-16 units
      const body = '🔥'.repeat(200);
      renderItem(makeComment({ body }));

      expect(screen.getByText(body)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'more' })).not.toBeInTheDocument();
    });

    it('collapses an emoji-only comment just over the threshold to 200 whole emoji', async () => {
      const body = '🔥'.repeat(201);
      renderItem(makeComment({ body }));

      expect(screen.getByText(`${'🔥'.repeat(200)}...`)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'more' }));
      expect(screen.getByText(body)).toBeInTheDocument();
    });

    it('never splits an emoji in the collapsed preview', () => {
      renderItem(makeComment({ body: `x${'🔥'.repeat(200)}` }));

      expect(screen.getByText(`x${'🔥'.repeat(199)}...`)).toBeInTheDocument();
    });

    it('shows a placeholder without author or actions for deleted comments', () => {
      renderItem(makeComment({ is_deleted: true, body: '[Deleted]', like_count: 2 }));

      expect(screen.getByText('[Deleted]')).toHaveClass(styles.deletedBody);
      expect(screen.queryByText('bob')).not.toBeInTheDocument();
      expect(screen.queryByText('B')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('likes through the store', async () => {
      renderItem();
      const like = screen.getByRole('button', { name: 'Like' });

      expect(like).toHaveTextContent('');
      await user.click(like);
      expect(actions.likeComment).toHaveBeenCalledExactlyOnceWith(1, DAY_KEY);
      expect(actions.unlikeComment).not.toHaveBeenCalled();
    });

    it('unlikes through the store and shows the like count', async () => {
      renderItem(makeComment({ liked_by_me: true, like_count: 3 }));
      const unlike = screen.getByRole('button', { name: 'Unlike' });

      expect(unlike).toHaveTextContent('3');
      expect(unlike).toHaveClass(styles.liked);
      await user.click(unlike);
      expect(actions.unlikeComment).toHaveBeenCalledExactlyOnceWith(1, DAY_KEY);
    });

    it('starts a reply to the author', async () => {
      const { onReply } = renderItem();

      await user.click(screen.getByRole('button', { name: 'Reply' }));
      expect(onReply).toHaveBeenCalledExactlyOnceWith(1, 'bob');
    });

    it.each([
      ['signed out', null],
      ['someone else', { id: 9, username: 'zed' }],
    ])('cannot be deleted or edited when %s', (_who, viewer) => {
      if (viewer) signIn(viewer);
      renderItem(makeComment({ created_at: minutesAgo(5) }));

      expect(screen.queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    });

    it('can be deleted, but not edited, by the owner of the day', () => {
      signIn({ id: 1, username: 'alice' });
      renderItem(makeComment({ created_at: minutesAgo(5) }));

      expect(screen.getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    });

    it('asks for a second tap before deleting', async () => {
      signIn({ id: 2, username: 'bob' });
      renderItem();

      await user.click(screen.getByRole('button', { name: 'Delete comment' }));
      const confirm = screen.getByRole('button', { name: 'Tap again to delete' });
      expect(confirm).toHaveAttribute('title', 'Tap again to delete');
      expect(confirm).toHaveClass(styles.deleteConfirm);
      expect(actions.deleteComment).not.toHaveBeenCalled();

      await user.click(confirm);
      expect(actions.deleteComment).toHaveBeenCalledExactlyOnceWith(1, DAY_KEY);
      expect(screen.getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
    });

    it('forgets the delete confirmation after 5 seconds', async () => {
      signIn({ id: 2, username: 'bob' });
      renderItem();

      await user.click(screen.getByRole('button', { name: 'Delete comment' }));
      act(() => vi.advanceTimersByTime(4999));
      expect(screen.getByRole('button', { name: 'Tap again to delete' })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));

      expect(screen.getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
      expect(actions.deleteComment).not.toHaveBeenCalled();
    });
  });

  describe('editing', () => {
    beforeEach(() => {
      signIn({ id: 2, username: 'bob' });
    });

    const startEditing = async (comment = makeComment({ created_at: minutesAgo(10) })) => {
      renderItem(comment);
      await user.click(screen.getByRole('button', { name: 'Edit comment' }));
      return screen.getByRole('textbox', { name: 'Edit comment' }) as HTMLTextAreaElement;
    };

    it('opens an editor with the current text, focused at the end', async () => {
      const editor = await startEditing();

      expect(editor).toHaveValue('Great day!');
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe(10);
      expect(screen.getByRole('button', { name: 'Save edit' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
    });

    it('saves the trimmed new text and closes the editor', async () => {
      const editor = await startEditing();

      await user.clear(editor);
      await user.type(editor, '  Even better day ');
      await user.click(screen.getByRole('button', { name: 'Save edit' }));
      await settle();

      expect(actions.editComment).toHaveBeenCalledExactlyOnceWith(1, 'Even better day', DAY_KEY);
      expect(screen.queryByRole('textbox', { name: 'Edit comment' })).not.toBeInTheDocument();
    });

    it('keeps the editor open when saving fails', async () => {
      actions.editComment.mockResolvedValueOnce(null);
      const editor = await startEditing();

      await user.type(editor, '!');
      await user.click(screen.getByRole('button', { name: 'Save edit' }));
      await settle();

      expect(screen.getByRole('textbox', { name: 'Edit comment' })).toHaveValue('Great day!!');
      expect(screen.getByRole('button', { name: 'Save edit' })).toBeEnabled();
    });

    it('disables the editor buttons while saving', async () => {
      const request = createDeferred<Comment | null>();
      actions.editComment.mockReturnValueOnce(request.promise);
      const editor = await startEditing();

      await user.type(editor, '!');
      await user.click(screen.getByRole('button', { name: 'Save edit' }));
      expect(screen.getByRole('button', { name: 'Save edit' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel edit' })).toBeDisabled();

      fireEvent.keyDown(editor, { key: 'Enter' });
      expect(actions.editComment).toHaveBeenCalledTimes(1);
      await act(async () => request.resolve(makeComment()));
    });

    it('saves with Enter and adds a line with Shift+Enter', async () => {
      const editor = await startEditing();

      await user.type(editor, '{Shift>}{Enter}{/Shift}More');
      expect(editor).toHaveValue('Great day!\nMore');
      expect(actions.editComment).not.toHaveBeenCalled();

      await user.keyboard('{Enter}');
      expect(actions.editComment).toHaveBeenCalledWith(1, 'Great day!\nMore', DAY_KEY);
    });

    it('just closes the editor when the text did not change', async () => {
      const editor = await startEditing();

      await user.type(editor, '  ');
      await user.keyboard('{Enter}');

      expect(actions.editComment).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox', { name: 'Edit comment' })).not.toBeInTheDocument();
    });

    it('refuses to save an empty comment', async () => {
      const editor = await startEditing();

      await user.clear(editor);
      await user.keyboard('{Enter}');

      expect(actions.editComment).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Edit comment' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save edit' })).toBeDisabled();
    });

    it('cancels with the button or Escape, claiming Escape so the sheet stays open', async () => {
      const claimed: boolean[] = [];
      const onKeyDown = (event: KeyboardEvent) => claimed.push(event.defaultPrevented);
      await startEditing();

      await user.click(screen.getByRole('button', { name: 'Cancel edit' }));
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByText('Great day!')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Edit comment' }));
      document.addEventListener('keydown', onKeyDown);
      await user.keyboard('{Escape}');
      document.removeEventListener('keydown', onKeyDown);

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(claimed).toEqual([true]);
    });

    it('shows a character counter near the limit and stops at the limit', async () => {
      const editor = await startEditing();

      expect(editor).not.toHaveAttribute('maxlength');
      fireEvent.change(editor, { target: { value: 'x'.repeat(170) } });
      expect(screen.getByText('170/200')).toBeInTheDocument();

      // Only the 30 characters that still fit are kept
      fireEvent.change(editor, { target: { value: 'x'.repeat(201) } });
      expect(editor).toHaveValue('x'.repeat(200));
      expect(screen.getByText('200/200')).toBeInTheDocument();
    });

    it('counts an emoji as one character, as the server does', async () => {
      const editor = await startEditing();

      // 170 emoji are 340 UTF-16 units, which the old maxLength would have refused
      fireEvent.change(editor, { target: { value: '🔥'.repeat(170) } });
      expect(editor).toHaveValue('🔥'.repeat(170));
      expect(screen.getByText('170/200')).toBeInTheDocument();
    });

    it('leaves a full comment unchanged when typing in the middle of it', async () => {
      const editor = await startEditing();
      const full = `${'a'.repeat(100)}${'🔥'.repeat(100)}`;
      fireEvent.change(editor, { target: { value: full } });

      await user.type(editor, 'XY', { initialSelectionStart: 100, initialSelectionEnd: 100 });

      expect(editor).toHaveValue(full);
      expect(screen.getByText('200/200')).toBeInTheDocument();
    });

    it('is only offered within an hour of posting', () => {
      renderItem(makeComment({ created_at: minutesAgo(61) }));

      expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
    });

    it('drops the edit button when the hour runs out', () => {
      renderItem(makeComment({ created_at: minutesAgo(59) }));
      expect(screen.getByRole('button', { name: 'Edit comment' })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    });

    it('closes an open editor when the hour runs out', async () => {
      await startEditing(makeComment({ created_at: minutesAgo(59) }));

      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.queryByRole('textbox', { name: 'Edit comment' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    });

    it('cannot edit a deleted comment', () => {
      renderItem(makeComment({ is_deleted: true, created_at: minutesAgo(1) }));
      expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    });
  });

  describe('replies', () => {
    const replies = Array.from({ length: 5 }, (_, i) =>
      makeComment({
        id: 100 + i,
        author_id: 10 + i,
        author_username: `fan${i}`,
        body: `Reply ${i}`,
        parent_comment_id: 1,
        root_comment_id: 1,
      })
    );

    it('loads the replies of a top-level comment on request', async () => {
      renderItem(makeComment({ reply_count: 2 }), { isTopLevel: true });

      await user.click(screen.getByRole('button', { name: 'View 2 replies' }));
      expect(actions.fetchReplies).toHaveBeenCalledExactlyOnceWith(1, true);
    });

    it('uses the singular for one reply and hides the section without replies', () => {
      const { unmount } = renderItem(makeComment({ reply_count: 1 }), { isTopLevel: true });
      expect(screen.getByRole('button', { name: 'View 1 reply' })).toBeInTheDocument();
      unmount();

      renderItem(makeComment({ reply_count: 0 }), { isTopLevel: true });
      expect(screen.queryByRole('button', { name: /View/ })).not.toBeInTheDocument();
    });

    it('never shows a replies section on replies themselves', () => {
      renderItem(makeComment({ reply_count: 3 }));
      expect(screen.queryByRole('button', { name: /View/ })).not.toBeInTheDocument();
    });

    it('shows the first loaded replies, then all of them, then loads more', async () => {
      useCommentStore.setState({
        repliesByRoot: { 1: { comments: replies, hasMore: true, loading: false } },
      });
      const { onReply } = renderItem(makeComment({ reply_count: 7 }), { isTopLevel: true });

      expect(screen.getAllByText(/^Reply \d$/).map((el) => el.textContent)).toEqual([
        'Reply 0',
        'Reply 1',
        'Reply 2',
      ]);
      await user.click(screen.getByRole('button', { name: 'View 4 more replies' }));
      expect(actions.fetchReplies).not.toHaveBeenCalled();
      expect(screen.getAllByText(/^Reply \d$/)).toHaveLength(5);

      await user.click(screen.getByRole('button', { name: 'Load more replies' }));
      expect(actions.fetchReplies).toHaveBeenCalledExactlyOnceWith(1);

      // Replies can be answered too
      const reply = screen.getByText('Reply 4').closest(`.${styles.comment}`) as HTMLElement;
      await user.click(within(reply).getByRole('button', { name: 'Reply' }));
      expect(onReply).toHaveBeenCalledWith(104, 'fan4');
    });

    it('uses the singular for one more reply', () => {
      useCommentStore.setState({
        repliesByRoot: { 1: { comments: replies.slice(0, 4), hasMore: false, loading: false } },
      });
      renderItem(makeComment({ reply_count: 4 }), { isTopLevel: true });

      expect(screen.getByRole('button', { name: 'View 1 more reply' })).toBeInTheDocument();
    });

    it('shows when more replies are loading', async () => {
      useCommentStore.setState({
        repliesByRoot: { 1: { comments: [], hasMore: true, loading: true } },
      });
      renderItem(makeComment({ reply_count: 5 }), { isTopLevel: true });

      await user.click(screen.getByRole('button', { name: 'View 2 more replies' }));
      expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
    });
  });
});
