import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AvatarStack, type AvatarStackPerson } from './AvatarStack';

const person = (id: number, name: string, src: string | null = null): AvatarStackPerson => ({
  id,
  name,
  src,
  thumbnailSrc: null,
});

const PEOPLE = [
  person(1, 'alice', 'alice.jpg'),
  person(2, 'bob'),
  person(3, 'carol'),
  person(4, 'dave'),
  person(5, 'erin'),
];

const stack = (name?: string | RegExp) =>
  name ? screen.getByRole('img', { name }) : screen.getAllByRole('img')[0];

describe('AvatarStack', () => {
  it('shows everyone when they fit, described by name', () => {
    const { container } = render(<AvatarStack people={PEOPLE.slice(0, 3)} />);

    expect(stack('alice, bob and carol')).toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('src', 'alice.jpg');
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('describes one person by name', () => {
    render(<AvatarStack people={[person(2, 'bob')]} />);

    expect(stack('bob')).toBeInTheDocument();
  });

  it('collapses the rest into a "+N" bubble', () => {
    render(<AvatarStack people={PEOPLE} max={3} />);

    expect(stack('alice, bob, carol and 2 others')).toBeInTheDocument();
    expect(screen.queryByText('D')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toHaveAttribute('aria-hidden', 'true');
  });

  it('counts people beyond a preview list', () => {
    render(<AvatarStack people={PEOPLE.slice(0, 2)} total={50} />);

    expect(stack('alice, bob and 48 others')).toBeInTheDocument();
    expect(screen.getByText('+48')).toBeInTheDocument();
  });

  it('says "1 other" for a single extra person', () => {
    render(<AvatarStack people={PEOPLE.slice(0, 2)} max={1} />);

    expect(stack('alice and 1 other')).toBeInTheDocument();
  });

  it.each([
    [1, '1 person'],
    [7, '7 people'],
  ])('counts %s people when no avatar is shown', (total, label) => {
    render(<AvatarStack people={[]} total={total} />);

    expect(stack(label)).toBeInTheDocument();
    expect(screen.getByText(`+${total}`)).toBeInTheDocument();
  });

  it('ignores a total smaller than the list', () => {
    render(<AvatarStack people={PEOPLE.slice(0, 2)} total={1} />);

    expect(stack('alice and bob')).toBeInTheDocument();
  });

  it('renders nothing for an empty group', () => {
    const { container } = render(<AvatarStack people={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('uses a custom label, size and class name', () => {
    render(
      <AvatarStack people={PEOPLE} label="5 participants" size="md" className="custom" max={2.7} />
    );

    const group = stack('5 participants');
    expect(group).toHaveClass('custom');
    expect(group.children).toHaveLength(3);
    expect(group.lastElementChild).toHaveTextContent('+3');
  });

  it('treats a negative maximum as none shown', () => {
    render(<AvatarStack people={PEOPLE.slice(0, 2)} max={-1} />);

    expect(stack('2 people')).toBeInTheDocument();
  });
});
