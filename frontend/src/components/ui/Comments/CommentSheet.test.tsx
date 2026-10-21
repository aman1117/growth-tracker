import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommentStore } from '../../../store/useCommentStore';
import { commentsPage, createDeferred, makeComment } from '../../../test/fixtures/ui';
import { signIn } from '../../../test/utils';
import type { CommentLikeResponse, CommentsListResponse } from '../../../types/comment';
import itemStyles from './CommentItem.module.css';
import { CommentSheet } from './CommentSheet';
import styles from './CommentSheet.module.css';

const { commentApi, apiClient } = vi.hoisted(() => ({
  commentApi: {
    getComments: vi.fn(),
    getReplies: vi.fn(),
    createComment: vi.fn(),
    createReply: vi.fn(),
    deleteComment: vi.fn(),
    editComment: vi.fn(),
    likeComment: vi.fn(),
    unlikeComment: vi.fn(),
  },
  apiClient: { get: vi.fn() },
}));
vi.mock('../../../services/api', () => ({ commentApi, apiClient }));

const NOW = new Date('2026-10-21T10:00:00.000Z');
const first = makeComment({ id: 1, body: 'First!', created_at: '2026-10-21T09:50:00.000Z' });
const second = makeComment({
  id: 2,
  author_id: 3,
  author_username: 'carol',
  body: 'Love this',
  like_count: 2,
});

const Router = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/user/alice?date=2026-10-20']}>{children}</MemoryRouter>
);

function renderSheet({ isOpen = true } = {}) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const sheet = (open: boolean) => (
    <CommentSheet isOpen={open} onClose={onClose} username="alice" date="2026-10-20" />
  );
  const utils = render(sheet(isOpen), { wrapper: Router });
  return { user, onClose, rerenderOpen: (open: boolean) => utils.rerender(sheet(open)), ...utils };
}

/** Opens the sheet and waits for the first page of comments. */
async function openWithComments(comments = [first, second], hasMore = false) {
  commentApi.getComments.mockResolvedValueOnce(commentsPage(comments, hasMore));
  const utils = renderSheet();
  await screen.findByText(comments[0].body);
  return { ...utils, dialog: screen.getByRole('dialog', { name: 'Comments' }) };
}

const commentWith = (body: string) =>
  screen.getByText(body).closest(`.${itemStyles.comment}`) as HTMLElement;

const listOf = (dialog: HTMLElement) =>
  dialog.querySelector(`.${styles.commentList}`) as HTMLElement;

/** jsdom has no layout, so give the list a 1000px-tall content in a 400px viewport. */
function scrollListTo(list: HTMLElement, scrollTop: number) {
  Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(list, 'scrollTop', { value: scrollTop, configurable: true });
  fireEvent.scroll(list);
}

const setMobile = (mobile: boolean) => vi.stubGlobal('innerWidth', mobile ? 375 : 1024);

