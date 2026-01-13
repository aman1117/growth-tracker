import React, { createContext, useContext, useCallback, useRef, useState } from 'react';

type RefreshHandler = () => Promise<void> | void;

interface RefreshContextValue {
    /** Register a refresh handler for the current page */
    registerRefreshHandler: (handler: RefreshHandler) => void;
    /** Unregister the current refresh handler */
    unregisterRefreshHandler: () => void;
    /** Trigger the registered refresh handler */
    triggerRefresh: () => Promise<void>;
    /** Whether a refresh is currently in progress */
    isRefreshing: boolean;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

/**
 * RefreshProvider - Global context for pull-to-refresh functionality
 * 
 * Provides a way for pages to register their data-fetching functions
 * so the PullToRefresh component can trigger them on pull gesture.
 */
export const RefreshProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const handlerRef = useRef<RefreshHandler | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const registerRefreshHandler = useCallback((handler: RefreshHandler) => {
        handlerRef.current = handler;
    }, []);

    const unregisterRefreshHandler = useCallback(() => {
        handlerRef.current = null;
    }, []);

    const triggerRefresh = useCallback(async () => {
        if (!handlerRef.current || isRefreshing) return;

        setIsRefreshing(true);
        try {
            await handlerRef.current();
        } catch (error) {
            console.error('Refresh failed:', error);
        } finally {
            // Minimum duration for visual feedback
            await new Promise(resolve => setTimeout(resolve, 500));
            setIsRefreshing(false);
        }
    }, [isRefreshing]);

    return (
        <RefreshContext.Provider
            value={{
                registerRefreshHandler,
                unregisterRefreshHandler,
                triggerRefresh,
                isRefreshing,
            }}
        >
            {children}
        </RefreshContext.Provider>
    );
};

/**
 * Hook to access refresh context
 * 
 * Usage in pages:
 * ```tsx
 * const { registerRefreshHandler, unregisterRefreshHandler } = useRefresh();
 * 
 * useEffect(() => {
 *     registerRefreshHandler(loadData);
 *     return () => unregisterRefreshHandler();
 * }, []);
 * ```
 */
export const useRefresh = (): RefreshContextValue => {
    const context = useContext(RefreshContext);
    if (!context) {
        throw new Error('useRefresh must be used within a RefreshProvider');
    }
    return context;
};

/**
 * Hook for optional refresh context (doesn't throw if not in provider)
 * Useful for components that may or may not be within refresh context
 */
export const useRefreshOptional = (): RefreshContextValue | null => {
    return useContext(RefreshContext);
};
