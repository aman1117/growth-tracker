import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gl } from '../../services/goodlogs';
import { deferred, suggestionUser } from '../../test/fixtures/social';
import { renderWithRouter } from '../../test/utils';
import type { AutocompleteSuggestion } from '../../types/autocomplete';
import UserSearchAutocompleteDefault, { UserSearchAutocomplete } from './UserSearchAutocomplete';

const searchApi = vi.hoisted(() => ({
  getSuggestions: vi.fn(),
  deleteRecentSearch: vi.fn(),
  clearRecentSearches: vi.fn(),
}));
const autocomplete = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, searchApi, userApi: { ...actual.userApi, autocomplete } };
});

const ALICE = suggestionUser({
  id: 11,
  username: 'alice',
  profilePic: 'https://cdn.test/alice.jpg',
  isVerified: true,
  followersCount: 1200,
});
const BRUNO = suggestionUser({ id: 12, username: 'bruno', followersCount: 50 });
const CARLA = suggestionUser({ id: 13, username: 'carla', followersCount: 2_500_000 });

const result = (text: string, userId: number): AutocompleteSuggestion => ({
  text,
  kind: 'user',
  score: 1,
  meta: { userId, followersCount: 10 },
});

function renderSearch(props: Partial<ComponentProps<typeof UserSearchAutocomplete>> = {}) {
  const onSelect = vi.fn();
  const onComplete = vi.fn();
  const view = renderWithRouter(
    <UserSearchAutocomplete onSelect={onSelect} onComplete={onComplete} {...props} />,
    { route: '/search' }
  );
  return { ...view, onSelect, onComplete };
}

const input = () => screen.getByRole('combobox');
const options = () => screen.getAllByRole('option');
const USERNAMES = ['alice', 'bruno', 'carla', 'carol', 'cathy'];
const optionNames = () =>
  options().map((option) => USERNAMES.find((name) => option.textContent?.includes(name)));

/** Focuses the empty search box once the recent/trending suggestions have loaded. */
async function focusEmptySearch(user: UserEvent) {
  await waitFor(() => expect(searchApi.getSuggestions).toHaveBeenCalled());
  await user.click(input());
}

