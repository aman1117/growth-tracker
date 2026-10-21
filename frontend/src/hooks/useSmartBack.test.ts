import { act, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { routerWrapper } from '../test/fixtures/core';
import { useSmartBack } from './useSmartBack';

const lastNavigation = () => screen.getByTestId('navigation').textContent;

describe('useSmartBack', () => {
  it('returns to the previous in-app screen when there is one', () => {
    window.history.replaceState({ idx: 1 }, '');
    const { result } = renderHook(() => useSmartBack('/settings'), {
      wrapper: routerWrapper(['/', '/user/bob'], 1),
    });

    act(() => result.current());

    expect(lastNavigation()).toBe('POP /');
  });

  it('replaces a deep-linked screen with the fallback route instead of leaving the app', () => {
    window.history.replaceState({ idx: 0 }, '');
    const { result } = renderHook(() => useSmartBack('/settings'), {
      wrapper: routerWrapper(['/user/bob']),
    });

    act(() => result.current());

    expect(lastNavigation()).toBe('REPLACE /settings');
  });

  it('falls back to the home screen by default', () => {
    const { result } = renderHook(() => useSmartBack(), {
      wrapper: routerWrapper(['/analytics?user=bob']),
    });

    act(() => result.current());

    expect(lastNavigation()).toBe('REPLACE /');
  });
});
