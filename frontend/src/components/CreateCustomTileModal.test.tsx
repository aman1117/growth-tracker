import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCustomTile } from '../test/fixtures/dashboard';
import CreateCustomTileModalDefault, { CreateCustomTileModal } from './CreateCustomTileModal';

// The theme store (reached through the ui barrel) reads matchMedia when its module loads,
// before the shared setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

type Props = ComponentProps<typeof CreateCustomTileModal>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const guitar = makeCustomTile();

function renderModal(props: Partial<Props> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const allProps: Props = {
    isOpen: true,
    onClose,
    onSave,
    currentTileCount: 0,
    existingTiles: [],
    ...props,
  };
  const view = render(<CreateCustomTileModal {...allProps} />);
  const rerender = (next: Partial<Props>) =>
    view.rerender(<CreateCustomTileModal {...allProps} {...next} />);
  return { user: userEvent.setup(), onClose, onSave, ...view, rerender };
}

const nameInput = () => screen.getByRole('textbox', { name: 'Name' });
const submitButton = (name: 'Create' | 'Save' = 'Create') => screen.getByRole('button', { name });

describe('CreateCustomTileModal', () => {
  beforeEach(() => {
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('is also the default export', () => {
    expect(CreateCustomTileModalDefault).toBe(CreateCustomTileModal);
  });

  it('renders nothing while closed', () => {
    renderModal({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('creating a tile', () => {
    it('opens empty with the default icon and color', () => {
      renderModal({ currentTileCount: 2 });

      expect(screen.getByRole('dialog', { name: 'New custom tile' })).toHaveTextContent(
        'Room for 3 more custom tiles'
      );
      expect(nameInput()).toHaveValue('');
      expect(nameInput()).toHaveAccessibleDescription('0/20');
      expect(screen.getByText('Your tile')).toBeInTheDocument();
      // The default icon (Sparkles) is not one of the picker's choices
      expect(
        within(screen.getByRole('radiogroup', { name: 'Icons' })).queryByRole('radio', {
          checked: true,
        })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Violet' })).toBeChecked();
      expect(submitButton()).toBeDisabled();
    });

    it('uses the singular when one slot is left', () => {
      renderModal({ currentTileCount: 4 });

      expect(screen.getByRole('dialog')).toHaveTextContent('Room for 1 more custom tile');
    });

    it('creates a tile with the chosen name, icon and color', async () => {
      const { user, onSave, onClose } = renderModal();

      await user.type(nameInput(), 'Guitar');
      expect(nameInput()).toHaveAccessibleDescription('6/20');
      expect(screen.getByText('Guitar', { selector: 'span' })).toBeInTheDocument();
      await user.click(screen.getByRole('radio', { name: 'Guitar' }));
      await user.click(screen.getByRole('radio', { name: 'Blue' }));
      await user.click(submitButton());

      expect(onSave).toHaveBeenCalledWith({
        id: expect.stringMatching(UUID_V4),
        name: 'Guitar',
        icon: 'Guitar',
        color: '#3b82f6',
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('trims the name and submits with Enter', async () => {
      const { user, onSave } = renderModal();

      await user.type(nameInput(), '  Piano  {Enter}');

      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Piano' }));
    });

    it('keeps Create disabled for a blank name and explains why on submit', async () => {
      const { user, onSave } = renderModal();

      await user.type(nameInput(), '   ');
      expect(submitButton()).toBeDisabled();

      fireEvent.submit(nameInput().closest('form')!);

      expect(screen.getByRole('alert')).toHaveTextContent('Please enter a name for your tile');
      expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
      expect(onSave).not.toHaveBeenCalled();
    });

    it('caps the name at 20 characters and cuts longer input short', async () => {
      const { user } = renderModal();

      await user.type(nameInput(), 'A very long tile name indeed');
      expect(nameInput()).toHaveValue('A very long tile nam');

      fireEvent.change(nameInput(), { target: { value: 'x'.repeat(21) } });
      expect(nameInput()).toHaveValue('x'.repeat(20));
      expect(nameInput()).toHaveAccessibleDescription('20/20');
    });

    it('counts each emoji as one character: 20 fit and a 21st is not added', async () => {
      const { user, onSave } = renderModal();
      const twentyEmoji = '🎸'.repeat(20);

      await user.type(nameInput(), twentyEmoji);
      expect(nameInput()).toHaveValue(twentyEmoji);
      expect(nameInput()).toHaveAccessibleDescription('20/20');

      await user.type(nameInput(), '🎸');
      expect(nameInput()).toHaveValue(twentyEmoji);
      expect(nameInput()).toHaveAccessibleDescription('20/20');

      await user.click(submitButton());
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: twentyEmoji }));
    });

    it('ignores typing in the middle of a full name', async () => {
      const { user } = renderModal();
      await user.type(nameInput(), 'abcdefghijklmnopqrst');

      await user.type(nameInput(), 'Z', { initialSelectionStart: 5, initialSelectionEnd: 5 });

      expect(nameInput()).toHaveValue('abcdefghijklmnopqrst');
      expect(nameInput()).toHaveAccessibleDescription('20/20');
    });

    it('cuts a paste to the room left, keeping the text after the cursor', async () => {
      const { user } = renderModal();
      await user.type(nameInput(), 'abcdefghijklmno');

      (nameInput() as HTMLInputElement).setSelectionRange(5, 5);
      await user.paste('XXXXXXXXXX');

      expect(nameInput()).toHaveValue('abcdeXXXXXfghijklmno');
      expect(nameInput()).toHaveAccessibleDescription('20/20');
    });

    it('keeps the error when typing past the limit changes nothing', async () => {
      const twenty = 'x'.repeat(20);
      const { user, onSave } = renderModal({ existingTiles: [makeCustomTile({ name: twenty })] });
      await user.type(nameInput(), twenty);
      await user.click(submitButton());
      expect(screen.getByRole('alert')).toHaveTextContent(
        `A tile named "${twenty}" already exists`
      );

      await user.type(nameInput(), 'y');

      expect(nameInput()).toHaveValue(twenty);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it.each([
      ['sleep', '"Sleep" is a built-in tile name'],
      ['READING', '"Reading" is a built-in tile name'],
    ])('rejects the built-in name "%s"', async (name, message) => {
      const { user, onSave } = renderModal();

      await user.type(nameInput(), name);
      await user.click(submitButton());

      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(onSave).not.toHaveBeenCalled();
    });

    it('rejects a duplicate of an existing custom tile, ignoring case', async () => {
      const { user, onSave } = renderModal({ currentTileCount: 1, existingTiles: [guitar] });

      await user.type(nameInput(), 'gUiTaR');
      await user.click(submitButton());

      expect(screen.getByRole('alert')).toHaveTextContent('A tile named "Guitar" already exists');
      expect(onSave).not.toHaveBeenCalled();
    });

    it('clears the error when the name changes', async () => {
      const { user } = renderModal();
      await user.type(nameInput(), 'Sleep');
      await user.click(submitButton());
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await user.type(nameInput(), 'y');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(nameInput()).not.toHaveAttribute('aria-invalid');
    });

    it('enforces the custom tile limit', async () => {
      const { user, onSave } = renderModal({ currentTileCount: 5 });

      expect(screen.getByRole('dialog')).toHaveTextContent("You've reached the 5-tile limit");
      await user.type(nameInput(), 'Chess');
      await user.click(submitButton());

      expect(screen.getByRole('alert')).toHaveTextContent('Maximum of 5 custom tiles allowed');
      expect(onSave).not.toHaveBeenCalled();
    });

    it('starts over when reopened', async () => {
      const { user, rerender } = renderModal();
      await user.type(nameInput(), 'Sleep');
      await user.click(submitButton());

      rerender({ isOpen: false });
      rerender({ isOpen: true });

      expect(nameInput()).toHaveValue('');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('editing a tile', () => {
    it('opens prefilled with the tile and saves changes under the same id', async () => {
      const { user, onSave, onClose } = renderModal({
        existingTile: guitar,
        currentTileCount: 5,
        existingTiles: [guitar],
      });

      expect(screen.getByRole('dialog', { name: 'Edit tile' })).toHaveTextContent(
        'Updates everywhere this tile appears'
      );
      expect(nameInput()).toHaveValue('Guitar');
      expect(screen.getByRole('radio', { name: 'Guitar' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Orange' })).toBeChecked();

      await user.clear(nameInput());
      await user.type(nameInput(), 'Bass');
      await user.click(submitButton('Save'));

      expect(onSave).toHaveBeenCalledWith({ ...guitar, name: 'Bass' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('lets a tile keep its own name', async () => {
      const { user, onSave } = renderModal({ existingTile: guitar, existingTiles: [guitar] });

      await user.click(submitButton('Save'));

      expect(onSave).toHaveBeenCalledWith(guitar);
    });

    it('rejects a saved name longer than the limit', async () => {
      const legacy = makeCustomTile({ name: 'An old, very long tile name' });
      const { user, onSave } = renderModal({ existingTile: legacy, existingTiles: [legacy] });

      await user.click(submitButton('Save'));

      expect(screen.getByRole('alert')).toHaveTextContent('Name cannot exceed 20 characters');
      expect(onSave).not.toHaveBeenCalled();
    });

    it('lets a saved name over the limit be shortened but not lengthened', async () => {
      const legacy = makeCustomTile({ name: 'An old, very long tile name' });
      const { user } = renderModal({ existingTile: legacy, existingTiles: [legacy] });

      await user.type(nameInput(), '{Backspace}');
      expect(nameInput()).toHaveValue('An old, very long tile nam');
      expect(nameInput()).toHaveAccessibleDescription('26/20');

      await user.type(nameInput(), 'e');
      expect(nameInput()).toHaveValue('An old, very long tile nam');
    });

    it('accepts a saved emoji name that is within 20 characters', async () => {
      const emojiTile = makeCustomTile({ name: '🎸'.repeat(15) });
      const { user, onSave } = renderModal({ existingTile: emojiTile, existingTiles: [emojiTile] });

      expect(nameInput()).toHaveAccessibleDescription('15/20');
      await user.click(submitButton('Save'));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledWith(emojiTile);
    });
  });

  it.each([
    [
      'Cancel',
      (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByRole('button', { name: 'Cancel' })),
    ],
    ['Escape', (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
  ])('closes without saving on %s', async (_label, close) => {
    const { user, onClose, onSave } = renderModal();

    await close(user);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
