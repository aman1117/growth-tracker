import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { STORAGE_KEYS } from '../../../constants';
import type { ActivityName } from '../../../types';
import { useDragAndDrop } from './useDragAndDrop';

const dragStart = (id: string) => ({ active: { id } }) as unknown as DragStartEvent;
const dragEnd = (activeId: string, overId: string | null) =>
  ({ active: { id: activeId }, over: overId ? { id: overId } : null }) as unknown as DragEndEvent;

function renderDragAndDrop(initialOrder: ActivityName[] = ['sleep', 'study', 'eating']) {
  return renderHook(() => {
    const [tileOrder, setTileOrder] = useState(initialOrder);
    return { tileOrder, ...useDragAndDrop({ setTileOrder }) };
  });
}

const savedOrder = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.TILE_ORDER) ?? 'null');

describe('useDragAndDrop', () => {
  it('provides pointer, touch and keyboard sensors and starts with nothing dragged', () => {
    const { result } = renderDragAndDrop();

    expect(result.current.sensors).toHaveLength(3);
    expect(result.current.activeDragId).toBeNull();
  });

  it('tracks the dragged tile and clears it on drop', () => {
    const { result } = renderDragAndDrop();

    act(() => result.current.handleDragStart(dragStart('study')));
    expect(result.current.activeDragId).toBe('study');

    act(() => result.current.handleDragEnd(dragEnd('study', null)));
    expect(result.current.activeDragId).toBeNull();
  });

  it('clears the dragged tile and keeps the order when the drag is cancelled', () => {
    const { result } = renderDragAndDrop();

    act(() => result.current.handleDragStart(dragStart('study')));
    act(() => result.current.handleDragCancel());

    expect(result.current.activeDragId).toBeNull();
    expect(result.current.tileOrder).toEqual(['sleep', 'study', 'eating']);
    expect(savedOrder()).toBeNull();
  });

  it('moves the dropped tile to the target position and saves the order', () => {
    const { result } = renderDragAndDrop();

    act(() => result.current.handleDragEnd(dragEnd('sleep', 'eating')));

    expect(result.current.tileOrder).toEqual(['study', 'eating', 'sleep']);
    expect(savedOrder()).toEqual(['study', 'eating', 'sleep']);
  });

  it.each([
    ['dropped outside any tile', 'sleep', null],
    ['dropped on itself', 'sleep', 'sleep'],
    ['the target is not in the order', 'sleep', 'office'],
  ])('keeps the order when %s', (_label, activeId, overId) => {
    const { result } = renderDragAndDrop();

    act(() => result.current.handleDragEnd(dragEnd(activeId, overId)));

    expect(result.current.tileOrder).toEqual(['sleep', 'study', 'eating']);
    expect(savedOrder()).toBeNull();
  });
});