describe('CommentSheet', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
    commentApi.getComments.mockResolvedValue(commentsPage([]));
  });

  it('renders and loads nothing while closed', () => {
    renderSheet({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(commentApi.getComments).not.toHaveBeenCalled();
  });

  it('opens a labelled modal sheet in a portal and loads the top comments', async () => {
    const { container, dialog } = await openWithComments();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(container).not.toContainElement(dialog);
    expect(commentApi.getComments).toHaveBeenCalledExactlyOnceWith(
      'alice',
      '2026-10-20',
      'top',
      undefined,
      20
    );
    expect(within(dialog).getByText('Love this')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Top' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(dialog).getByRole('button', { name: 'Newest' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('shows placeholders while the first page loads', async () => {
    const page = createDeferred<CommentsListResponse>();
    commentApi.getComments.mockReturnValueOnce(page.promise);
    renderSheet();

    expect(screen.getByLabelText('Loading comments')).toHaveAttribute('aria-busy', 'true');

    await act(async () => page.resolve(commentsPage([first])));
    expect(screen.queryByLabelText('Loading comments')).not.toBeInTheDocument();
    expect(screen.getByText('First!')).toBeInTheDocument();
  });

  it('invites the first comment when there are none', async () => {
    renderSheet();

    expect(await screen.findByText('No comments yet')).toBeInTheDocument();
    expect(screen.getByText('Start the conversation.')).toBeInTheDocument();
  });

  it('falls back to the empty state when loading fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    commentApi.getComments.mockRejectedValueOnce(new Error('offline'));
    renderSheet();

    expect(await screen.findByText('No comments yet')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[CommentStore] fetchComments failed:',
      expect.any(Error)
    );
  });

  describe('list controls', () => {
    it('switches between top and newest comments', async () => {
      const { user, dialog } = await openWithComments();
      commentApi.getComments.mockResolvedValueOnce(commentsPage([second, first]));

      await user.click(within(dialog).getByRole('button', { name: 'Newest' }));

      expect(commentApi.getComments).toHaveBeenLastCalledWith(
        'alice',
        '2026-10-20',
        'newest',
        undefined,
        20
      );
      expect(within(dialog).getByRole('button', { name: 'Newest' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(listOf(dialog)).toHaveClass(styles.commentListFading);
      await waitFor(() => expect(listOf(dialog)).not.toHaveClass(styles.commentListFading));

      // Choosing the active sort again does nothing
      await user.click(within(dialog).getByRole('button', { name: 'Newest' }));
      expect(commentApi.getComments).toHaveBeenCalledTimes(2);
    });

    it('refreshes the list from the header', async () => {
      const { user, dialog } = await openWithComments();

      await user.click(within(dialog).getByRole('button', { name: 'Refresh comments' }));

      expect(commentApi.getComments).toHaveBeenCalledTimes(2);
      expect(commentApi.getComments).toHaveBeenLastCalledWith(
        'alice',
        '2026-10-20',
        'top',
        undefined,
        20
      );
      expect(listOf(dialog)).toHaveClass(styles.commentListFading);
      await waitFor(() => expect(listOf(dialog)).not.toHaveClass(styles.commentListFading));
    });

    it('refreshes an empty list without the fade', async () => {
      const { user } = renderSheet();
      await screen.findByText('No comments yet');

      await user.click(screen.getByRole('button', { name: 'Refresh comments' }));

      expect(commentApi.getComments).toHaveBeenCalledTimes(2);
      expect(listOf(screen.getByRole('dialog'))).not.toHaveClass(styles.commentListFading);
    });

    it('loads the next page when scrolled near the bottom', async () => {
      const { dialog } = await openWithComments([first, second], true);
      const nextPage = createDeferred<CommentsListResponse>();
      commentApi.getComments.mockReturnValueOnce(nextPage.promise);
      const list = listOf(dialog);

      scrollListTo(list, 100);
      expect(commentApi.getComments).toHaveBeenCalledTimes(1);

      scrollListTo(list, 550);
      expect(commentApi.getComments).toHaveBeenLastCalledWith('alice', '2026-10-20', 'top', 2, 20);

      await act(async () =>
        nextPage.resolve(commentsPage([makeComment({ id: 3, body: 'Third' })], false))
      );
      expect(within(dialog).getByText('Third')).toBeInTheDocument();
      expect(within(dialog).getByText('First!')).toBeInTheDocument();

      // The last page has been reached
      scrollListTo(list, 600);
      expect(commentApi.getComments).toHaveBeenCalledTimes(2);
    });

    it('shows a loader below the list while more comments load', async () => {
      const { dialog } = await openWithComments([first], true);

      act(() => useCommentStore.setState({ loading: true }));

      expect(within(dialog).getByText('Loading...')).toBeInTheDocument();
      scrollListTo(listOf(dialog), 600);
      expect(commentApi.getComments).toHaveBeenCalledTimes(1);
    });
  });

  describe('writing', () => {
    it('posts a new comment at the top of the list', async () => {
      commentApi.createComment.mockResolvedValueOnce({
        success: true,
        comment: makeComment({ id: 9, author_username: 'testuser', body: 'Nice work!' }),
      });
      const { user, dialog } = await openWithComments();

      await user.type(within(dialog).getByRole('textbox', { name: 'Comment input' }), 'Nice work!');
      await user.click(within(dialog).getByRole('button', { name: 'Post comment' }));

      expect(commentApi.createComment).toHaveBeenCalledExactlyOnceWith(
        'alice',
        '2026-10-20',
        'Nice work!',
        expect.any(String)
      );
      expect(await within(dialog).findByText('Nice work!')).toBeInTheDocument();
      const bodies = Array.from(dialog.querySelectorAll(`.${itemStyles.body}`)).map(
        (body) => body.textContent
      );
      expect(bodies).toEqual(['Nice work!', 'First!', 'Love this']);
    });

    it('replies to a comment and shows the reply under it', async () => {
      commentApi.createReply.mockResolvedValueOnce({
        success: true,
        comment: makeComment({
          id: 50,
          author_username: 'testuser',
          body: 'Thanks bob',
          parent_comment_id: 1,
          root_comment_id: 1,
          reply_to_username: 'bob',
        }),
      });
      const { user, dialog } = await openWithComments();

      await user.click(within(commentWith('First!')).getByRole('button', { name: 'Reply' }));
      const input = within(dialog).getByRole('textbox', { name: 'Comment input' });
      expect(input).toHaveAttribute('placeholder', 'Reply to @bob...');
      expect(input).toHaveFocus();

      await user.type(input, 'Thanks bob');
      await user.click(within(dialog).getByRole('button', { name: 'Post comment' }));

      expect(commentApi.createReply).toHaveBeenCalledExactlyOnceWith(
        'alice',
        '2026-10-20',
        1,
        'Thanks bob',
        expect.any(String)
      );
      const reply = await within(dialog).findByText('Thanks bob');
      expect(commentWith('First!')).toContainElement(reply);
      expect(within(dialog).queryByRole('button', { name: 'Cancel reply' })).toBeNull();
      expect(input).toHaveAttribute('placeholder', 'Add a comment...');
    });

    it('cancels a reply with Escape and keeps the sheet open until the next Escape', async () => {
      const { user, onClose } = await openWithComments();

      await user.click(within(commentWith('First!')).getByRole('button', { name: 'Reply' }));
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('button', { name: 'Cancel reply' })).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('comment actions', () => {
    it('likes a comment optimistically, then shows the server count', async () => {
      const like = createDeferred<CommentLikeResponse>();
      commentApi.likeComment.mockReturnValueOnce(like.promise);
      const { user } = await openWithComments();
      const comment = commentWith('Love this');

      await user.click(within(comment).getByRole('button', { name: 'Like' }));
      expect(within(comment).getByRole('button', { name: 'Unlike' })).toHaveTextContent('3');
      expect(commentApi.likeComment).toHaveBeenCalledExactlyOnceWith(2);

      await act(async () => like.resolve({ success: true, liked: true, new_count: 5 }));
      expect(within(comment).getByRole('button', { name: 'Unlike' })).toHaveTextContent('5');
    });

    it('rolls back a like that fails', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      commentApi.likeComment.mockRejectedValueOnce(new Error('offline'));
      const { user } = await openWithComments();
      const comment = commentWith('Love this');

      await user.click(within(comment).getByRole('button', { name: 'Like' }));

      await waitFor(() =>
        expect(within(comment).getByRole('button', { name: 'Like' })).toHaveTextContent('2')
      );
      expect(consoleError).toHaveBeenCalledWith(
        '[CommentStore] likeComment failed:',
        expect.any(Error)
      );
    });

    it('unlikes a comment', async () => {
      commentApi.unlikeComment.mockResolvedValueOnce({ success: true, liked: false, new_count: 0 });
      const { user } = await openWithComments([makeComment({ liked_by_me: true, like_count: 1 })]);

      await user.click(screen.getByRole('button', { name: 'Unlike' }));

      expect(commentApi.unlikeComment).toHaveBeenCalledExactlyOnceWith(1);
      const like = await screen.findByRole('button', { name: 'Like' });
      expect(like.textContent).toBe('');
    });

    it('deletes your own comment after a second tap', async () => {
      signIn({ id: 2, username: 'bob' });
      commentApi.deleteComment.mockResolvedValueOnce({ success: true, message: 'deleted' });
      const { user } = await openWithComments();
      const comment = commentWith('First!');

      await user.click(within(comment).getByRole('button', { name: 'Delete comment' }));
      expect(commentApi.deleteComment).not.toHaveBeenCalled();
      await user.click(within(comment).getByRole('button', { name: 'Tap again to delete' }));

      expect(commentApi.deleteComment).toHaveBeenCalledExactlyOnceWith(1);
      expect(await screen.findByText('[Deleted]')).toBeInTheDocument();
      expect(screen.queryByText('First!')).not.toBeInTheDocument();
    });

    it('edits your own recent comment', async () => {
      signIn({ id: 2, username: 'bob' });
      commentApi.editComment.mockResolvedValueOnce({
        success: true,
        comment: { ...first, body: 'First, edited', is_edited: true },
      });
      const { user } = await openWithComments();
      const comment = commentWith('First!');

      await user.click(within(comment).getByRole('button', { name: 'Edit comment' }));
      const editor = within(comment).getByRole('textbox', { name: 'Edit comment' });
      await user.clear(editor);
      await user.type(editor, 'First, edited');
      await user.click(within(comment).getByRole('button', { name: 'Save edit' }));

      expect(commentApi.editComment).toHaveBeenCalledExactlyOnceWith(1, 'First, edited');
      expect(await screen.findByText('First, edited')).toBeInTheDocument();
      expect(screen.getByText('(edited)')).toBeInTheDocument();
    });

    it('restores the original comment when an edit fails', async () => {
      signIn({ id: 2, username: 'bob' });
      commentApi.editComment.mockResolvedValueOnce({ success: false });
      const { user } = await openWithComments();
      const comment = commentWith('First!');

      await user.click(within(comment).getByRole('button', { name: 'Edit comment' }));
      await user.type(within(comment).getByRole('textbox', { name: 'Edit comment' }), '?');
      await user.click(within(comment).getByRole('button', { name: 'Save edit' }));

      // The editor stays open with the unsaved text
      await waitFor(() =>
        expect(within(comment).getByRole('button', { name: 'Save edit' })).toBeEnabled()
      );
      await user.click(within(comment).getByRole('button', { name: 'Cancel edit' }));

      expect(screen.getByText('First!')).toBeInTheDocument();
      expect(screen.queryByText('(edited)')).not.toBeInTheDocument();
    });

    it('loads replies and more replies on request', async () => {
      const reply = (id: number) =>
        makeComment({ id, body: `Reply ${id}`, parent_comment_id: 1, root_comment_id: 1 });
      commentApi.getReplies
        .mockResolvedValueOnce(commentsPage([reply(11), reply(12)], true))
        .mockResolvedValueOnce(commentsPage([reply(13)], false));
      const { user } = await openWithComments([{ ...first, reply_count: 3 }]);

      await user.click(screen.getByRole('button', { name: 'View 3 replies' }));
      expect(commentApi.getReplies).toHaveBeenCalledExactlyOnceWith(1, undefined, 20);
      expect(await screen.findByText('Reply 12')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Load more replies' }));
      expect(commentApi.getReplies).toHaveBeenLastCalledWith(1, 12, 20);
      expect(await screen.findByText('Reply 13')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more replies' })).not.toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it('closes from the close button', async () => {
      const { user, onClose } = await openWithComments();

      await user.click(screen.getByRole('button', { name: 'Close comments' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape', async () => {
      const { user, onClose } = await openWithComments();

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the dimmed overlay is clicked', async () => {
      const { dialog, onClose } = await openWithComments();
      const overlay = dialog.previousElementSibling as HTMLElement;

      expect(overlay).toHaveClass(styles.overlay);
      fireEvent.click(overlay);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes once when the overlay gets a real pointer click', async () => {
      const { user, dialog, onClose } = await openWithComments();

      await user.click(dialog.previousElementSibling as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on a press outside the sheet but not inside it', async () => {
      const { dialog, onClose } = await openWithComments();

      fireEvent.mouseDown(within(dialog).getByText('First!'));
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.mouseDown(document.body);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('plays a closing animation before unmounting', async () => {
      const { dialog, rerenderOpen } = await openWithComments();

      rerenderOpen(false);
      expect(dialog).toHaveClass(styles.panelDesktopClosing);
      expect(dialog.previousElementSibling).toHaveClass(styles.overlayClosing);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('closes on the system Back action', async () => {
      const { onClose } = await openWithComments();

      await waitFor(() =>
        expect(window.history.state).toEqual(
          expect.objectContaining({ __overlayId: expect.any(String) })
        )
      );
      act(() => window.history.back());

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  });

  describe('layout', () => {
    it('is a centered panel on desktop that leaves page scrolling alone', async () => {
      const { dialog } = await openWithComments();

      expect(dialog).toHaveClass(styles.panel, styles.panelDesktop);
      expect(dialog.querySelector(`.${styles.dragHandle}`)).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe('');
    });

    it('is a bottom sheet with a drag handle on phones and locks page scrolling', async () => {
      setMobile(true);
      const { dialog, rerenderOpen } = await openWithComments();

      expect(dialog).toHaveClass(styles.panelMobile);
      expect(dialog.querySelector(`.${styles.dragHandle}`)).toHaveAttribute('aria-hidden', 'true');
      expect(document.body.style.overflow).toBe('hidden');

      rerenderOpen(false);
      expect(dialog).toHaveClass(styles.panelMobileClosing);
      expect(document.body.style.overflow).toBe('');
    });

    it('follows viewport resizes', async () => {
      const { dialog } = await openWithComments();

      setMobile(true);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(dialog).toHaveClass(styles.panelMobile);
    });

    it('keeps touch gestures inside the sheet', async () => {
      const onPageTouch = vi.fn();
      commentApi.getComments.mockResolvedValueOnce(commentsPage([first]));
      render(
        <div onTouchStart={onPageTouch} onTouchMove={onPageTouch}>
          <CommentSheet isOpen onClose={vi.fn()} username="alice" date="2026-10-20" />
        </div>,
        { wrapper: Router }
      );
      await screen.findByText('First!');
      const dialog = screen.getByRole('dialog');

      fireEvent.touchStart(dialog, { touches: [{ clientX: 0, clientY: 0 }] });
      fireEvent.touchMove(dialog, { touches: [{ clientX: 0, clientY: 60 }] });
      expect(onPageTouch).not.toHaveBeenCalled();
    });
  });
});
