import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { closeOverlay, createOverlayId, openOverlay } from '../../services/overlayHistory';
import {
  afterOverlayCloses,
  logChallengeFailure,
  OVERLAY_CLOSE_TIMEOUT_MS,
} from './challengeEffects';

describe('logChallengeFailure', () => {
  it('logs the failure with ids, error code and status only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logChallengeFailure('cheer_failed', new ApiError('Not active', 409, 'CHALLENGE_NOT_ACTIVE'), {
      recovery: 'rollback',
      challengeId: 42,
    });

    const metadata = {
      recovery: 'rollback',
      challengeId: 42,
      errorCode: 'CHALLENGE_NOT_ACTIVE',
      status: 409,
    };
    expect(warn).toHaveBeenCalledExactlyOnceWith('[Challenges] cheer_failed', metadata);
    expect(gl.warn).toHaveBeenCalledExactlyOnceWith('challenge_cheer_failed', { metadata });
  });

  it('copes with failures that are not API errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logChallengeFailure('join_failed', 'offline', { recovery: 'show_error' });

    expect(warn).toHaveBeenCalledWith('[Challenges] join_failed', {
      recovery: 'show_error',
      errorCode: undefined,
      status: undefined,
    });
  });
});

describe('afterOverlayCloses', () => {
  beforeEach(() => {
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('runs at once when no overlay owns the current history entry', () => {
    const go = vi.fn();

    afterOverlayCloses(go);

    expect(go).toHaveBeenCalledTimes(1);
  });

  it("waits until the overlay's history entry is gone, then runs once", async () => {
    const id = createOverlayId();
    openOverlay(id, vi.fn());
    const go = vi.fn();

    afterOverlayCloses(go);
    expect(go).not.toHaveBeenCalled();

    closeOverlay(id);
    await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('stops waiting after a while', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openOverlay(createOverlayId(), vi.fn());
    const go = vi.fn();

    afterOverlayCloses(go);
    vi.advanceTimersByTime(OVERLAY_CLOSE_TIMEOUT_MS - 1);
    expect(go).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(go).toHaveBeenCalledTimes(1);
  });
});
