import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../services/api';
import { deferred } from '../../../test/fixtures/settings';
import { BioDialog } from './BioDialog';
import styles from './SettingsDialogs.module.css';

const { post } = vi.hoisted(() => ({
  post: vi.fn<(endpoint: string, body?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  api: { post },
}));

type Props = ComponentProps<typeof BioDialog>;

const GENERIC_ERROR = "Couldn't update your bio. Try again.";

function renderDialog(props: Partial<Props> = {}) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const element = (overrides: Partial<Props> = {}) => (
    <BioDialog
      isOpen
      onClose={onClose}
      currentBio="Reading every day"
      onSuccess={onSuccess}
      {...props}
      {...overrides}
    />
  );
  const view = render(element());
  return {
    user,
    onClose,
    onSuccess,
    rerenderWith: (overrides: Partial<Props>) => view.rerender(element(overrides)),
    textbox: () => screen.getByRole('textbox', { name: 'Bio' }),
    save: () => screen.getByRole('button', { name: 'Save' }),
  };
}

describe('BioDialog', () => {
  beforeEach(() => {
    post.mockReset();
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on the saved bio with a usage counter', () => {
    const { textbox } = renderDialog({ currentBio: 'Hello' });

    expect(screen.getByRole('dialog', { name: 'Edit bio' })).toBeInTheDocument();
    expect(textbox()).toHaveValue('Hello');
    expect(textbox()).toHaveFocus();
    expect(screen.getByText('5/150')).toBeInTheDocument();
    expect(textbox()).toHaveAccessibleDescription('');
  });

  it('counts an emoji as one character, like the server', async () => {
    const { user, textbox } = renderDialog({ currentBio: '' });

    await user.click(textbox());
    await user.paste('Reading 📚');

    expect(screen.getByText('9/150')).toBeInTheDocument();
    expect(textbox()).toHaveAccessibleDescription('');
  });

  it.each(['é', '🔥'])(
    'accepts a bio of exactly 150 %s characters at 150/150 and clamps the 151st',
    async (char) => {
      post.mockResolvedValue({ success: true, bio: char.repeat(150) });
      const { user, textbox, save, onSuccess } = renderDialog({ currentBio: '' });
      const counter = (used: number) => screen.getByText(`${used}/150`);

      await user.click(textbox());
      await user.paste(char.repeat(134));
      expect(counter(134)).not.toHaveClass(styles.counterNear);
      expect(counter(134)).not.toHaveClass(styles.counterFull);

      await user.paste(char);
      expect(counter(135)).toHaveClass(styles.counterNear);

      await user.paste(char.repeat(15));
      expect(textbox()).toHaveValue(char.repeat(150));
      expect(counter(150)).toHaveClass(styles.counterFull);

      await user.paste(char);
      expect(textbox()).toHaveValue(char.repeat(150));
      expect(counter(150)).toHaveClass(styles.counterFull);

      await user.click(save());

      expect(post).toHaveBeenCalledWith('/update-bio', { bio: char.repeat(150) });
      await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(char.repeat(150)));
    }
  );

  it('stops at the limit without splitting an emoji', async () => {
    const { user, textbox } = renderDialog({ currentBio: '' });

    await user.click(textbox());
    await user.paste(`${'a'.repeat(149)}📚📚`);

    // Cutting at 150 UTF-16 units would leave half an emoji behind
    expect(textbox()).toHaveValue(`${'a'.repeat(149)}📚`);
    expect(screen.getByText('150/150')).toHaveClass(styles.counterFull);
  });

  it('leaves a full bio unchanged when typing in the middle', async () => {
    const full = `${'a'.repeat(140)}${'🔥'.repeat(10)}`;
    const { user, textbox } = renderDialog({ currentBio: full });

    await user.type(textbox(), 'X', { initialSelectionStart: 70, initialSelectionEnd: 70 });

    expect(textbox()).toHaveValue(full);
    expect(screen.getByText('150/150')).toHaveClass(styles.counterFull);
  });

  it('keeps the existing text and cuts only what is pasted into the middle', async () => {
    const { user, textbox } = renderDialog({ currentBio: 'a'.repeat(148) });

    await user.pointer({ keys: '[MouseLeft]', target: textbox(), offset: 10 });
    await user.paste('🔥🔥🔥');

    expect(textbox()).toHaveValue(`${'a'.repeat(10)}🔥🔥${'a'.repeat(138)}`);
    expect(screen.getByText('150/150')).toHaveClass(styles.counterFull);
  });

  it('saves the trimmed bio and closes', async () => {
    post.mockResolvedValue({ success: true, bio: 'Learning to code' });
    const { user, textbox, save, onSuccess, onClose } = renderDialog();

    await user.clear(textbox());
    await user.type(textbox(), '  Learning to code  ');
    await user.click(save());

    expect(post).toHaveBeenCalledWith('/update-bio', { bio: 'Learning to code' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('Learning to code'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can remove the bio', async () => {
    post.mockResolvedValue({ success: true });
    const { user, textbox, save, onSuccess } = renderDialog();

    await user.clear(textbox());
    await user.click(save());

    expect(post).toHaveBeenCalledWith('/update-bio', { bio: '' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(''));
  });

  it('closes without a request when nothing changed', async () => {
    const { user, textbox, save, onClose } = renderDialog();

    await user.type(textbox(), '   ');
    await user.click(save());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['x', 'é', '🔥'])(
    'refuses to save a bio that is already 151 %s characters long',
    async (char) => {
      const { user, textbox, save } = renderDialog({ currentBio: char.repeat(151) });
      expect(screen.getByText('151/150')).toHaveClass(styles.counterFull);

      await user.click(save());

      expect(screen.getByRole('alert')).toHaveTextContent('Bio must be 150 characters or less');
      expect(textbox()).toHaveAttribute('aria-invalid', 'true');
      expect(post).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'the server rejects the text',
      new ApiError('Bio contains a blocked word', 400, 'INVALID_BIO'),
      'Bio contains a blocked word',
      'INVALID_BIO',
    ],
    ['the server fails', new ApiError('Internal server error', 500), GENERIC_ERROR, 'HTTP_500'],
    ['the network is down', new TypeError('Failed to fetch'), GENERIC_ERROR, undefined],
  ])('explains the failure when %s', async (_label, error, message, code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValue(error);
    const { user, textbox, save, onSuccess, onClose } = renderDialog();

    await user.type(textbox(), '!');
    await user.click(save());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(warn).toHaveBeenCalledWith('[Settings] Bio update failed', { code });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    [{ success: false, error: 'Bio is too long' }, 'Bio is too long'],
    [{ success: false }, GENERIC_ERROR],
  ])('shows why an unsuccessful response was rejected', async (response, message) => {
    post.mockResolvedValue(response);
    const { user, textbox, save } = renderDialog();

    await user.type(textbox(), '!');
    await user.click(save());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('clears the error when the user edits the bio', async () => {
    post.mockResolvedValue({ success: false, error: 'Bio is too long' });
    const { user, textbox, save } = renderDialog();
    await user.type(textbox(), '!');
    await user.click(save());
    await screen.findByRole('alert');

    await user.type(textbox(), '?');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(textbox()).not.toHaveAttribute('aria-invalid');
  });

  it('shows progress and ignores repeat submits while saving', async () => {
    const request = deferred<unknown>();
    post.mockReturnValue(request.promise);
    const { user, textbox, save, onSuccess } = renderDialog();

    await user.type(textbox(), '!');
    await user.click(save());

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.submit(textbox().closest('form')!);
    expect(post).toHaveBeenCalledTimes(1);

    request.resolve({ success: true, bio: 'Reading every day!' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('Reading every day!'));
  });

  it('starts from the saved bio every time it opens', async () => {
    post.mockResolvedValue({ success: false });
    const { user, textbox, save, rerenderWith } = renderDialog();
    await user.type(textbox(), ' and more');
    await user.click(save());
    await screen.findByRole('alert');

    rerenderWith({ isOpen: false });
    rerenderWith({ isOpen: true, currentBio: 'Saved bio' });

    expect(textbox()).toHaveValue('Saved bio');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancels without saving', async () => {
    const { user, textbox, onClose } = renderDialog();

    await user.type(textbox(), ' draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});
