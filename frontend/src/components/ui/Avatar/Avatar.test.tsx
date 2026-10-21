import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Avatar, type AvatarSize } from './Avatar';
import styles from './Avatar.module.css';

const TONE_CLASSES = Array.from({ length: 6 }, (_, i) => styles[`tone${i}`]);

const toneOf = (element: HTMLElement) =>
  TONE_CLASSES.filter((tone) => element.classList.contains(tone));

describe('Avatar', () => {
  it('shows the image with the name as alt text', () => {
    render(<Avatar name="alice" src="https://cdn.test/alice.jpg" />);

    const image = screen.getByRole('img', { name: 'alice' });
    expect(image).toHaveAttribute('src', 'https://cdn.test/alice.jpg');
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('prefers the thumbnail over the full-size image', () => {
    render(
      <Avatar
        name="alice"
        src="https://cdn.test/full.jpg"
        thumbnailSrc="https://cdn.test/thumb.jpg"
      />
    );

    expect(screen.getByRole('img', { name: 'alice' })).toHaveAttribute(
      'src',
      'https://cdn.test/thumb.jpg'
    );
  });

  it.each([undefined, null, ''])('falls back to the uppercase initial when src is %j', (src) => {
    const { container } = render(<Avatar name="bob" src={src} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(toneOf(container.firstElementChild as HTMLElement)).toHaveLength(1);
  });

  it('falls back to initials when the image fails, and retries when the source changes', () => {
    const { rerender } = render(<Avatar name="carol" src="https://cdn.test/broken.jpg" />);

    fireEvent.error(screen.getByRole('img', { name: 'carol' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();

    rerender(<Avatar name="carol" src="https://cdn.test/fixed.jpg" />);
    expect(screen.getByRole('img', { name: 'carol' })).toHaveAttribute(
      'src',
      'https://cdn.test/fixed.jpg'
    );
  });

  it('gives the same name the same fallback tone and only uses tones for initials', () => {
    const first = render(<Avatar name="dana" />).container.firstElementChild as HTMLElement;
    const second = render(<Avatar name="dana" />).container.firstElementChild as HTMLElement;
    const other = render(<Avatar name="a" />).container.firstElementChild as HTMLElement;
    const withImage = render(<Avatar name="dana" src="https://cdn.test/d.jpg" />).container
      .firstElementChild as HTMLElement;

    expect(toneOf(first)).toEqual(toneOf(second));
    expect(toneOf(other)).not.toEqual(toneOf(first));
    expect(toneOf(withImage)).toHaveLength(0);
  });

  it.each<AvatarSize>(['xs', 'sm', 'md', 'lg', 'xl'])('applies the %s size', (size) => {
    const { container } = render(<Avatar name="eve" size={size} />);
    expect(container.firstElementChild).toHaveClass(styles.avatar, styles[size]);
  });

  it('defaults to the md size without click or zoom affordances', () => {
    const { container } = render(<Avatar name="eve" />);
    const avatar = container.firstElementChild;

    expect(avatar).toHaveClass(styles.md);
    expect(avatar).not.toHaveClass(styles.clickable);
    expect(avatar).not.toHaveClass(styles.zoomable);
  });

  it('stays a plain element, out of the Tab order, when it is not clickable', () => {
    const { container } = render(<Avatar name="eve" src="https://cdn.test/e.jpg" />);
    const avatar = container.firstElementChild as HTMLElement;

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(avatar).not.toHaveAttribute('role');
    expect(avatar).not.toHaveAttribute('tabindex');
    expect(avatar).not.toHaveAttribute('aria-label');
    expect(fireEvent.keyDown(avatar, { key: ' ' })).toBe(true);
  });

  it('is a focusable button named after the person when clickable', async () => {
    const onClick = vi.fn();
    render(<Avatar name="frank" onClick={onClick} zoomable className="profile-avatar" />);
    const avatar = screen.getByRole('button', { name: 'frank' });

    expect(avatar).toHaveClass(styles.clickable, styles.zoomable, 'profile-avatar');
    expect(avatar).toHaveAttribute('tabindex', '0');
    await userEvent.click(screen.getByText('F'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates with Enter and Space, without scrolling the page', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Avatar name="frank" src="https://cdn.test/f.jpg" onClick={onClick} />);
    const avatar = screen.getByRole('button', { name: 'frank' });

    await user.tab();
    expect(avatar).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.keyboard('a');
    expect(onClick).toHaveBeenCalledTimes(2);

    expect(fireEvent.keyDown(avatar, { key: ' ' })).toBe(false);
    expect(fireEvent.keyDown(avatar, { key: 'a' })).toBe(true);
  });

  it('protects the image from dragging, selection and the context menu', () => {
    render(<Avatar name="gina" src="https://cdn.test/g.jpg" />);
    const image = screen.getByRole('img', { name: 'gina' });

    expect(image).toHaveAttribute('draggable', 'false');
    expect(image).toHaveStyle({ userSelect: 'none' });
    expect(fireEvent.contextMenu(image)).toBe(false);
  });
});
