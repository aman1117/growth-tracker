import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, enableFakeTimers } from '../../../test/fixtures/ui';
import { MentionAutocomplete } from './MentionAutocomplete';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn() } }));
vi.mock('../../../services/api', () => ({ apiClient }));

interface Suggestion {
  text: string;
  kind: string;
  score: number;
  meta: { profilePic?: string; isVerified?: boolean };
}

const CAROL: Suggestion = {
  text: 'carol',
  kind: 'user',
  score: 1,
  meta: { profilePic: 'https://cdn.test/carol.jpg', isVerified: true },
};
const CARLOS: Suggestion = { text: 'carlos', kind: 'user', score: 0.9, meta: {} };

const response = (suggestions: Suggestion[]) => ({ query: 'ca', requestId: 'r-1', suggestions });

function renderMentions(query = 'ca') {
  const user = enableFakeTimers();
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(<MentionAutocomplete query={query} onSelect={onSelect} onClose={onClose} />);
  const rerenderWith = (nextQuery: string) =>
    utils.rerender(<MentionAutocomplete query={nextQuery} onSelect={onSelect} onClose={onClose} />);
  return { user, onSelect, onClose, rerenderWith, ...utils };
}

/** Lets the 300ms debounce elapse and the request settle. */
const settle = (ms = 300) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('MentionAutocomplete', () => {
  it('searches users once the typing pauses', async () => {
    apiClient.get.mockResolvedValue(response([CAROL]));
    // Mounted as soon as "@" is typed, then follows the query as the user types
    const { rerenderWith } = renderMentions('');
    rerenderWith('c');
    await settle(200);
    rerenderWith('ca');

    await settle(299);
    expect(apiClient.get).not.toHaveBeenCalled();
    await settle(1);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith('/autocomplete/users?q=ca&limit=5');
  });

  it('encodes the query', async () => {
    apiClient.get.mockResolvedValue(response([]));
    renderMentions('émile');

    await settle();
    expect(apiClient.get).toHaveBeenCalledWith('/autocomplete/users?q=%C3%A9mile&limit=5');
  });

  it('lists matching users with avatars and verified badges', async () => {
    apiClient.get.mockResolvedValue(response([CAROL, CARLOS]));
    renderMentions();
    await settle();

    const group = screen.getByRole('group', { name: 'Mention suggestions' });
    const [carol, carlos] = within(group).getAllByRole('button');
    expect(carol).toHaveTextContent('carol');
    expect(within(carol).getByRole('img', { name: 'carol' })).toHaveAttribute(
      'src',
      'https://cdn.test/carol.jpg'
    );
    expect(within(carol).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(carlos).toHaveTextContent('carlos');
    expect(within(carlos).queryByRole('img', { name: 'Verified account' })).toBeNull();
  });

  it('picks a user without taking focus from the comment box', async () => {
    apiClient.get.mockResolvedValue(response([CAROL, CARLOS]));
    const { user, onSelect } = renderMentions();
    await settle();
    const carlos = screen.getByRole('button', { name: /carlos/ });

    expect(fireEvent.mouseDown(carlos)).toBe(false);
    await user.click(carlos);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('carlos');
  });

  it.each([
    ['there are no matches', () => apiClient.get.mockResolvedValue(response([]))],
    ['the response has no suggestions', () => apiClient.get.mockResolvedValue({ query: 'ca' })],
    ['the search fails', () => apiClient.get.mockRejectedValue(new Error('offline'))],
  ])('renders nothing when %s', async (_case, arrange) => {
    arrange();
    const { container } = renderMentions();
    await settle();

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not search for an empty query and clears old results', async () => {
    apiClient.get.mockResolvedValue(response([CAROL]));
    const { container, rerenderWith } = renderMentions('');
    await settle();
    expect(apiClient.get).not.toHaveBeenCalled();

    rerenderWith('ca');
    await settle();
    expect(screen.getByRole('group')).toBeInTheDocument();

    rerenderWith('');
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('ignores results for a query the user has already changed', async () => {
    const first = createDeferred<ReturnType<typeof response>>();
    const second = createDeferred<ReturnType<typeof response>>();
    apiClient.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerenderWith } = renderMentions('ca');
    await settle();

    rerenderWith('carl');
    await settle();
    await act(async () => second.resolve(response([CARLOS])));
    await act(async () => first.resolve(response([CAROL])));

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /carlos/ })).toBeInTheDocument();
  });

  it('ignores a late failure for an outdated query', async () => {
    const first = createDeferred<ReturnType<typeof response>>();
    apiClient.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response([CARLOS]));
    const { rerenderWith } = renderMentions('ca');
    await settle();

    rerenderWith('carl');
    await settle();
    await act(async () => first.reject(new Error('timeout')));

    expect(screen.getByRole('button', { name: /carlos/ })).toBeInTheDocument();
  });

  it('closes on Escape only while suggestions are shown', async () => {
    apiClient.get.mockResolvedValue(response([CAROL]));
    const { onClose } = renderMentions();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    await settle();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
