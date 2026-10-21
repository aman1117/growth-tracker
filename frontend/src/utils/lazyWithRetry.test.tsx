import { act, render, screen } from '@testing-library/react';
import { Component, type ReactNode, Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lazyWithRetry } from './lazyWithRetry';

const RELOAD_FLAG_KEY = 'gt-chunk-reload-at';

function SettingsPage() {
  return <h1>Settings</h1>;
}

const chunkError = (attempt: string) =>
  new TypeError(`Failed to fetch dynamically imported module (${attempt})`);

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children;
  }
}

function renderLazyPage(factory: () => Promise<{ default: typeof SettingsPage }>) {
  const LazySettings = lazyWithRetry(factory, 'SettingsPage');
  render(
    <ErrorBoundary>
      <Suspense fallback={<p>Loading…</p>}>
        <LazySettings />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Lets the retry delay elapse, then switches back to real timers so RTL can wait. */
async function elapseRetryDelay() {
  await act(() => vi.advanceTimersByTimeAsync(500));
  vi.useRealTimers();
}

function stubReload() {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  return reload;
}

const failingTwice = () =>
  vi.fn().mockRejectedValueOnce(chunkError('first')).mockRejectedValueOnce(chunkError('second'));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('lazyWithRetry', () => {
  it('renders the component when the chunk loads', async () => {
    const factory = vi.fn().mockResolvedValue({ default: SettingsPage });

    renderLazyPage(factory);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retries a failed chunk once after a short delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const factory = vi
      .fn()
      .mockRejectedValueOnce(chunkError('first'))
      .mockResolvedValueOnce({ default: SettingsPage });

    renderLazyPage(factory);
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(factory).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith('[lazyWithRetry] Chunk load failed, retrying', {
      chunkName: 'SettingsPage',
    });
  });

  it('reloads the page once to pick up a new build when the retry fails too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const startedAt = Date.now();
    const reload = stubReload();

    renderLazyPage(failingTwice());
    await elapseRetryDelay();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    const reloadedAt = Number(sessionStorage.getItem(RELOAD_FLAG_KEY));
    expect(reloadedAt).toBeGreaterThanOrEqual(startedAt);
    expect(reloadedAt).toBeLessThanOrEqual(Date.now());
    expect(console.warn).toHaveBeenCalledWith(
      '[lazyWithRetry] Reloading to fetch the latest build',
      { chunkName: 'SettingsPage' }
    );
    // Suspense keeps showing the fallback until the reload happens.
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reloads again once the previous reload is older than the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now() - 60_000));
    const reload = stubReload();

    renderLazyPage(failingTwice());
    await elapseRetryDelay();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('shows the error instead of reloading in a loop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now() - 5_000));
    const reload = stubReload();

    renderLazyPage(failingTwice());
    await elapseRetryDelay();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to fetch dynamically imported module (second)'
    );
    expect(reload).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[lazyWithRetry] Chunk load failed permanently', {
      chunkName: 'SettingsPage',
      error: 'Failed to fetch dynamically imported module (second)',
    });
  });

  it('shows the error instead of reloading while offline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const reload = stubReload();

    renderLazyPage(failingTwice());
    await elapseRetryDelay();

    expect(await screen.findByRole('alert')).toHaveTextContent('(second)');
    expect(reload).not.toHaveBeenCalled();
  });

  it('logs the final failure, not the first one, when it is not an Error object', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    stubReload();

    renderLazyPage(
      vi
        .fn()
        .mockRejectedValueOnce('first attempt failed')
        .mockRejectedValueOnce('second attempt failed')
    );
    await elapseRetryDelay();

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith('[lazyWithRetry] Chunk load failed permanently', {
        chunkName: 'SettingsPage',
        error: 'second attempt failed',
      })
    );
  });

  it('still reloads when session storage is unavailable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });
    const reload = stubReload();

    renderLazyPage(failingTwice());
    await elapseRetryDelay();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
