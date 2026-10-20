/**
 * useEscapeKey Hook
 *
 * Runs `onEscape` when Escape is pressed, but only for the top-most active
 * overlay. Overlays register in the order they open, so a confirm dialog on
 * top of a panel closes first and the panel stays open.
 *
 * Inner widgets (autocomplete lists, reply chips...) can claim Escape first by
 * calling `preventDefault()` or `stopPropagation()` on their own key handler.
 *
 * @example
 * useEscapeKey(isOpen, onClose);
 */

import { useEffect, useRef } from 'react';

interface EscapeEntry {
  handle: (event: KeyboardEvent) => void;
}

const stack: EscapeEntry[] = [];
let isListening = false;

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  event.preventDefault();
  top.handle(event);
};

const register = (entry: EscapeEntry) => {
  stack.push(entry);
  if (!isListening) {
    document.addEventListener('keydown', handleKeyDown);
    isListening = true;
  }
};

const unregister = (entry: EscapeEntry) => {
  const index = stack.indexOf(entry);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0 && isListening) {
    document.removeEventListener('keydown', handleKeyDown);
    isListening = false;
  }
};

export function useEscapeKey(isActive: boolean, onEscape: (event: KeyboardEvent) => void): void {
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!isActive) return;
    const entry: EscapeEntry = { handle: (event) => onEscapeRef.current(event) };
    register(entry);
    return () => unregister(entry);
  }, [isActive]);
}

export default useEscapeKey;
