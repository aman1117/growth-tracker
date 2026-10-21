import { act, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { isOverlayEntryCurrent } from '../services/overlayHistory';
import { routerWrapper } from '../test/fixtures/core';
import { useOverlayAwareNavigate } from './useOverlayAwareNavigate';

vi.mock('../services/overlayHistory', () => ({ isOverlayEntryCurrent: vi.fn(() => false) }));

const lastNavigation = () => screen.getByTestId('navigation').textContent;

function renderNavigate() {
  return renderHook(() => useOverlayAwareNavigate(), { wrapper: routerWrapper(['/']) }).result;
}

describe('useOverlayAwareNavigate', () => {
  it('pushes a new entry when no overlay owns the current one', () => {
    const navigate = renderNavigate();

    act(() => navigate.current('/user/bob'));

    expect(lastNavigation()).toBe('PUSH /user/bob');
  });

  it("replaces an open overlay's entry so Back skips the closed overlay", () => {
    vi.mocked(isOverlayEntryCurrent).mockReturnValue(true);
    const navigate = renderNavigate();

    act(() => navigate.current('/user/bob?date=2026-10-20'));

    expect(lastNavigation()).toBe('REPLACE /user/bob?date=2026-10-20');
  });

  it.each([
    [true, false, 'PUSH /settings'],
    [false, true, 'REPLACE /settings'],
  ])(
    'lets an explicit replace option win (overlay open: %s, replace: %s)',
    (overlayOpen, replace, expected) => {
      vi.mocked(isOverlayEntryCurrent).mockReturnValue(overlayOpen);
      const navigate = renderNavigate();

      act(() => navigate.current('/settings', { replace }));

      expect(lastNavigation()).toBe(expected);
    }
  );
});
