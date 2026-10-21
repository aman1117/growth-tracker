import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useEscapeKey } from './useEscapeKey';

const pressEscape = () => fireEvent.keyDown(document.body, { key: 'Escape' });

describe('useEscapeKey', () => {
  it('calls the handler when Escape is pressed and claims the event', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(true, onEscape));

    const notPrevented = pressEscape();

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onEscape.mock.calls[0][0]).toMatchObject({ key: 'Escape' });
    expect(notPrevented).toBe(false);
  });

  it('ignores other keys and inactive overlays', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(false, onEscape));
    const onActiveEscape = vi.fn();
    renderHook(() => useEscapeKey(true, onActiveEscape));

    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onActiveEscape).not.toHaveBeenCalled();

    pressEscape();
    expect(onEscape).not.toHaveBeenCalled();
    expect(onActiveEscape).toHaveBeenCalledTimes(1);
  });

  it('lets inner widgets claim Escape first', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(true, onEscape));
    const input = document.body.appendChild(document.createElement('input'));
    input.addEventListener('keydown', (event) => event.preventDefault());

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onEscape).not.toHaveBeenCalled();
    input.remove();
  });

  it('closes only the top-most overlay, then the one below it', () => {
    const closePanel = vi.fn();
    const closeDialog = vi.fn();
    renderHook(() => useEscapeKey(true, closePanel));
    const dialog = renderHook(() => useEscapeKey(true, closeDialog));

    pressEscape();
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closePanel).not.toHaveBeenCalled();

    dialog.unmount();
    pressEscape();
    expect(closePanel).toHaveBeenCalledTimes(1);
    expect(closeDialog).toHaveBeenCalledTimes(1);
  });

  it('uses the latest handler without re-registering', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useEscapeKey(true, handler), {
      initialProps: { handler: first },
    });

    rerender({ handler: second });
    pressEscape();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops listening when the last overlay deactivates', () => {
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const onEscape = vi.fn();
    const { rerender } = renderHook(({ active }) => useEscapeKey(active, onEscape), {
      initialProps: { active: true },
    });

    rerender({ active: false });
    const notPrevented = pressEscape();

    expect(onEscape).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });
});
