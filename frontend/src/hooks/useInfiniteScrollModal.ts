/**
 * useInfiniteScrollModal Hook
 *
 * Shared hook for modal lists with infinite scroll, loading states, and error handling.
 * Used by: FollowListModal, FollowRequestsModal
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseInfiniteScrollModalOptions<T> {
  isOpen: boolean;
  fetchFn: (cursor?: string) => Promise<{
    items: T[];
    nextCursor?: string;
    totalCount?: number;
  }>;
  deps?: React.DependencyList;
}

export interface UseInfiniteScrollModalResult<T> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  totalCount: number;
  hasMore: boolean;
  loadMoreRef: React.RefObject<HTMLDivElement>;
  refetch: () => void;
  removeItem: (id: number) => void;
  updateItem: (id: number, updates: Partial<T>) => void;
}

export function useInfiniteScrollModal<T extends { id: number }>({
  isOpen,
  fetchFn,
  deps = [],
}: UseInfiniteScrollModalOptions<T>): UseInfiniteScrollModalResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const isMountedRef = useRef(true);

  // Track mounted state to prevent updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Fetch data with optional cursor for pagination
  const fetchData = useCallback(
    async (cursor?: string) => {
      if (cursor) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        setItems([]);
        setError(null);
      }

      try {
        const result = await fetchFn(cursor);

        // Prevent state updates if component unmounted or modal closed
        if (!isMountedRef.current) return;

        setItems((prev) => (cursor ? [...prev, ...result.items] : result.items));
        setNextCursor(result.nextCursor);

        if (result.totalCount !== undefined) {
          setTotalCount(result.totalCount);
        } else if (!cursor) {
          setTotalCount(result.items.length);
        }
      } catch (err) {
        // Prevent state updates if component unmounted
        if (!isMountedRef.current) return;

        const message = err instanceof Error ? err.message : 'Failed to load data';
        setError(message);
        console.error('Failed to fetch modal list data:', err);
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [fetchFn]
  );

  // Initial load when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchData();
    } else {
      // Reset state when modal closes
      setItems([]);
      setNextCursor(undefined);
      setTotalCount(0);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, ...deps]);

  // Setup intersection observer for infinite scroll
  useEffect(() => {
    if (!isOpen || !loadMoreRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && nextCursor && !isLoadingMore && !isLoading) {
          fetchData(nextCursor);
        }
      },
      { threshold: 0.1 }
    );

    observerRef.current.observe(loadMoreRef.current);

    return () => {
      observerRef.current?.disconnect();
    };
  }, [isOpen, nextCursor, isLoadingMore, isLoading, fetchData]);

  // Remove an item from the list
  const removeItem = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    setTotalCount((prev) => Math.max(0, prev - 1));
  }, []);

  // Update an item in the list
  const updateItem = useCallback((id: number, updates: Partial<T>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  }, []);

  // Refetch from the beginning
  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return {
    items,
    setItems,
    isLoading,
    isLoadingMore,
    error,
    totalCount,
    hasMore: !!nextCursor,
    loadMoreRef: loadMoreRef as React.RefObject<HTMLDivElement>,
    refetch,
    removeItem,
    updateItem,
  };
}

export default useInfiniteScrollModal;
