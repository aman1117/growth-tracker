import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { VerifiedBadge } from './VerifiedBadge';

describe('VerifiedBadge', () => {
  it('is an image named "Verified account" with a matching tooltip', () => {
    render(<VerifiedBadge />);
    const badge = screen.getByRole('img', { name: 'Verified account' });

    expect(badge.querySelector('title')).toHaveTextContent('Verified account');
    expect(badge).toHaveAttribute('width', '16');
    expect(badge).toHaveAttribute('height', '16');
  });

  it('supports a custom size, class and title', () => {
    render(<VerifiedBadge size={24} className="inline" title="Official account" />);
    const badge = screen.getByRole('img', { name: 'Official account' });

    expect(badge).toHaveAttribute('width', '24');
    expect(badge).toHaveClass('inline');
  });

  it('gives each instance its own gradient so badges never share fills', () => {
    render(
      <>
        <VerifiedBadge title="first" />
        <VerifiedBadge title="second" />
      </>
    );

    const gradientIds = ['first', 'second'].map((name) => {
      const badge = screen.getByRole('img', { name });
      const id = badge.querySelector('linearGradient')?.id ?? '';
      expect(id).toMatch(/^verified-[a-zA-Z0-9_-]+$/);
      expect(badge.querySelector('path')).toHaveAttribute('fill', `url(#${id})`);
      return id;
    });

    expect(gradientIds[0]).not.toBe(gradientIds[1]);
  });
});
