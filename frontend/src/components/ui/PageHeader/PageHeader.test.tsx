import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PageHeader } from './PageHeader';
import styles from './PageHeader.module.css';

describe('PageHeader', () => {
  it('renders the title as the page h1 without a back button', () => {
    const { container } = render(<PageHeader title="Analytics" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Analytics' })).toHaveClass(styles.title);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass(styles.pageHeader);
  });

  it('can render the title as an h2', () => {
    render(<PageHeader title="Section" headingLevel="h2" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeInTheDocument();
  });

  it('shows a back button that calls onBack', async () => {
    const onBack = vi.fn();
    render(<PageHeader title="@jane" onBack={onBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('uses a custom back label', () => {
    render(<PageHeader title="@jane" onBack={vi.fn()} backLabel="Back to feed" />);
    expect(screen.getByRole('button', { name: 'Back to feed' })).toBeInTheDocument();
  });

  it('renders trailing actions and a custom class', () => {
    const { container } = render(
      <PageHeader
        title="Profile"
        className="sticky"
        actions={<button type="button">Share</button>}
      />
    );

    expect(screen.getByRole('button', { name: 'Share' }).parentElement).toHaveClass(styles.actions);
    expect(container.firstElementChild).toHaveClass('sticky');
  });
});
