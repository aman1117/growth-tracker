import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { useCommentStore } from '../../../store/useCommentStore';
import { renderWithRouter } from '../../../test/utils';
import { CommentButton, type CommentButtonProps } from './CommentButton';
import styles from './CommentButton.module.css';

vi.mock('../../../services/api', () => ({ commentApi: {}, apiClient: {} }));

const DAY_KEY = 'alice:2026-10-20';

/** Seeds the comment count and stubs the store actions the button and its sheet call. */
function seedStore(count?: number) {
  const actions = {
    fetchCommentCount: vi.fn(async () => {}),
    fetchComments: vi.fn(async () => {}),
  };
  useCommentStore.setState({
    ...actions,
    counts: count === undefined ? {} : { [DAY_KEY]: count },
  });
  return actions;
}

function renderButton(props: Partial<CommentButtonProps> = {}, route = '/user/alice') {
  return renderWithRouter(<CommentButton username="alice" date="2026-10-20" {...props} />, {
    route,
  });
}

const sheet = () => screen.queryByRole('dialog', { name: 'Comments' });

describe('CommentButton', () => {
  it('loads and shows the comment count', () => {
    const { fetchCommentCount } = seedStore(3);
    renderButton();

    expect(fetchCommentCount).toHaveBeenCalledExactlyOnceWith('alice', '2026-10-20');
    expect(screen.getByRole('button', { name: '3 comments' })).toHaveClass(styles.hasComments);
    expect(screen.getByRole('button', { name: 'Open 3 comments' })).toHaveTextContent('3');
    expect(sheet()).not.toBeInTheDocument();
  });

  it.each([
    [undefined, '0 comments', 'Open 0 comments'],
    [1, '1 comment', 'Open 1 comment'],
  ])('labels a count of %s', (count, iconLabel, countLabel) => {
    seedStore(count);
    renderButton();

    expect(screen.getByRole('button', { name: iconLabel })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: countLabel })).toBeInTheDocument();
  });

  it('marks the icon only when there are comments', () => {
    seedStore(0);
    renderButton();

    expect(screen.getByRole('button', { name: '0 comments' })).not.toHaveClass(styles.hasComments);
  });

  it.each(['3 comments', 'Open 3 comments'])(
    'opens the comment sheet from the "%s" button and closes it again',
    async (label) => {
      const { fetchComments } = seedStore(3);
      const { user } = renderButton();

      await user.click(screen.getByRole('button', { name: label }));
      expect(sheet()).toBeInTheDocument();
      expect(fetchComments).toHaveBeenCalledWith('alice', '2026-10-20', 'top', true);

      await user.click(screen.getByRole('button', { name: 'Close comments' }));
      await waitFor(() => expect(sheet()).not.toBeInTheDocument());
    }
  );

  it('keeps clicks from reaching the card underneath', async () => {
    seedStore(2);
    const onCardClick = vi.fn();
    const { user } = renderWithRouter(
      <div onClick={onCardClick}>
        <CommentButton username="alice" date="2026-10-20" renderSheet={false} />
      </div>
    );

    await user.click(screen.getByRole('button', { name: '2 comments' }));
    await user.click(screen.getByRole('button', { name: 'Open 2 comments' }));
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('can hide the count', () => {
    seedStore(4);
    renderButton({ showCount: false });

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '4 comments' })).toBeInTheDocument();
  });

  it.each([
    ['sm', '16'],
    ['md', '20'],
  ] as const)('renders the %s size with a %spx icon', (size, iconSize) => {
    seedStore(1);
    renderButton({ size });
    const icon = screen.getByRole('button', { name: '1 comment' });

    expect(icon.parentElement).toHaveClass(styles.container, styles[size]);
    expect(icon.querySelector('svg')).toHaveAttribute('width', iconSize);
  });

  it('leaves the sheet to the parent when renderSheet is false', async () => {
    seedStore(1);
    const { user } = renderButton({ renderSheet: false });

    await user.click(screen.getByRole('button', { name: '1 comment' }));
    expect(sheet()).not.toBeInTheDocument();
  });

  it('can be controlled by the parent', async () => {
    seedStore(1);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const button = (isOpen: boolean) => (
      <CommentButton
        username="alice"
        date="2026-10-20"
        isOpen={isOpen}
        onOpenChange={onOpenChange}
      />
    );
    const { rerender } = render(button(false), { wrapper: MemoryRouter });

    await user.click(screen.getByRole('button', { name: '1 comment' }));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(sheet()).not.toBeInTheDocument();

    rerender(button(true));
    expect(sheet()).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close comments' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('opens from a ?comments=true deep link and removes the parameter', async () => {
    seedStore(2);
    renderButton({}, '/user/alice?date=2026-10-20&comments=true');

    expect(sheet()).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/user/alice?date=2026-10-20');
    expect(screen.getByTestId('location')).not.toHaveTextContent('comments=true');
  });

  it('ignores other values of the comments parameter', () => {
    seedStore(2);
    renderButton({}, '/user/alice?comments=false');

    expect(sheet()).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/user/alice?comments=false');
  });

  it('shows count updates from the store', () => {
    seedStore(1);
    renderButton();

    act(() => useCommentStore.setState({ counts: { [DAY_KEY]: 5 } }));
    expect(screen.getByRole('button', { name: '5 comments' })).toBeInTheDocument();
  });
});
