import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import buttonStyles from '../Button/Button.module.css';
import { EmptyState } from './EmptyState';
import styles from './EmptyState.module.css';

describe('EmptyState', () => {
  it('renders the title as a heading with the md size by default', () => {
    const { container } = render(<EmptyState title="No activities yet" />);

    expect(
      screen.getByRole('heading', { level: 3, name: 'No activities yet' })
    ).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass(styles.emptyState, styles.md);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the icon, description and custom class', () => {
    const { container } = render(
      <EmptyState
        icon={<svg data-icon="inbox" />}
        title="Inbox zero"
        description="Nothing to see here."
        size="lg"
        className="page-empty"
      />
    );

    expect(screen.getByText('Nothing to see here.')).toHaveClass(styles.description);
    expect(container.querySelector('[data-icon="inbox"]')?.parentElement).toHaveClass(styles.icon);
    expect(container.firstElementChild).toHaveClass(styles.lg, 'page-empty');
  });

  it('renders a primary action that calls onClick', async () => {
    const onClick = vi.fn();
    render(<EmptyState title="No friends" action={{ label: 'Find people', onClick }} />);

    const action = screen.getByRole('button', { name: 'Find people' });
    expect(action).toHaveClass(buttonStyles.primary, buttonStyles.md);
    await userEvent.click(action);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('uses a small action button and custom variant/icon in the small size', () => {
    render(
      <EmptyState
        size="sm"
        title="No photos"
        action={{
          label: 'Upload',
          onClick: vi.fn(),
          variant: 'secondary',
          icon: <svg aria-hidden="true" data-icon="plus" />,
        }}
      />
    );

    const action = screen.getByRole('button', { name: 'Upload' });
    expect(action).toHaveClass(buttonStyles.secondary, buttonStyles.sm);
    expect(action.querySelector('[data-icon="plus"]')).toBeInTheDocument();
  });
});
