import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, enableFakeTimers, makeSuggestion } from '../../../test/fixtures/ui';
import type { AutocompleteSuggestion } from '../../../types';
import { Autocomplete, type AutocompleteProps } from './Autocomplete';
import styles from './Autocomplete.module.css';

const RESULTS: AutocompleteSuggestion[] = [
  makeSuggestion('alice', {
    userId: 1,
    isVerified: true,
    followersCount: 1500,
    profilePic: 'https://cdn.test/alice.jpg',
  }),
  makeSuggestion('malik', { followersCount: 999 }),
  makeSuggestion('alfred', { followersCount: 2_300_000 }),
  makeSuggestion('bob'),
];

const INITIAL: AutocompleteSuggestion[] = [
  makeSuggestion('recent_rita', { userId: 11 }),
  makeSuggestion('trending_tom', { userId: 12, followersCount: 42 }),
];

type FetchSuggestions = AutocompleteProps['fetchSuggestions'];

function setup(props: Partial<AutocompleteProps> = {}) {
  const user = enableFakeTimers();
  const onSelect = vi.fn();
  const fetchSuggestions = vi.fn<FetchSuggestions>(async () => RESULTS);
  const utils = render(
    <Autocomplete onSelect={onSelect} fetchSuggestions={fetchSuggestions} {...props} />
  );
  return { user, onSelect, fetchSuggestions, input: screen.getByRole('combobox'), ...utils };
}

/** Runs the debounce (and any timers due within `ms`) and settles the resulting promises. */
const advance = (ms = 150) => act(() => vi.advanceTimersByTimeAsync(ms));

const optionTexts = () =>
  screen
    .getAllByRole('option')
    .map((option) => option.querySelector(`.${styles.username}`)?.textContent);

