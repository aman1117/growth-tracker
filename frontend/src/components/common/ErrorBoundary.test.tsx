import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FC } from 'react';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { gl } from '../../services/goodlogs';
import { ErrorBoundary, withErrorBoundary } from './ErrorBoundary';
import * as common from './index';

let shouldThrow = true;

/** Throws while `shouldThrow` is set, like a screen hitting a bug. */
function Flaky({ label = 'Recovered content' }: { label?: string }) {
  if (shouldThrow) throw new Error('Kaboom');
  return <p>{label}</p>;
}

describe('ErrorBoundary', () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    shouldThrow = true;
    // React reports caught render errors through console.error
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders its children when nothing goes wrong', () => {
    shouldThrow = false;

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );

    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a friendly fallback with the error details when a child crashes', () => {
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('Error details')).toBeInTheDocument();
    expect(screen.getByText('Kaboom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload Page' })).toBeInTheDocument();
  });

  it('logs the crash locally and to analytics, and notifies onError', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Flaky />
      </ErrorBoundary>
    );

    const info = expect.objectContaining({ componentStack: expect.stringContaining('Flaky') });
    expect(consoleError).toHaveBeenCalledWith(
      'ErrorBoundary caught an error:',
      expect.objectContaining({ message: 'Kaboom' }),
      info
    );
    expect(gl.error).toHaveBeenCalledWith('React render error', {
      metadata: {
        message: 'Kaboom',
        stack: expect.any(String),
        componentStack: expect.stringContaining('Flaky'),
      },
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Kaboom' }), info);
  });

  it('renders a custom fallback instead of the default card', () => {
    render(
      <ErrorBoundary fallback={<p>Custom fallback</p>}>
        <Flaky />
      </ErrorBoundary>
    );

    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('tries rendering the children again on "Try Again"', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );

    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reloads the page on "Reload Page"', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );

    await user.click(screen.getByRole('button', { name: 'Reload Page' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('recovers automatically when its resetKey changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/broken">
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    rerender(
      <ErrorBoundary resetKey="/broken">
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/home">
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });

  it('ignores resetKey changes while healthy', () => {
    shouldThrow = false;
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Flaky label="Page A" />
      </ErrorBoundary>
    );

    rerender(
      <ErrorBoundary resetKey="/b">
        <Flaky label="Page B" />
      </ErrorBoundary>
    );

    expect(screen.getByText('Page B')).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  describe('withErrorBoundary', () => {
    it('wraps a component, forwarding its props', () => {
      shouldThrow = false;
      const Safe = withErrorBoundary(Flaky);

      render(<Safe label="Wrapped content" />);

      expect(screen.getByText('Wrapped content')).toBeInTheDocument();
    });

    it('applies the boundary options', () => {
      const onError = vi.fn();
      const Safe = withErrorBoundary(Flaky, { fallback: <p>Widget unavailable</p>, onError });

      render(<Safe />);

      expect(screen.getByText('Widget unavailable')).toBeInTheDocument();
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('names the wrapper after the wrapped component', () => {
      const Named: FC = () => null;
      Named.displayName = 'FancyWidget';

      expect(withErrorBoundary(Flaky).displayName).toBe('WithErrorBoundary(Flaky)');
      expect(withErrorBoundary(Named).displayName).toBe('WithErrorBoundary(FancyWidget)');
      expect(withErrorBoundary((() => null) as FC).displayName).toBe(
        'WithErrorBoundary(Component)'
      );
    });
  });

  it('is exported from the common components barrel', () => {
    expect(common.ErrorBoundary).toBe(ErrorBoundary);
    expect(common.withErrorBoundary).toBe(withErrorBoundary);
  });
});
