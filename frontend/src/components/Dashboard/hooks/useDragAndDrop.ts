/**
 * useDragAndDrop Hook
 *
 * Manages drag-and-drop functionality for tile reordering using @dnd-kit.
 */

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useState } from 'react';

import type { ActivityName } from '../../../types';
import { saveTileOrder } from '../Dashboard.constants';

interface UseDragAndDropProps {
  setTileOrder: React.Dispatch<React.SetStateAction<ActivityName[]>>;
}

interface UseDragAndDropReturn {
  activeDragId: ActivityName | null;
  sensors: ReturnType<typeof useSensors>;
  handleDragStart: (event: DragStartEvent) => void;
  handleDragEnd: (event: DragEndEvent) => void;
}

export const useDragAndDrop = ({
  setTileOrder,
}: UseDragAndDropProps): UseDragAndDropReturn => {
  const [activeDragId, setActiveDragId] = useState<ActivityName | null>(null);

  // DnD Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as ActivityName);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);

    if (over && active.id !== over.id) {
      setTileOrder((items) => {
        // Find indices in the full tileOrder
        const oldIndex = items.indexOf(active.id as ActivityName);
        const newIndex = items.indexOf(over.id as ActivityName);

        // If both items exist, reorder them
        if (oldIndex !== -1 && newIndex !== -1) {
          const newOrder = arrayMove(items, oldIndex, newIndex);
          saveTileOrder(newOrder);
          return newOrder;
        }
        return items;
      });
    }
  };

  return {
    activeDragId,
    sensors,
    handleDragStart,
    handleDragEnd,
  };
};
