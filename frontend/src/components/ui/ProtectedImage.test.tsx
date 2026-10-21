import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProtectedImage } from './ProtectedImage';

describe('ProtectedImage', () => {
  it('renders the image with its alt text and class', () => {
    render(<ProtectedImage src="https://cdn.test/photo.jpg" alt="Morning run" className="photo" />);
    const image = screen.getByRole('img', { name: 'Morning run' });

    expect(image).toHaveAttribute('src', 'https://cdn.test/photo.jpg');
    expect(image).toHaveClass('photo');
  });

  it('blocks dragging, selection, pointer events and the context menu', () => {
    render(<ProtectedImage src="https://cdn.test/photo.jpg" alt="Photo" />);
    const image = screen.getByRole('img', { name: 'Photo' });

    expect(image).toHaveAttribute('draggable', 'false');
    expect(image).toHaveStyle({ userSelect: 'none', pointerEvents: 'none' });
    expect(fireEvent.contextMenu(image)).toBe(false);
  });

  it('lets callers override the protective styles (e.g. clickable images)', () => {
    render(
      <ProtectedImage
        src="https://cdn.test/photo.jpg"
        alt="Clickable"
        style={{ pointerEvents: 'auto', borderRadius: '8px' }}
      />
    );

    expect(screen.getByRole('img', { name: 'Clickable' })).toHaveStyle({
      pointerEvents: 'auto',
      borderRadius: '8px',
      userSelect: 'none',
    });
  });
});
