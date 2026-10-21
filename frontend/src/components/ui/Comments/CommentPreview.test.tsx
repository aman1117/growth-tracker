import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCommentStore } from '../../../store/useCommentStore';
import { makeComment } from '../../../test/fixtures/ui';
import type { Comment } from '../../../types/comment';
import { CommentPreview } from './CommentPreview';
import styles from './CommentPreview.module.css';

vi.mock('../../../services/api', () => ({ commentApi: {} }));

const DAY_KEY = 'alice:2026-10-20';
const top = makeComment({ id: 1, author_username: 'bob', body: 'Great day!', like_count: 2 });
const second = makeComment({
  id: 2,
  author_username: 'carol',
  body: 'So proud of you',
  liked_by_me: true,
});

function seedStore(previews?: Comment[]) {
  const actions = {
    fetchPreviewComments: vi.fn(async () => {}),
    likeComment: vi.fn(),
    unlikeComment: vi.fn(),
  };
  useCommentStore.setState({
    ...actions,
    previewsByDay: previews ? { [DAY_KEY]: previews } : {},
  });
  return actions;
}

function renderPreview() {
  const onOpenSheet = vi.fn();
  const utils = render(
    <CommentPreview username="alice" date="2026-10-20" onOpenSheet={onOpenSheet} />
  );
  return { onOpenSheet, ...utils };
}

const previewBy = (author: string, body: string) =>
  screen.getByRole('button', { name: `Comment by ${author}: ${body}` });

describe('CommentPreview', () => {
  let actions: ReturnType<typeof seedStore>;

  beforeEach(() => {
    actions = seedStore([top, second]);
  });

  it('loads the preview comments for the day', () => {
    renderPreview();
    expect(actions.fetchPreviewComments).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20');
  });

  it.each([
    ['not loaded yet', undefined],
    ['empty', []],
  ])('renders nothing when the previews are %s', (_case, previews) => {
    seedStore(previews);
    const { container } = renderPreview();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each comment with its author', () => {
    const { container } = renderPreview();
    const preview = previewBy('bob', 'Great day!');

    expect(container.firstElementChild).toHaveClass(styles.previewSection);
    expect(within(preview).getByText('bob')).toHaveClass(styles.previewUsername);
    expect(within(preview).getByText('Great day!')).toHaveClass(styles.previewBody);
    expect(previewBy('carol', 'So proud of you')).toBeInTheDocument();
  });

  it('opens the comment sheet on click, Enter or Space', async () => {
    const user = userEvent.setup();
    const { onOpenSheet } = renderPreview();
    const preview = previewBy('bob', 'Great day!');

    await user.click(preview);
    expect(onOpenSheet).toHaveBeenCalledTimes(1);

    act(() => preview.focus());
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.keyboard('a');
    expect(onOpenSheet).toHaveBeenCalledTimes(3);
  });

  it('ignores keys pressed on the like button inside a preview', () => {
    const { onOpenSheet } = renderPreview();
    const like = within(previewBy('bob', 'Great day!')).getByRole('button', {
      name: 'Like comment',
    });

    fireEvent.keyDown(like, { key: 'Enter' });
    expect(onOpenSheet).not.toHaveBeenCalled();
  });

  it('likes and unlikes without opening the sheet', async () => {
    const user = userEvent.setup();
    const { onOpenSheet } = renderPreview();

    await user.click(
      within(previewBy('bob', 'Great day!')).getByRole('button', { name: 'Like comment' })
    );
    expect(actions.likeComment).toHaveBeenCalledExactlyOnceWith(1, DAY_KEY);

    const unlike = within(previewBy('carol', 'So proud of you')).getByRole('button', {
      name: 'Unlike comment',
    });
    expect(unlike).toHaveClass(styles.liked);
    await user.click(unlike);
    expect(actions.unlikeComment).toHaveBeenCalledExactlyOnceWith(2, DAY_KEY);

    expect(onOpenSheet).not.toHaveBeenCalled();
  });

  it('updates when the store changes', () => {
    renderPreview();

    act(() =>
      useCommentStore.setState({
        previewsByDay: { [DAY_KEY]: [{ ...top, liked_by_me: true }] },
      })
    );

    expect(screen.getAllByRole('button', { name: /^Comment by/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Unlike comment' })).toBeInTheDocument();
  });
});
