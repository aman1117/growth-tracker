import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, FIXED_TODAY, makeCustomTile } from '../test/fixtures/dashboard';
import { ActivityModal } from './ActivityModal';

// The theme store (reached through the ui barrel) reads matchMedia when its module loads,
// before the shared setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type Props = ComponentProps<typeof ActivityModal>;

const QUARTER_HOUR_HINT = 'Use quarter hours, e.g. 0.25, 1.5 or 8';

function renderModal(props: Partial<Props> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn<Props['onSave']>().mockResolvedValue(undefined);
  const allProps: Props = {
    isOpen: true,
    onClose,
    onSave,
    activityName: 'sleep',
    currentHours: 0,
    date: FIXED_TODAY,
    ...props,
  };
  const view = render(<ActivityModal {...allProps} />);
  const rerender = (next: Partial<Props>) =>
    view.rerender(<ActivityModal {...allProps} {...next} />);
  return { user: userEvent.setup(), onClose, onSave, ...view, rerender };
}

const hoursInput = () => screen.getByRole('textbox', { name: 'Hours' });
const noteInput = () => screen.getByRole('textbox', { name: /Note/ });
const saveButton = () => screen.getByRole('button', { name: /^(Save|Saving…)$/ });

async function typeHours(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.clear(hoursInput());
  if (value) await user.type(hoursInput(), value);
}

