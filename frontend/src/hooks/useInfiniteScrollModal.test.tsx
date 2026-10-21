import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DependencyList } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MockIntersectionObserver } from '../test/browser-mocks';
import useInfiniteScrollModalDefault, {
  useInfiniteScrollModal,
  type UseInfiniteScrollModalOptions,
} from './useInfiniteScrollModal';

interface Person {
  id: number;
  name: string;
}

type Page = Awaited<ReturnType<UseInfiniteScrollModalOptions<Person>['fetchFn']>>;

const alice = { id: 1, name: 'Alice' };
const bob = { id: 2, name: 'Bob' };
const carol = { id: 3, name: 'Carol' };

interface HarnessProps {
  isOpen: boolean;
  fetchFn: (cursor?: string) => Promise<Page>;
  deps?: DependencyList;
}

/** A follower-list modal reduced to what the hook drives. */
function FollowersList({ isOpen, fetchFn, deps }: HarnessProps) {
  const {
    items,
    setItems,
    isLoading,
    isLoadingMore,
    error,
    totalCount,
    hasMore,
    loadMoreRef,
    refetch,
    removeItem,
    updateItem,
  } = useInfiniteScrollModal<Person>({ isOpen, fetchFn, deps });
  return (
    <section>
      {isLoading && <p>Loading…</p>}
      {isLoadingMore && <p>Loading more…</p>}
      {error && <p role="alert">{error}</p>}
      <p>Total: {totalCount}</p>
      {hasMore && <p>More available</p>}
      <ul aria-label="Followers">
        {items.map((person) => (
          <li key={person.id}>{person.name}</li>
        ))}
      </ul>
      <button onClick={refetch}>Refresh</button>
      <button onClick={() => removeItem(1)}>Remove Alice</button>
      <button onClick={() => updateItem(1, { name: 'Alicia' })}>Rename Alice</button>
      <button onClick={() => setItems([])}>Clear</button>
      <div ref={loadMoreRef} />
    </section>
  );
}

let observers: MockIntersectionObserver[];

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class extends MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback);
        observers.push(this);
      }
    }
  );
});

/** Tells the latest observer whether the "load more" sentinel is visible. */
function scrollSentinel(isIntersecting = true) {
  const observer = observers.at(-1);
  if (!observer) throw new Error('No IntersectionObserver was created');
  act(() => observer.callback([{ isIntersecting } as IntersectionObserverEntry], observer));
}

/**
 * Renders the list and waits for its first page. The page can show before React has run the
 * effects of that render, which replace the sentinel's observer with one for the loaded page;
 * React runs them before any new render, so re-rendering makes the latest observer current.
 */
async function renderFirstPage(fetchFn: HarnessProps['fetchFn']) {
  const view = render(<FollowersList isOpen fetchFn={fetchFn} />);
  await screen.findByText('Alice');
  view.rerender(<FollowersList isOpen fetchFn={fetchFn} />);
  return view;
}

