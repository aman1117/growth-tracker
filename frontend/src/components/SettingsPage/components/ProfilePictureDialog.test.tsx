import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfilePictureDialog } from './ProfilePictureDialog';

function renderDialog(props: Partial<ComponentProps<typeof ProfilePictureDialog>> = {}) {
  const handlers = { onClose: vi.fn(), onUploadClick: vi.fn(), onRemoveClick: vi.fn() };
  render(<ProfilePictureDialog isOpen hasProfilePic={false} {...handlers} {...props} />);
  return { user: userEvent.setup(), ...handlers };
}

describe('ProfilePictureDialog', () => {
  beforeEach(() => {
    // Modal logs overlay-history steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('renders nothing while closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers an upload with the accepted formats when there is no photo', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: 'Profile photo' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Upload a photo\s*JPG, PNG, WebP or HEIC · up to 5 MB$/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove photo/ })).not.toBeInTheDocument();
  });

  it('opens the file picker and closes when uploading', async () => {
    const { user, onUploadClick, onClose } = renderDialog();

    await user.click(screen.getByRole('button', { name: /Upload a photo/ }));

    expect(onUploadClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers to replace or remove an existing photo', async () => {
    const { user, onUploadClick, onRemoveClick } = renderDialog({ hasProfilePic: true });

    await user.click(screen.getByRole('button', { name: /Choose a new photo/ }));
    expect(onUploadClick).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole('button', { name: /^Remove photo\s*Your initial will show instead$/ })
    );
    expect(onRemoveClick).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button', async () => {
    const { user, onClose, onUploadClick } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUploadClick).not.toHaveBeenCalled();
  });
});