describe('UserSearchAutocomplete', () => {
  beforeEach(() => {
    searchApi.getSuggestions.mockResolvedValue({ recent: [ALICE], trending: [BRUNO, CARLA] });
    searchApi.deleteRecentSearch.mockResolvedValue({ success: true });
    searchApi.clearRecentSearches.mockResolvedValue({ success: true });
    autocomplete.mockResolvedValue({
      query: 'ca',
      requestId: 'req-1',
      suggestions: [result('carol', 21), result('cathy', 22)],
    });
  });

  describe('before typing', () => {
    it('shows recent searches, then trending users, when the field is focused', async () => {
      const { user } = renderSearch();

      await focusEmptySearch(user);

      const listbox = await screen.findByRole('listbox', { name: 'Search suggestions' });
      expect(optionNames()).toEqual(['alice', 'bruno', 'carla']);
      expect(within(listbox).getByText('Recent')).toBeInTheDocument();
      expect(within(listbox).getByText('Trending')).toBeInTheDocument();
      expect(within(listbox).getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
      expect(
        within(options()[0]).getByRole('button', { name: 'Remove alice from recent searches' })
      ).toBeInTheDocument();
      expect(within(options()[1]).queryByRole('button')).not.toBeInTheDocument();
      expect(within(options()[0]).getByText('1.2K followers')).toBeInTheDocument();
      expect(within(options()[0]).getByRole('img', { name: 'Verified account' })).toBeVisible();
      expect(within(options()[2]).getByText('2.5M followers')).toBeInTheDocument();
      expect(input()).toHaveAttribute('aria-expanded', 'true');
      expect(searchApi.getSuggestions).toHaveBeenCalledTimes(1);
    });

    it('shows the suggestions once they arrive if the field is already focused', async () => {
      const suggestions = deferred<unknown>();
      searchApi.getSuggestions.mockReturnValue(suggestions.promise);
      const { user } = renderSearch();
      await user.click(input());
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      await act(async () => suggestions.resolve({ recent: [], trending: [BRUNO] }));

      expect(await screen.findByRole('option', { name: /bruno/ })).toBeInTheDocument();
    });

    it.each([
      ['only trending users', { recent: [], trending: [BRUNO] }, 'Trending', 'Recent'],
      ['only recent searches', { recent: [ALICE], trending: [] }, 'Recent', 'Trending'],
    ])('shows %s under the right heading', async (_label, suggestions, shown, hidden) => {
      searchApi.getSuggestions.mockResolvedValue(suggestions);
      const { user } = renderSearch();

      await focusEmptySearch(user);

      const listbox = await screen.findByRole('listbox');
      expect(within(listbox).getByText(shown)).toBeInTheDocument();
      expect(within(listbox).queryByText(hidden)).not.toBeInTheDocument();
    });

    it('stays closed when there is nothing to suggest', async () => {
      searchApi.getSuggestions.mockResolvedValue({ recent: [], trending: [] });
      const { user } = renderSearch();

      await focusEmptySearch(user);

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('stays closed and logs when suggestions cannot be loaded', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('offline');
      searchApi.getSuggestions.mockRejectedValue(failure);
      const { user } = renderSearch();

      await focusEmptySearch(user);

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith(
        '[UserSearchAutocomplete] Failed to fetch suggestions:',
        failure
      );
    });
  });

  describe('selecting a user', () => {
    it('opens the profile of a recent search and reports the choice', async () => {
      const { user, onSelect, onComplete } = renderSearch();
      await focusEmptySearch(user);

      await user.click(await screen.findByRole('option', { name: /alice/ }));

      expect(onSelect).toHaveBeenCalledWith({
        text: 'alice',
        kind: 'user',
        score: 100,
        meta: {
          userId: 11,
          profilePic: 'https://cdn.test/alice.jpg',
          isVerified: true,
          followersCount: 1200,
        },
      });
      expect(gl.track).toHaveBeenCalledWith('search_result_selected', {
        properties: { username: 'alice' },
      });
      expect(screen.getByTestId('location')).toHaveTextContent('/user/alice');
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(input()).toHaveValue('alice');
    });

    it('ranks trending users below recent searches', async () => {
      const { user, onSelect } = renderSearch();
      await focusEmptySearch(user);

      await user.click(await screen.findByRole('option', { name: /bruno/ }));

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ text: 'bruno', score: 50 }));
    });

    it('can report the choice without navigating', async () => {
      const { user, onSelect, onComplete } = renderSearch({ navigateOnSelect: false });
      await focusEmptySearch(user);

      await user.click(await screen.findByRole('option', { name: /bruno/ }));

      expect(onSelect).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
      expect(screen.getByTestId('location')).toHaveTextContent('/search');
    });

    it('works without any callbacks', async () => {
      const { user } = renderWithRouter(<UserSearchAutocomplete />);
      await focusEmptySearch(user);

      await user.click(await screen.findByRole('option', { name: /bruno/ }));

      expect(screen.getByTestId('location')).toHaveTextContent('/user/bruno');
    });
  });

  describe('typing', () => {
    it('waits for a pause in typing before searching', async () => {
      vi.useFakeTimers();
      renderSearch();
      await act(async () => {});
      act(() => input().focus());

      fireEvent.change(input(), { target: { value: 'c' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      fireEvent.change(input(), { target: { value: 'ca' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(149);
      });
      expect(autocomplete).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(autocomplete).toHaveBeenCalledTimes(1);
      expect(autocomplete).toHaveBeenCalledWith('ca', 12, expect.any(AbortSignal));
      expect(optionNames()).toEqual(['carol', 'cathy']);
      expect(screen.queryByText('Recent')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /from recent searches/ })
      ).not.toBeInTheDocument();
    });

    it('lets the keyboard pick a result', async () => {
      const { user, onSelect } = renderSearch();
      await user.type(input(), 'ca');
      await screen.findByRole('option', { name: /carol/ });

      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(options()[1]).toHaveAttribute('aria-selected', 'true');
      expect(input()).toHaveAttribute('aria-activedescendant', options()[1].id);

      await user.keyboard('{ArrowUp}{Enter}');

      expect(onSelect).toHaveBeenCalledWith(result('carol', 21));
      expect(screen.getByTestId('location')).toHaveTextContent('/user/carol');
    });

    it.each([
      ['an empty result list', { query: 'zz', requestId: 'req-2', suggestions: [] }],
      ['a response without results', { query: 'zz', requestId: 'req-3' }],
    ])('says nobody was found for %s', async (_label, response) => {
      autocomplete.mockResolvedValue(response);
      const { user } = renderSearch();

      await user.type(input(), 'zz');
      await waitFor(() =>
        expect(autocomplete).toHaveBeenCalledWith('zz', 12, expect.any(AbortSignal))
      );
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      await user.keyboard('{ArrowDown}');

      expect(await screen.findByRole('status')).toHaveTextContent('No users found');
    });

    it('treats a failed search as no results and logs it', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('500');
      autocomplete.mockRejectedValue(failure);
      const { user } = renderSearch();

      await user.type(input(), 'ca');

      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          '[UserSearchAutocomplete] Autocomplete failed:',
          failure
        )
      );
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('lets cancelled searches end quietly', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      autocomplete.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const { user } = renderSearch();

      await user.type(input(), 'ca');

      await waitFor(() => expect(autocomplete).toHaveBeenCalled());
      expect(consoleError).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('recent searches', () => {
    it('removes one recent search right away', async () => {
      const { user } = renderSearch();
      await focusEmptySearch(user);

      await user.click(
        await screen.findByRole('button', { name: 'Remove alice from recent searches' })
      );

      expect(optionNames()).toEqual(['bruno', 'carla']);
      expect(screen.queryByText('Recent')).not.toBeInTheDocument();
      expect(searchApi.deleteRecentSearch).toHaveBeenCalledWith(11);
      expect(input()).toHaveFocus();
    });

    it('logs when a recent search cannot be removed on the server', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('offline');
      searchApi.deleteRecentSearch.mockRejectedValue(failure);
      const { user } = renderSearch();
      await focusEmptySearch(user);

      await user.click(
        await screen.findByRole('button', { name: 'Remove alice from recent searches' })
      );

      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          '[UserSearchAutocomplete] Failed to delete recent search:',
          failure
        )
      );
    });

    it('reloads the suggestions when removing a recent search fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      searchApi.deleteRecentSearch.mockRejectedValue(new Error('offline'));
      const reload = deferred<unknown>();
      const { user } = renderSearch();
      await focusEmptySearch(user);
      searchApi.getSuggestions.mockReturnValueOnce(reload.promise);

      await user.click(
        await screen.findByRole('button', { name: 'Remove alice from recent searches' })
      );

      // The optimistic list is dropped while the server copy reloads.
      await waitFor(() => expect(searchApi.getSuggestions).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());

      await act(async () => reload.resolve({ recent: [ALICE], trending: [BRUNO, CARLA] }));

      expect(await screen.findByRole('option', { name: /alice/ })).toBeInTheDocument();
      expect(optionNames()).toEqual(['alice', 'bruno', 'carla']);
    });

    it('clears every recent search after a confirmation', async () => {
      const { user } = renderSearch();
      await focusEmptySearch(user);

      await user.click(await screen.findByRole('button', { name: 'Clear all' }));
      expect(searchApi.clearRecentSearches).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => expect(gl.track).toHaveBeenCalledWith('recent_search_cleared'));
      expect(searchApi.clearRecentSearches).toHaveBeenCalledTimes(1);
      expect(optionNames()).toEqual(['bruno', 'carla']);
      expect(screen.queryByRole('button', { name: /Clear all|Confirm/ })).not.toBeInTheDocument();
    });

    it('logs when recent searches cannot be cleared on the server', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('offline');
      searchApi.clearRecentSearches.mockRejectedValue(failure);
      const { user } = renderSearch();
      await focusEmptySearch(user);

      await user.click(await screen.findByRole('button', { name: 'Clear all' }));
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          '[UserSearchAutocomplete] Failed to clear recent searches:',
          failure
        )
      );
      expect(gl.track).not.toHaveBeenCalledWith('recent_search_cleared');
    });

    it('reloads the suggestions when clearing recent searches fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      searchApi.clearRecentSearches.mockRejectedValue(new Error('offline'));
      const { user } = renderSearch();
      await focusEmptySearch(user);

      await user.click(await screen.findByRole('button', { name: 'Clear all' }));
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(await screen.findByRole('option', { name: /alice/ })).toBeInTheDocument();
      expect(optionNames()).toEqual(['alice', 'bruno', 'carla']);
      expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
      expect(searchApi.getSuggestions).toHaveBeenCalledTimes(2);
    });

    it('asks again when the clear is not confirmed within 3 seconds', async () => {
      vi.useFakeTimers();
      renderSearch();
      await act(async () => {});
      act(() => input().focus());

      fireEvent.mouseDown(screen.getByRole('button', { name: 'Clear all' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2999);
      });
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
      expect(searchApi.clearRecentSearches).not.toHaveBeenCalled();
    });

    it('cancels the pending confirmation timer when unmounted', async () => {
      const { user, unmount } = renderSearch();
      await focusEmptySearch(user);
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await user.click(await screen.findByRole('button', { name: 'Clear all' }));
      const confirmCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 3000);
      const confirmTimer = setTimeoutSpy.mock.results[confirmCall].value;
      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(confirmTimer);
    });
  });

  describe('options', () => {
    it('calls onBlur shortly after the field loses focus', async () => {
      const onBlur = vi.fn();
      const { user } = renderSearch({ onBlur });
      await user.click(input());

      await user.tab();

      await waitFor(() => expect(onBlur).toHaveBeenCalledTimes(1));
    });

    it('supports a custom placeholder, autofocus and class name', () => {
      const { container } = renderSearch({
        placeholder: 'Find friends',
        autoFocus: true,
        className: 'header-search',
      });

      expect(screen.getByPlaceholderText('Find friends')).toHaveFocus();
      expect(container.querySelector('.header-search')).toContainElement(input());
    });

    it('uses a default placeholder', () => {
      renderSearch();

      expect(input()).toHaveAttribute('placeholder', 'Search users...');
    });
  });

  it('is exported as the default export', () => {
    expect(UserSearchAutocompleteDefault).toBe(UserSearchAutocomplete);
  });
});