const names = () => screen.queryAllByRole('listitem').map((item) => item.textContent);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useInfiniteScrollModal', () => {
  it('loads the first page when the modal opens', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ items: [alice, bob], nextCursor: 'c2', totalCount: 5 });

    render(<FollowersList isOpen fetchFn={fetchFn} />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(names()).toEqual(['Alice', 'Bob']);
    expect(screen.getByText('Total: 5')).toBeInTheDocument();
    expect(screen.getByText('More available')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledWith(undefined);
  });

  it('counts the items when the server sends no total', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ items: [alice, bob] });

    render(<FollowersList isOpen fetchFn={fetchFn} />);

    expect(await screen.findByText('Total: 2')).toBeInTheDocument();
    expect(screen.queryByText('More available')).not.toBeInTheDocument();
  });

  it('does not fetch while closed', () => {
    const fetchFn = vi.fn();

    render(<FollowersList isOpen={false} fetchFn={fetchFn} />);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
  });

  it('appends the next page when the end of the list scrolls into view', async () => {
    const nextPage = deferred<Page>();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [alice, bob], nextCursor: 'c2', totalCount: 3 })
      .mockReturnValueOnce(nextPage.promise);
    await renderFirstPage(fetchFn);

    scrollSentinel();

    expect(fetchFn).toHaveBeenLastCalledWith('c2');
    expect(screen.getByText('Loading more…')).toBeInTheDocument();

    await act(async () => nextPage.resolve({ items: [carol] }));

    expect(names()).toEqual(['Alice', 'Bob', 'Carol']);
    expect(screen.getByText('Total: 3')).toBeInTheDocument();
    expect(screen.queryByText('Loading more…')).not.toBeInTheDocument();
    expect(screen.queryByText('More available')).not.toBeInTheDocument();
  });

  it('only loads more when the sentinel is visible, a next page exists and nothing is loading', async () => {
    const nextPage = deferred<Page>();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [alice], nextCursor: 'c2' })
      .mockReturnValueOnce(nextPage.promise);
    await renderFirstPage(fetchFn);

    scrollSentinel(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    scrollSentinel();
    scrollSentinel();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    await act(async () => nextPage.resolve({ items: [bob] }));
    scrollSentinel();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new Error('Network unavailable'), 'Network unavailable'],
    ['boom', 'Failed to load data'],
  ])('shows an error when loading fails (%s)', async (failure, message) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn().mockRejectedValue(failure);

    render(<FollowersList isOpen fetchFn={fetchFn} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('Failed to fetch modal list data:', failure);
  });

  it('resets everything when the modal closes', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ items: [alice], nextCursor: 'c2', totalCount: 9 });
    const { rerender } = render(<FollowersList isOpen fetchFn={fetchFn} />);
    await screen.findByText('Alice');
    const observer = observers.at(-1);

    rerender(<FollowersList isOpen={false} fetchFn={fetchFn} />);

    expect(names()).toEqual([]);
    expect(screen.getByText('Total: 0')).toBeInTheDocument();
    expect(screen.queryByText('More available')).not.toBeInTheDocument();
    expect(observer?.disconnect).toHaveBeenCalled();
  });

  it('reloads from the start when a dependency changes', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [alice] })
      .mockResolvedValueOnce({ items: [bob] });
    const { rerender } = render(<FollowersList isOpen fetchFn={fetchFn} deps={['followers']} />);
    await screen.findByText('Alice');

    rerender(<FollowersList isOpen fetchFn={fetchFn} deps={['following']} />);

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(names()).toEqual(['Bob']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('lets the modal remove, update, replace and refetch items', async () => {
    const user = userEvent.setup();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ items: [alice, bob], totalCount: 1 })
      .mockResolvedValueOnce({ items: [carol] });
    render(<FollowersList isOpen fetchFn={fetchFn} />);
    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: 'Rename Alice' }));
    expect(names()).toEqual(['Alicia', 'Bob']);

    await user.click(screen.getByRole('button', { name: 'Remove Alice' }));
    expect(names()).toEqual(['Bob']);
    expect(screen.getByText('Total: 0')).toBeInTheDocument();

    // The total never goes negative.
    await user.click(screen.getByRole('button', { name: 'Remove Alice' }));
    expect(screen.getByText('Total: 0')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(names()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Carol')).toBeInTheDocument();
    expect(fetchFn).toHaveBeenLastCalledWith(undefined);
  });

  it('ignores a response that arrives after the modal unmounted', async () => {
    const consoleError = vi.spyOn(console, 'error');
    const page = deferred<Page>();
    const failingPage = deferred<Page>();
    const first = render(<FollowersList isOpen fetchFn={() => page.promise} />);
    const second = render(<FollowersList isOpen fetchFn={() => failingPage.promise} />);

    first.unmount();
    second.unmount();
    await act(async () => {
      page.resolve({ items: [alice] });
      failingPage.reject(new Error('late failure'));
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('is also the default export', () => {
    expect(useInfiniteScrollModalDefault).toBe(useInfiniteScrollModal);
  });
});