describe('ActivityModal', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed or without an activity', () => {
    const { rerender } = renderModal({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender({ isOpen: true, activityName: null });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('opening', () => {
    it('is a dialog titled after the activity and the day', () => {
      renderModal();

      const dialog = screen.getByRole('dialog', { name: 'Log Sleep' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveTextContent('Today');
    });

    it.each([
      ['yesterday', new Date(2026, 4, 14, 9), 'Yesterday'],
      [
        'an older day',
        new Date(2026, 4, 11, 9),
        new Intl.DateTimeFormat(undefined, {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        }).format(new Date(2026, 4, 11, 9)),
      ],
    ])('names %s in the subtitle', (_label, date, subtitle) => {
      renderModal({ date });

      expect(screen.getByRole('dialog')).toHaveTextContent(subtitle);
    });

    it('omits the subtitle without a date', () => {
      renderModal({ date: undefined });

      expect(screen.getByRole('dialog')).not.toHaveTextContent('Today');
    });

    it('prefills and selects the saved hours so typing replaces them', () => {
      renderModal({ currentHours: 7.5, currentNote: 'Slept early' });

      const input = hoursInput() as HTMLInputElement;
      expect(input).toHaveValue('7.5');
      expect(input).toHaveFocus();
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
      expect(noteInput()).toHaveValue('Slept early');
      expect(screen.getByText('11/500')).toBeInTheDocument();
    });

    it('starts empty for an activity without hours', () => {
      renderModal();

      expect(hoursInput()).toHaveValue('');
      expect(noteInput()).toHaveValue('');
    });

    it('titles custom tiles with their name', () => {
      renderModal({
        activityName: 'custom:guitar-1',
        customTiles: [makeCustomTile()],
      });

      expect(screen.getByRole('dialog', { name: 'Log Guitar' })).toBeInTheDocument();
    });

    it('resets the form when reopened for another activity', async () => {
      const { user, rerender } = renderModal({ currentHours: 2 });
      await typeHours(user, '30');
      await user.click(saveButton());
      expect(screen.getByRole('alert')).toBeInTheDocument();

      rerender({ isOpen: false });
      rerender({ isOpen: true, activityName: 'study', currentHours: 1, currentNote: 'Maths' });

      expect(screen.getByRole('dialog', { name: 'Log Study' })).toBeInTheDocument();
      expect(hoursInput()).toHaveValue('1');
      expect(noteInput()).toHaveValue('Maths');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('hours hint', () => {
    it.each([
      [
        'empty, with the day total',
        '',
        { dayTotalHours: 10.5 },
        '13h 30m left to log for this day',
      ],
      ['empty, without the day total', '', {}, QUARTER_HOUR_HINT],
      ['not a number', 'abc', {}, QUARTER_HOUR_HINT],
      ['not a quarter hour', '1.3', {}, QUARTER_HOUR_HINT],
      ['zero', '0', {}, 'Saving 0 clears this activity for the day'],
      ['hours and minutes', '1.5', {}, "That's 1h 30m"],
      ['whole hours', '2', {}, "That's 2h"],
      ['minutes only', '0.75', {}, "That's 45m"],
    ])('describes %s input', async (_label, value, props, hint) => {
      const { user } = renderModal(props);

      await typeHours(user, value);

      expect(hoursInput()).toHaveAccessibleDescription(hint);
    });

    it('warns when the hours would overflow the day, counting this activity’s current hours', async () => {
      const { user } = renderModal({ currentHours: 2, dayTotalHours: 20 });

      await typeHours(user, '6.25');
      expect(hoursInput()).toHaveAccessibleDescription('Only 6h left in this day');

      await typeHours(user, '6');
      expect(hoursInput()).toHaveAccessibleDescription("That's 6h");
    });
  });

  describe('validation', () => {
    it.each(['', '25', '-1', 'abc'])(
      'rejects "%s" as outside 0–24 without saving',
      async (value) => {
        const { user, onSave } = renderModal();

        await typeHours(user, value);
        await user.click(saveButton());

        expect(screen.getByRole('alert')).toHaveTextContent(
          'Please enter a valid number between 0 and 24'
        );
        expect(hoursInput()).toHaveAttribute('aria-invalid', 'true');
        expect(hoursInput()).toHaveAccessibleDescription(
          /Please enter a valid number between 0 and 24/
        );
        expect(onSave).not.toHaveBeenCalled();
      }
    );

    it('requires quarter-hour steps', async () => {
      const { user, onSave } = renderModal();

      await typeHours(user, '1.3');
      await user.click(saveButton());

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Hours must be in increments of 0.25 (e.g., 0.25, 0.5, 0.75)'
      );
      expect(onSave).not.toHaveBeenCalled();
    });

    it('clears the error as soon as the hours change', async () => {
      const { user } = renderModal();
      await user.click(saveButton());
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await user.type(hoursInput(), '1');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(hoursInput()).not.toHaveAttribute('aria-invalid');
    });
  });

  describe('saving', () => {
    it('saves the hours and trimmed note, then closes', async () => {
      const { user, onSave, onClose } = renderModal();

      await typeHours(user, '7.25');
      await user.type(noteInput(), '  Went to bed early  ');
      await user.click(saveButton());

      expect(onSave).toHaveBeenCalledWith(7.25, 'Went to bed early');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a decimal comma', '1,5', 1.5],
      ['zero (clears the activity)', '0', 0],
      ['a full day', '24', 24],
    ])('accepts %s', async (_label, value, expected) => {
      const { user, onSave } = renderModal();

      await typeHours(user, value);
      await user.click(saveButton());

      expect(onSave).toHaveBeenCalledWith(expected, undefined);
    });

    it('submits with Enter from the hours field', async () => {
      const { user, onSave } = renderModal();

      await user.type(hoursInput(), '3{Enter}');

      expect(onSave).toHaveBeenCalledWith(3, undefined);
    });

    it('shows a busy, disabled Save button and ignores repeat submits while saving', async () => {
      const pending = createDeferred<void>();
      const { user, onSave, onClose } = renderModal({ currentHours: 4 });
      onSave.mockReturnValue(pending.promise);

      await user.click(saveButton());

      expect(saveButton()).toHaveTextContent('Saving…');
      expect(saveButton()).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add 15 minutes' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Subtract 15 minutes' })).toBeDisabled();

      fireEvent.submit(hoursInput().closest('form')!);
      expect(onSave).toHaveBeenCalledTimes(1);

      pending.resolve();
      expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps the dialog open with the error when saving fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { user, onSave, onClose } = renderModal({ currentHours: 4 });
      onSave.mockRejectedValue(new Error('Server busy, try again'));

      await user.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('Server busy, try again');
      expect(onClose).not.toHaveBeenCalled();
      expect(saveButton()).toBeEnabled();
      expect(warn).toHaveBeenCalledWith(
        '[ActivityModal] Save failed; keeping the dialog open for retry',
        { activity: 'sleep' }
      );
    });

    it('falls back to a generic message for non-Error failures', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { user, onSave } = renderModal({ currentHours: 4 });
      onSave.mockRejectedValue('nope');

      await user.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save activity');
    });
  });

  describe('quick adjust buttons', () => {
    it('adds and subtracts minutes, snapping to quarter hours', async () => {
      const { user } = renderModal();

      expect(screen.getByRole('button', { name: 'Subtract 15 minutes' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Subtract 30 minutes' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Add 15 minutes' }));
      expect(hoursInput()).toHaveValue('0.25');

      await user.click(screen.getByRole('button', { name: 'Add 30 minutes' }));
      expect(hoursInput()).toHaveValue('0.75');

      await user.click(screen.getByRole('button', { name: 'Subtract 30 minutes' }));
      expect(hoursInput()).toHaveValue('0.25');

      await typeHours(user, '1.3');
      await user.click(screen.getByRole('button', { name: 'Add 15 minutes' }));
      expect(hoursInput()).toHaveValue('1.5');
    });

    it('clamps to a single day', async () => {
      const { user } = renderModal({ currentHours: 23.75 });

      await user.click(screen.getByRole('button', { name: 'Add 30 minutes' }));
      expect(hoursInput()).toHaveValue('24');
      expect(screen.getByRole('button', { name: 'Add 15 minutes' })).toBeDisabled();

      await typeHours(user, '0.25');
      await user.click(screen.getByRole('button', { name: 'Subtract 30 minutes' }));
      expect(hoursInput()).toHaveValue('0');
    });

    it('clears a validation error', async () => {
      const { user } = renderModal();
      await user.click(saveButton());

      await user.click(screen.getByRole('button', { name: 'Add 15 minutes' }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('note', () => {
    it('counts characters and caps the note at 500', () => {
      renderModal();

      fireEvent.change(noteInput(), { target: { value: 'x'.repeat(600) } });

      expect(noteInput()).toHaveValue('x'.repeat(500));
      expect(screen.getByText('500/500')).toBeInTheDocument();
    });

    it('counts each emoji as one character: a note of 500 🔥 fits and is saved', async () => {
      const { user, onSave } = renderModal({ currentHours: 2 });
      const note = '🔥'.repeat(500);

      await user.click(noteInput());
      await user.paste(note);
      expect(noteInput()).toHaveValue(note);
      expect(screen.getByText('500/500')).toBeInTheDocument();

      await user.type(noteInput(), '🔥');
      expect(noteInput()).toHaveValue(note);

      await user.click(saveButton());
      expect(onSave).toHaveBeenCalledWith(2, note);
    });

    it('never cuts an emoji in half at the limit', () => {
      renderModal();

      fireEvent.change(noteInput(), { target: { value: `${'x'.repeat(499)}🔥🔥` } });

      expect(noteInput()).toHaveValue(`${'x'.repeat(499)}🔥`);
      expect(screen.getByText('500/500')).toBeInTheDocument();
    });

    it('ignores typing in the middle of a full note', async () => {
      const { user } = renderModal({ currentNote: 'x'.repeat(500) });

      await user.type(noteInput(), 'Z', { initialSelectionStart: 10, initialSelectionEnd: 10 });

      expect(noteInput()).toHaveValue('x'.repeat(500));
      expect(screen.getByText('500/500')).toBeInTheDocument();
    });

    it('cuts a paste to the room left, keeping the text after the cursor', async () => {
      const { user } = renderModal({ currentNote: '🔥'.repeat(495) });
      await user.click(noteInput());

      // After the fifth emoji: each one is two UTF-16 units but a single character
      (noteInput() as HTMLTextAreaElement).setSelectionRange(10, 10);
      await user.paste('abcdefghij');

      expect(noteInput()).toHaveValue(`${'🔥'.repeat(5)}abcde${'🔥'.repeat(490)}`);
      expect(screen.getByText('500/500')).toBeInTheDocument();
    });

    it('expands a long saved note from the chevron and focuses it', async () => {
      const { user } = renderModal({ currentNote: 'A'.repeat(60) });

      await user.click(screen.getByRole('button', { name: 'Show the full note' }));

      expect(noteInput()).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Show the full note' })).not.toBeInTheDocument();
    });

    it('expands a long note when the field is focused', async () => {
      const { user } = renderModal({ currentNote: 'A'.repeat(60) });

      await user.click(noteInput());

      expect(noteInput()).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Show the full note' })).not.toBeInTheDocument();
    });

    it('offers no chevron for short notes', () => {
      renderModal({ currentNote: 'x'.repeat(50) });

      expect(screen.queryByRole('button', { name: 'Show the full note' })).not.toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it.each([
      [
        'the Cancel button',
        (user: ReturnType<typeof userEvent.setup>) =>
          user.click(screen.getByRole('button', { name: 'Cancel' })),
      ],
      [
        'the Close button',
        (user: ReturnType<typeof userEvent.setup>) =>
          user.click(screen.getByRole('button', { name: 'Close' })),
      ],
      ['Escape', (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    ])('closes without saving from %s', async (_label, close) => {
      const { user, onClose, onSave } = renderModal({ currentHours: 3 });

      await close(user);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
    });
  });
});