describe('Autocomplete', () => {
  it('renders an accessible, collapsed combobox', () => {
    const { input } = setup();

    expect(input).toHaveAttribute('placeholder', 'Search...');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-haspopup', 'listbox');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input.getAttribute('aria-controls')).toMatch(/^autocomplete-listbox-/);
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('supports a custom placeholder, autofocus and class', () => {
    const { input, container } = setup({
      placeholder: 'Find friends',
      autoFocus: true,
      className: 'search-bar',
    });

    expect(input).toHaveAttribute('placeholder', 'Find friends');
    expect(input).toHaveFocus();
    expect(container.firstElementChild).toHaveClass(styles.container, 'search-bar');
  });

  it('debounces typing and searches once with the trimmed query', async () => {
    const { user, input, fetchSuggestions } = setup();

    await user.type(input, '  al ');
    await advance(149);
    expect(fetchSuggestions).not.toHaveBeenCalled();

    await advance(1);
    expect(fetchSuggestions).toHaveBeenCalledExactlyOnceWith('al', expect.any(AbortSignal));
  });

  it('respects a custom debounce delay', async () => {
    const { user, input, fetchSuggestions } = setup({ debounceMs: 400 });

    await user.type(input, 'al');
    await advance(150);
    expect(fetchSuggestions).not.toHaveBeenCalled();
    await advance(250);
    expect(fetchSuggestions).toHaveBeenCalledTimes(1);
  });

  it('waits for the minimum number of characters', async () => {
    const { user, input, fetchSuggestions } = setup({ minChars: 3 });

    await user.type(input, 'al');
    await advance();
    await user.keyboard('{ArrowDown}');
    expect(fetchSuggestions).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-expanded', 'false');

    await user.type(input, 'i');
    await advance();
    expect(fetchSuggestions).toHaveBeenCalledExactlyOnceWith('ali', expect.any(AbortSignal));
  });

  it('lists users with the match highlighted, verified badges and follower counts', async () => {
    const { user, input } = setup();

    await user.type(input, 'AL');
    await advance();

    const listbox = screen.getByRole('listbox', { name: 'Search suggestions' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(optionTexts()).toEqual(['alice', 'malik', 'alfred', 'bob']);

    const [alice, malik, alfred, bob] = within(listbox).getAllByRole('option');
    expect(alice.querySelector('strong')).toHaveTextContent(/^al$/);
    expect(alice.querySelector('strong')).toHaveClass(styles.highlight);
    expect(within(alice).getByRole('img', { name: 'alice' })).toHaveAttribute(
      'src',
      'https://cdn.test/alice.jpg'
    );
    expect(within(alice).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(alice).toHaveTextContent('1.5K followers');
    expect(malik.querySelector('strong')).toHaveTextContent('al');
    expect(malik).toHaveTextContent('999 followers');
    expect(within(malik).queryByRole('img', { name: 'Verified account' })).not.toBeInTheDocument();
    expect(alfred).toHaveTextContent('2.3M followers');
    expect(bob.querySelector('strong')).not.toBeInTheDocument();
    expect(bob).not.toHaveTextContent('followers');
    screen.getAllByRole('option').forEach((option) => {
      expect(option).toHaveAttribute('aria-selected', 'false');
    });
  });

  it('shows a loading indicator instead of the clear button while searching', async () => {
    const pending = createDeferred<AutocompleteSuggestion[]>();
    const { user, input, fetchSuggestions } = setup();
    fetchSuggestions.mockReturnValue(pending.promise);

    await user.type(input, 'al');
    await advance();
    expect(screen.getByLabelText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();

    await act(async () => pending.resolve(RESULTS));
    expect(screen.queryByLabelText('Loading...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows an error when the search fails and clears it on the next search', async () => {
    const { user, input, fetchSuggestions } = setup();
    fetchSuggestions.mockRejectedValueOnce(new Error('network down'));

    await user.type(input, 'al');
    await advance();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch suggestions');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');

    await user.type(input, 'i');
    await advance();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('ignores aborted requests', async () => {
    const { user, input, fetchSuggestions } = setup();
    fetchSuggestions.mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    );

    await user.type(input, 'al');
    await advance();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('aborts the previous request and ignores its late response', async () => {
    const first = createDeferred<AutocompleteSuggestion[]>();
    const second = createDeferred<AutocompleteSuggestion[]>();
    const { user, input, fetchSuggestions } = setup();
    fetchSuggestions.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    await user.type(input, 'a');
    await advance();
    await user.type(input, 'l');
    await advance();

    const firstSignal = fetchSuggestions.mock.calls[0][1];
    expect(fetchSuggestions).toHaveBeenLastCalledWith('al', expect.any(AbortSignal));
    expect(firstSignal.aborted).toBe(true);

    await act(async () => second.resolve([makeSuggestion('alice')]));
    await act(async () => first.resolve([makeSuggestion('zed')]));

    expect(optionTexts()).toEqual(['alice']);
    expect(screen.queryByLabelText('Loading...')).not.toBeInTheDocument();
  });

  it('only shows "No users found" when the user asks to open an empty result list', async () => {
    const { user, input, fetchSuggestions } = setup();
    fetchSuggestions.mockResolvedValue([]);

    await user.type(input, 'zz');
    await advance();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('status')).toHaveTextContent('No users found');
    expect(input).toHaveAttribute('aria-expanded', 'true');
  });

  describe('keyboard', () => {
    it('moves the active option with the arrow keys, wrapping at both ends', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();
      const options = screen.getAllByRole('option');

      await user.keyboard('{ArrowDown}');
      expect(options[0]).toHaveAttribute('aria-selected', 'true');
      expect(options[0]).toHaveClass(styles.active);
      expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
      expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });

      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(input).toHaveAttribute('aria-activedescendant', options[3].id);
      await user.keyboard('{ArrowDown}');
      expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

      await user.keyboard('{ArrowUp}');
      expect(input).toHaveAttribute('aria-activedescendant', options[3].id);
      await user.keyboard('{ArrowUp}');
      expect(input).toHaveAttribute('aria-activedescendant', options[2].id);
      expect(options[2]).toHaveAttribute('aria-selected', 'true');
      expect(options[3]).toHaveAttribute('aria-selected', 'false');
    });

    it('wraps to the last option when pressing ArrowUp first', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();

      await user.keyboard('{ArrowUp}');
      expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[3].id);
    });

    it('selects the active option with Enter', async () => {
      const { user, input, onSelect } = setup();
      await user.type(input, 'al');
      await advance();

      await user.keyboard('{ArrowUp}{ArrowUp}{Enter}');

      expect(onSelect).toHaveBeenCalledExactlyOnceWith(RESULTS[2]);
      expect(input).toHaveValue('alfred');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'false');
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });

    it('ignores Enter when no option is active', async () => {
      const { user, input, onSelect } = setup();
      await user.type(input, 'al');
      await advance();

      await user.keyboard('{Enter}');

      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('closes the list and leaves the field on Escape', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();

      await user.keyboard('{ArrowDown}{Escape}');

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).not.toHaveFocus();
      expect(input).toHaveValue('al');
    });

    it('closes the list when tabbing away', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();

      await user.tab();

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('mouse and focus', () => {
    it('activates an option on hover and selects it on press', async () => {
      const { user, input, onSelect } = setup();
      await user.type(input, 'al');
      await advance();
      const malik = screen.getAllByRole('option')[1];

      await user.hover(malik);
      expect(malik).toHaveAttribute('aria-selected', 'true');

      await user.click(malik);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(RESULTS[1]);
      expect(input).toHaveValue('malik');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('keeps focus in the field when an option is pressed', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();

      expect(fireEvent.mouseDown(screen.getAllByRole('option')[0])).toBe(false);
      expect(input).toHaveFocus();
    });

    it('does not let list swipes reach the page (pull-to-refresh)', async () => {
      const onPageTouchMove = vi.fn();
      const user = enableFakeTimers();
      render(
        <div onTouchMove={onPageTouchMove}>
          <Autocomplete onSelect={vi.fn()} fetchSuggestions={async () => RESULTS} />
        </div>
      );
      await user.type(screen.getByRole('combobox'), 'al');
      await advance();

      fireEvent.touchMove(screen.getByRole('listbox'), { touches: [{ clientX: 0, clientY: 9 }] });
      expect(onPageTouchMove).not.toHaveBeenCalled();
    });

    it('clears the query and keeps focus in the field', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();

      await user.click(screen.getByRole('button', { name: 'Clear search' }));
      await advance();

      expect(input).toHaveValue('');
      expect(input).toHaveFocus();
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    });

    it('clears the query without flashing "No users found"', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();

      await user.click(screen.getByRole('button', { name: 'Clear search' }));

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'false');

      await advance();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'false');
    });

    it('closes shortly after losing focus and then calls onBlur', async () => {
      const onBlur = vi.fn();
      const { user, input } = setup({ onBlur });
      await user.type(input, 'al');
      await advance();

      act(() => input.blur());
      await advance(149);
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      expect(onBlur).not.toHaveBeenCalled();

      await advance(1);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('stays open when focus comes back before the blur delay ends', async () => {
      const onBlur = vi.fn();
      const { user, input } = setup({ onBlur });
      await user.type(input, 'al');
      await advance();

      act(() => input.blur());
      await advance(100);
      act(() => input.focus());
      await advance(500);

      expect(screen.getByRole('listbox')).toBeInTheDocument();
      expect(onBlur).not.toHaveBeenCalled();
    });

    it('reopens the previous results when the field is focused again', async () => {
      const { user, input } = setup();
      await user.type(input, 'al');
      await advance();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      await user.click(input);
      expect(optionTexts()).toEqual(['alice', 'malik', 'alfred', 'bob']);
    });
  });

  describe('initial suggestions', () => {
    const renderSectionHelpers = vi.fn((_: AutocompleteSuggestion[], inputValue: string) =>
      inputValue
        ? null
        : {
            renderBeforeItem: (index: number) =>
              index === 0 ? <li role="presentation">Recent</li> : null,
            renderAfterItem: (_index: number, suggestion: AutocompleteSuggestion) => (
              <button type="button" aria-label={`Remove ${suggestion.text}`} />
            ),
          }
    );

    it('shows initial suggestions on focus, without highlighting, with section helpers', async () => {
      const { user, input, fetchSuggestions } = setup({
        initialSuggestions: INITIAL,
        renderSectionHelpers,
      });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      await user.click(input);

      expect(optionTexts()).toEqual(['recent_rita', 'trending_tom']);
      expect(screen.getByRole('listbox').querySelector('strong')).not.toBeInTheDocument();
      expect(screen.getByText('Recent')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove recent_rita' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove trending_tom' })).toBeInTheDocument();
      expect(renderSectionHelpers).toHaveBeenCalledWith(INITIAL, '');
      expect(fetchSuggestions).not.toHaveBeenCalled();
    });

    it('replaces them with highlighted search results while typing', async () => {
      const { user, input } = setup({ initialSuggestions: INITIAL, renderSectionHelpers });

      await user.click(input);
      await user.type(input, 'al');
      await advance();

      expect(optionTexts()).toEqual(['alice', 'malik', 'alfred', 'bob']);
      expect(screen.getAllByRole('option')[0].querySelector('strong')).toHaveTextContent('al');
      expect(screen.queryByText('Recent')).not.toBeInTheDocument();
      expect(renderSectionHelpers).toHaveBeenLastCalledWith(RESULTS, 'al');
    });

    it('shows them again after the query is cleared, while the field has focus', async () => {
      const { user, input } = setup({ initialSuggestions: INITIAL, renderSectionHelpers });

      await user.click(input);
      await user.type(input, 'al');
      await advance();
      await user.clear(input);
      await advance();

      expect(optionTexts()).toEqual(['recent_rita', 'trending_tom']);
      expect(screen.getByText('Recent')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'true');
    });

    it('shows them right after "Clear search"', async () => {
      const { user, input } = setup({ initialSuggestions: INITIAL });

      await user.click(input);
      await user.type(input, 'al');
      await advance();
      await user.click(screen.getByRole('button', { name: 'Clear search' }));

      expect(optionTexts()).toEqual(['recent_rita', 'trending_tom']);
      await advance();
      expect(optionTexts()).toEqual(['recent_rita', 'trending_tom']);
      expect(input).toHaveAttribute('aria-expanded', 'true');
      expect(input).toHaveFocus();
    });

    it('keeps them when a search still in flight finishes after the query is cleared', async () => {
      const late = createDeferred<AutocompleteSuggestion[]>();
      const { user, input, fetchSuggestions } = setup({ initialSuggestions: INITIAL });
      fetchSuggestions.mockReturnValueOnce(late.promise);

      await user.click(input);
      await user.type(input, 'al');
      await advance();
      await user.clear(input);
      await advance();
      expect(screen.queryByLabelText('Loading...')).not.toBeInTheDocument();

      await act(async () => late.resolve(RESULTS));
      expect(optionTexts()).toEqual(['recent_rita', 'trending_tom']);
    });

    it('closes once the query is cleared after the field has lost focus', async () => {
      // A debounce shorter than the 150ms blur delay, so the cleared query settles first
      const { user, input } = setup({ initialSuggestions: INITIAL, debounceMs: 50 });

      await user.click(input);
      await user.type(input, 'al');
      await advance();
      act(() => input.blur());
      fireEvent.change(input, { target: { value: '' } });
      await advance(50);

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'false');
    });

    it('shows initial suggestions that arrive while the field is focused', async () => {
      const onSelect = vi.fn();
      const fetchSuggestions = vi.fn<FetchSuggestions>(async () => RESULTS);
      const user = enableFakeTimers();
      const { rerender } = render(
        <Autocomplete onSelect={onSelect} fetchSuggestions={fetchSuggestions} />
      );

      await user.click(screen.getByRole('combobox'));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      rerender(
        <Autocomplete
          onSelect={onSelect}
          fetchSuggestions={fetchSuggestions}
          initialSuggestions={INITIAL}
        />
      );
      expect(optionTexts()).toEqual(['recent_rita', 'trending_tom']);

      await user.click(screen.getAllByRole('option')[1]);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(INITIAL[1]);
    });
  });

  it('cancels the in-flight request and the pending blur when unmounted', async () => {
    const pending = createDeferred<AutocompleteSuggestion[]>();
    const onBlur = vi.fn();
    const { user, input, fetchSuggestions, unmount } = setup({ onBlur });
    fetchSuggestions.mockReturnValue(pending.promise);

    await user.type(input, 'al');
    await advance();
    act(() => input.blur());
    unmount();
    await advance(500);

    expect(fetchSuggestions.mock.calls[0][1].aborted).toBe(true);
    expect(onBlur).not.toHaveBeenCalled();
  });
});
