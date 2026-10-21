import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { gl } from '../services/goodlogs';
import { OfflineBanner } from './OfflineBanner';
import noticeStyles from './ui/Notice/Notice.module.css';

let online = true;

const goOffline = () =>
  act(() => {
    online = false;
    window.dispatchEvent(new Event('offline'));
  });

const goOnline = () =>
  act(() => {
    online = true;
    window.dispatchEvent(new Event('online'));
  });

// Fake timers drive the fade-out; fireEvent keeps clicks synchronous under them
const dismiss = () => fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));

describe('OfflineBanner', () => {
  beforeEach(() => {
    online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    vi.useFakeTimers();
  });

  it('stays hidden while the connection is fine', () => {
    render(<OfflineBanner />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('warns right away when the app starts offline', () => {
    online = false;
    render(<OfflineBanner />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent("You're offline");
    expect(notice).toHaveTextContent('Some features may be unavailable until you reconnect.');
  });

  it('warns when the connection drops', () => {
    render(<OfflineBanner />);

    goOffline();

    expect(screen.getByRole('status')).toHaveTextContent("You're offline");
    expect(gl.track).toHaveBeenCalledWith('app_went_offline');
  });

  it('confirms the connection is back, then fades out', () => {
    render(<OfflineBanner />);
    goOffline();

    goOnline();
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent("You're back online!");
    expect(notice).not.toHaveClass(noticeStyles.leaving);
    expect(gl.track).toHaveBeenCalledWith('app_came_online');

    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole('status')).toHaveClass(noticeStyles.leaving);

    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays hidden after dismissing the offline warning until the next disconnect', () => {
    render(<OfflineBanner />);
    goOffline();

    dismiss();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    goOnline();
    act(() => vi.advanceTimersByTime(2000));
    goOffline();

    expect(screen.getByRole('status')).toHaveTextContent("You're offline");
  });

  it('fades the "back online" message out early when dismissed', () => {
    render(<OfflineBanner />);
    goOffline();
    goOnline();

    dismiss();
    expect(screen.getByRole('status')).toHaveClass(noticeStyles.leaving);

    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('cancels the fade timers when the connection drops again', () => {
    render(<OfflineBanner />);
    goOffline();
    goOnline();

    act(() => vi.advanceTimersByTime(1000));
    goOffline();
    act(() => vi.advanceTimersByTime(5000));

    expect(screen.getByRole('status')).toHaveTextContent("You're offline");
    expect(screen.getByRole('status')).not.toHaveClass(noticeStyles.leaving);
  });
});
