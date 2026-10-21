import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useCommentStore } from '../../../store/useCommentStore';
import { useToastStore } from '../../../store/useToastStore';
import { createDeferred, enableFakeTimers, makeComment } from '../../../test/fixtures/ui';
import type { Comment } from '../../../types/comment';
import { CommentInput } from './CommentInput';
import styles from './CommentInput.module.css';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn() } }));
vi.mock('../../../services/api', () => ({ apiClient, commentApi: {} }));

type InputProps = ComponentProps<typeof CommentInput>;

function renderInput(props: Partial<InputProps> = {}) {
  const actions = {
    createComment: vi.fn<(u: string, d: string, body: string) => Promise<Comment | null>>(
      async () => makeComment()
    ),
    createReply: vi.fn<(u: string, d: string, id: number, body: string) => Promise<Comment | null>>(
      async () => makeComment()
    ),
  };
  useCommentStore.setState(actions);
  const onCancelReply = vi.fn();
  const onCommentPosted = vi.fn();
  const utils = render(
    <CommentInput
      username="alice"
      date="2026-10-20"
      replyTarget={null}
      onCancelReply={onCancelReply}
      onCommentPosted={onCommentPosted}
      {...props}
    />
  );
  return {
    ...actions,
    onCancelReply,
    onCommentPosted,
    textarea: screen.getByRole('textbox', { name: 'Comment input' }),
    send: screen.getByRole('button', { name: 'Post comment' }),
    ...utils,
  };
}

const toastMessages = () => useToastStore.getState().toasts.map((toast) => toast.message);

/** Records whether Escape reached the document already claimed (as overlays check). */
function watchEscape() {
  const claimed: boolean[] = [];
  const listener = (event: KeyboardEvent) => {
    if (event.key === 'Escape') claimed.push(event.defaultPrevented);
  };
  document.addEventListener('keydown', listener);
  return { claimed, stop: () => document.removeEventListener('keydown', listener) };
}

describe('CommentInput', () => {
  it('starts empty with sending disabled', () => {
    const { textarea, send } = renderInput();

    expect(textarea).toHaveAttribute('placeholder', 'Add a comment...');
    // No UTF-16 maxLength: it would be stricter than the 200-character limit for emoji
    expect(textarea).not.toHaveAttribute('maxlength');
    expect(textarea).toHaveValue('');
    expect(send).toBeDisabled();
    expect(screen.queryByText(/\/200$/)).not.toBeInTheDocument();
  });

  it('only enables sending for non-blank text', async () => {
    const user = userEvent.setup();
    const { textarea, send } = renderInput();

    await user.type(textarea, '   ');
    expect(send).toBeDisabled();
    await user.type(textarea, 'Nice');
    expect(send).toBeEnabled();
  });

  it('posts the trimmed comment, then clears the box', async () => {
    const user = userEvent.setup();
    const { textarea, send, createComment, onCommentPosted } = renderInput();

    await user.type(textarea, '  Great job!  ');
    await user.click(send);

    expect(createComment).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20', 'Great job!');
    expect(textarea).toHaveValue('');
    expect(onCommentPosted).toHaveBeenCalledTimes(1);
    expect(send).toBeDisabled();
  });

  it('sends with Enter and adds a line with Shift+Enter on desktop', async () => {
    const user = userEvent.setup();
    const { textarea, createComment } = renderInput();

    await user.type(textarea, 'Line one{Shift>}{Enter}{/Shift}Line two');
    expect(textarea).toHaveValue('Line one\nLine two');
    expect(createComment).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(createComment).toHaveBeenCalledExactlyOnceWith(
      'alice',
      '2026-10-20',
      'Line one\nLine two'
    );
  });

  it('keeps Enter for new lines on phones (send button only)', async () => {
    vi.stubGlobal('innerWidth', 375);
    const user = userEvent.setup();
    const { textarea, send, createComment } = renderInput();

    await user.type(textarea, 'Hi{Enter}there');
    expect(createComment).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('Hi\nthere');

    await user.click(send);
    expect(createComment).toHaveBeenCalledWith('alice', '2026-10-20', 'Hi\nthere');
  });

  it('keeps the text and shows a toast when posting fails', async () => {
    const user = userEvent.setup();
    const { textarea, send, createComment, onCommentPosted } = renderInput();
    createComment.mockResolvedValueOnce(null);
    createComment.mockRejectedValueOnce(new Error('offline'));

    await user.type(textarea, 'Hello');
    await user.click(send);
    expect(toastMessages()).toEqual(['Failed to post comment']);
    expect(textarea).toHaveValue('Hello');

    await user.click(send);
    expect(toastMessages()).toEqual(['Failed to post comment', 'Failed to post comment']);
    expect(textarea).toHaveValue('Hello');
    expect(textarea).toBeEnabled();
    expect(onCommentPosted).not.toHaveBeenCalled();
  });

  it('ignores further submits while a comment is being posted', async () => {
    const user = userEvent.setup();
    const request = createDeferred<Comment | null>();
    const { textarea, send, createComment } = renderInput();
    createComment.mockReturnValueOnce(request.promise);

    await user.type(textarea, 'Hello');
    await user.click(send);
    expect(textarea).toBeDisabled();
    expect(send).toBeDisabled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.click(send);
    expect(createComment).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve(makeComment()));
    expect(textarea).toBeEnabled();
    expect(textarea).toHaveValue('');
  });

  it('shows a character counter close to the limit and stops at the limit', () => {
    const { textarea, container } = renderInput();

    fireEvent.change(textarea, { target: { value: 'a'.repeat(160) } });
    expect(screen.queryByText('160/200')).not.toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'a'.repeat(161) } });
    expect(screen.getByText('161/200')).not.toHaveClass(styles.charCounterWarning);

    fireEvent.change(textarea, { target: { value: 'a'.repeat(200) } });
    expect(screen.getByText('200/200')).toHaveClass(styles.charCounterWarning);

    fireEvent.change(textarea, { target: { value: 'a'.repeat(201) } });
    expect(textarea).toHaveValue('a'.repeat(200));
    expect(container.querySelector(`.${styles.charCounter}`)).toHaveTextContent('200/200');
  });

  it('counts an emoji as one character, as the server does', () => {
    const { textarea } = renderInput();

    // 170 emoji are 340 UTF-16 units
    fireEvent.change(textarea, { target: { value: '🔥'.repeat(170) } });
    expect(screen.getByText('170/200')).not.toHaveClass(styles.charCounterWarning);

    fireEvent.change(textarea, { target: { value: '🔥'.repeat(201) } });
    expect(textarea).toHaveValue('🔥'.repeat(200));
    expect(screen.getByText('200/200')).toHaveClass(styles.charCounterWarning);
  });

  it('leaves a full comment unchanged when typing in the middle of it', async () => {
    const user = userEvent.setup();
    const full = `${'a'.repeat(100)}${'🔥'.repeat(100)}`;
    const { textarea } = renderInput();
    fireEvent.change(textarea, { target: { value: full } });

    await user.type(textarea, 'XY', { initialSelectionStart: 50, initialSelectionEnd: 50 });

    expect(textarea).toHaveValue(full);
    expect(screen.getByText('200/200')).toBeInTheDocument();
  });

  it('cuts an overflowing paste to the room left, keeping the text around it', () => {
    const { textarea } = renderInput();
    fireEvent.change(textarea, { target: { value: `${'a'.repeat(95)}${'b'.repeat(100)}` } });

    fireEvent.change(textarea, {
      target: { value: `${'a'.repeat(95)}1234567890${'b'.repeat(100)}` },
    });

    expect(textarea).toHaveValue(`${'a'.repeat(95)}12345${'b'.repeat(100)}`);
  });

  describe('replying', () => {
    const replyTarget = { commentId: 5, username: 'bob' };

    it('shows who is being replied to and focuses the box', () => {
      const { textarea } = renderInput({ replyTarget });

      expect(textarea).toHaveAttribute('placeholder', 'Reply to @bob...');
      expect(screen.getByText(/Replying to/)).toHaveTextContent('Replying to @bob');
      expect(textarea).toHaveFocus();
    });

    it('posts a reply to the target comment', async () => {
      const user = userEvent.setup();
      const { textarea, send, createReply, createComment, onCommentPosted } = renderInput({
        replyTarget,
      });

      await user.type(textarea, 'Thanks!');
      await user.click(send);

      expect(createReply).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20', 5, 'Thanks!');
      expect(createComment).not.toHaveBeenCalled();
      expect(onCommentPosted).toHaveBeenCalledTimes(1);
    });

    it('cancels from the chip', async () => {
      const { onCancelReply } = renderInput({ replyTarget });

      await userEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
      expect(onCancelReply).toHaveBeenCalledTimes(1);
    });

    it('cancels with Escape and claims the key so the sheet stays open', async () => {
      const user = userEvent.setup();
      const escape = watchEscape();
      const { onCancelReply } = renderInput({ replyTarget });

      await user.keyboard('{Escape}');
      escape.stop();

      expect(onCancelReply).toHaveBeenCalledTimes(1);
      expect(escape.claimed).toEqual([true]);
    });

    it('leaves Escape to the sheet when not replying', async () => {
      const user = userEvent.setup();
      const escape = watchEscape();
      const { textarea, onCancelReply } = renderInput();

      await user.click(textarea);
      await user.keyboard('{Escape}');
      escape.stop();

      expect(onCancelReply).not.toHaveBeenCalled();
      expect(escape.claimed).toEqual([false]);
    });
  });

  describe('mentions', () => {
    const suggestions = {
      query: 'ca',
      requestId: 'r-1',
      suggestions: [{ text: 'carol', kind: 'user', score: 1, meta: {} }],
    };

    it('suggests users after "@" and inserts the picked username', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea } = renderInput();

      await user.type(textarea, 'Hey @ca');
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(apiClient.get).toHaveBeenCalledWith('/autocomplete/users?q=ca&limit=5');

      await user.click(screen.getByRole('button', { name: /carol/ }));
      expect(textarea).toHaveValue('Hey @carol ');
      expect(screen.queryByRole('group', { name: 'Mention suggestions' })).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(textarea).toHaveFocus();
      expect((textarea as HTMLTextAreaElement).selectionStart).toBe(11);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: 'nearest',
        behavior: 'smooth',
      });
    });

    it('closes the suggestions on Escape without leaving the box', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea } = renderInput();

      await user.type(textarea, '@ca');
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(screen.getByRole('group', { name: 'Mention suggestions' })).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: 'Mention suggestions' })).toBeNull();
      expect(textarea).toHaveValue('@ca');
    });

    it('stops suggesting once the mention is finished', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea } = renderInput();

      await user.type(textarea, '@ca');
      await act(() => vi.advanceTimersByTimeAsync(300));
      await user.type(textarea, ' ');

      expect(screen.queryByRole('group', { name: 'Mention suggestions' })).toBeNull();
    });

    it('completes a bare "@" when a suggestion is picked right after deleting the query', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea } = renderInput();

      await user.type(textarea, 'Hi @c');
      await act(() => vi.advanceTimersByTimeAsync(300));
      // The previous results stay up until the next debounce settles
      await user.type(textarea, '{Backspace}');
      expect(textarea).toHaveValue('Hi @');

      await user.click(screen.getByRole('button', { name: /carol/ }));
      expect(textarea).toHaveValue('Hi @carol ');
    });

    it('completes the right mention after typing past the limit of a full comment', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea } = renderInput();
      const full = `${'a'.repeat(192)} @caroly`;
      fireEvent.change(textarea, { target: { value: full } });
      await act(() => vi.advanceTimersByTimeAsync(300));

      // Ignored because the comment is full; the mention must still start at its "@"
      await user.type(textarea, 'n');
      expect(textarea).toHaveValue(full);

      await user.click(screen.getByRole('button', { name: /carol/ }));
      expect(textarea).toHaveValue(`${'a'.repeat(192)} @carol `);
    });

    it('inserts a mention that fits the limit exactly', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea } = renderInput();
      // 196 characters: replacing "@ca" with "@carol " makes exactly 200
      fireEvent.change(textarea, { target: { value: `${'a'.repeat(192)} @ca` } });
      await act(() => vi.advanceTimersByTimeAsync(300));

      await user.click(screen.getByRole('button', { name: /carol/ }));

      expect(textarea).toHaveValue(`${'a'.repeat(192)} @carol `);
      expect(screen.getByText('200/200')).toHaveClass(styles.charCounterWarning);
      expect(screen.queryByRole('group', { name: 'Mention suggestions' })).toBeNull();
    });

    it('leaves the text unchanged and shows the limit warning when a mention does not fit', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea } = renderInput();
      // 197 characters: "@carol " would make 201
      const text = `${'a'.repeat(193)} @ca`;
      fireEvent.change(textarea, { target: { value: text } });
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(screen.getByText('197/200')).not.toHaveClass(styles.charCounterWarning);

      await user.click(screen.getByRole('button', { name: /carol/ }));

      expect(textarea).toHaveValue(text);
      expect(screen.getByText('197/200')).toHaveClass(styles.charCounterWarning);
      // The suggestions stay up, so a shorter name can still be picked
      expect(screen.getByRole('group', { name: 'Mention suggestions' })).toBeInTheDocument();

      // The next edit clears the warning
      await user.type(textarea, '{Backspace}');
      expect(screen.getByText('196/200')).not.toHaveClass(styles.charCounterWarning);
    });

    it('drops the limit warning once the comment is posted', async () => {
      apiClient.get.mockResolvedValue(suggestions);
      const user = enableFakeTimers();
      const { textarea, send, createComment } = renderInput();
      fireEvent.change(textarea, { target: { value: `${'a'.repeat(193)} @ca` } });
      await act(() => vi.advanceTimersByTimeAsync(300));
      await user.click(screen.getByRole('button', { name: /carol/ }));

      await user.click(send);
      await act(async () => {});

      expect(createComment).toHaveBeenCalledTimes(1);
      expect(textarea).toHaveValue('');
      expect(screen.queryByText(/\/200$/)).not.toBeInTheDocument();
    });
  });
});
