/**
 * WebSocket Hook
 *
 * Manages WebSocket connection for real-time notifications with:
 * - Automatic reconnection with exponential backoff
 * - JWT authentication via query parameter
 * - Heartbeat ping/pong handling
 * - Network status awareness
 * - Graceful degradation with REST polling fallback
 */

import { useCallback, useEffect, useRef } from 'react';

import { env } from '../config/env';
import { STORAGE_KEYS } from '../constants';
import { useFollowStore, useNotificationStore, useToastStore } from '../store';
import type { Notification, WSConnectedPayload, WSMessage } from '../types';
import { isFollowMetadata } from '../types/notification';
import { useOfflineStatus } from './useOfflineStatus';

// Reconnection backoff delays (ms)
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = 10;
const FALLBACK_POLL_INTERVAL = 30000; // 30 seconds

// Global singleton WebSocket instance to prevent multiple connections
let globalWs: WebSocket | null = null;
let globalWsConnecting = false;

// WebSocket message types
const WS_TYPES = {
  NOTIFICATION: 'notification',
  CONNECTED: 'connected',
  ERROR: 'error',
  PENDING_DELIVERY: 'pending_delivery',
  PING: 'ping',
  PONG: 'pong',
} as const;

interface UseWebSocketOptions {
  /** Enable the WebSocket connection */
  enabled?: boolean;
  /** Enable fallback polling when WebSocket fails */
  enableFallbackPolling?: boolean;
}

/**
 * Hook for managing WebSocket connection for real-time notifications
 */
export function useWebSocket(options: UseWebSocketOptions = {}) {
  const { enabled = true, enableFallbackPolling = true } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isManualCloseRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});

  const isOffline = useOfflineStatus();

  const { setWSStatus, addNotification, addPendingNotifications, fetchUnreadCount, wsStatus } =
    useNotificationStore();

  const { addToast } = useToastStore();

  const { setRelationship } = useFollowStore();

  /**
   * Get WebSocket URL with auth token
   */
  const getWebSocketUrl = useCallback((): string | null => {
    const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    if (!token) return null;

    // Convert HTTP URL to WebSocket URL
    const baseUrl = env.apiUrl.replace(/^http/, 'ws');
    return `${baseUrl}/api/ws/notifications?token=${encodeURIComponent(token)}`;
  }, []);

  /**
   * Start fallback polling
   */
  const startFallbackPolling = useCallback(() => {
    if (!enableFallbackPolling || pollIntervalRef.current) return;

    console.log('[WS] Starting fallback polling');

    // Initial fetch
    fetchUnreadCount();

    pollIntervalRef.current = setInterval(() => {
      fetchUnreadCount();
    }, FALLBACK_POLL_INTERVAL);
  }, [enableFallbackPolling, fetchUnreadCount]);

  /**
   * Stop fallback polling
   */
  const stopFallbackPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  /**
   * Handle incoming WebSocket messages
   */
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data) as WSMessage;

        switch (message.type) {
          case WS_TYPES.CONNECTED: {
            const payload = message.payload as WSConnectedPayload;
            console.log('[WS] Connected:', payload.connection_id);
            setWSStatus('connected');
            stopFallbackPolling();
            reconnectAttemptRef.current = 0;
            break;
          }

          case WS_TYPES.NOTIFICATION: {
            const notification = message.payload as Notification;
            console.log('[WS] New notification:', notification.id);
            addNotification(notification);
            // Show toast for new notification
            addToast(notification.body || notification.title, 'info', 4000);

            // Update follow relationship state for follow_accepted notifications
            if (
              notification.type === 'follow_accepted' &&
              isFollowMetadata(notification.metadata)
            ) {
              const actorId =
                typeof notification.metadata.actor_id === 'string'
                  ? parseInt(notification.metadata.actor_id, 10)
                  : notification.metadata.actor_id;
              if (actorId) {
                setRelationship(actorId, {
                  following: true,
                  followed_by: true,
                  pending: false,
                  incoming_pending: false,
                  is_mutual: true,
                });
                console.log('[WS] Updated relationship state for user:', actorId);

                // Dispatch event so Dashboard can refresh if viewing this profile
                window.dispatchEvent(
                  new CustomEvent('follow-accepted', {
                    detail: {
                      actorId,
                      actorUsername: notification.metadata.actor_username,
                    },
                  })
                );
              }
            }
            break;
          }

          case WS_TYPES.PENDING_DELIVERY: {
            const pending = message.payload as Notification[];
            console.log('[WS] Pending notifications:', pending.length);
            addPendingNotifications(pending);
            break;
          }

          case WS_TYPES.ERROR: {
            console.error('[WS] Server error:', message.payload);
            break;
          }

          case WS_TYPES.PING: {
            // Send pong response
            if (globalWs?.readyState === WebSocket.OPEN) {
              globalWs.send(JSON.stringify({ type: WS_TYPES.PONG }));
            }
            break;
          }

          default:
            console.log('[WS] Unknown message type:', message.type);
        }
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    },
    [
      setWSStatus,
      addNotification,
      addPendingNotifications,
      stopFallbackPolling,
      addToast,
      setRelationship,
    ]
  );

  /**
   * Schedule reconnection with exponential backoff
   */
  const scheduleReconnect = useCallback(() => {
    if (isManualCloseRef.current || isOffline) return;

    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
      console.log('[WS] Max reconnection attempts reached, switching to polling');
      setWSStatus('disconnected');
      startFallbackPolling();
      return;
    }

    const delayIndex = Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[delayIndex];

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttemptRef.current + 1})`);
    setWSStatus('reconnecting');

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectAttemptRef.current++;
      connectRef.current();
    }, delay);
  }, [isOffline, setWSStatus, startFallbackPolling]);

  /**
   * Connect to WebSocket
   */
  const connect = useCallback(() => {
    // Don't connect if disabled or offline
    if (!enabled || isOffline) return;

    // Use global singleton - if already connected or connecting, just sync the ref
    if (
      globalWs &&
      (globalWs.readyState === WebSocket.OPEN || globalWs.readyState === WebSocket.CONNECTING)
    ) {
      console.log('[WS] Using existing global connection');
      wsRef.current = globalWs;
      if (globalWs.readyState === WebSocket.OPEN) {
        setWSStatus('connected');
      }
      return;
    }

    // Prevent multiple simultaneous connection attempts
    if (globalWsConnecting) {
      console.log('[WS] Connection already in progress, skipping');
      return;
    }

    const url = getWebSocketUrl();
    if (!url) {
      console.log('[WS] No auth token, skipping connection');
      return;
    }

    // Close existing connection if any
    if (globalWs) {
      globalWs.close();
      globalWs = null;
    }

    isManualCloseRef.current = false;
    globalWsConnecting = true;
    setWSStatus('connecting');

    try {
      const ws = new WebSocket(url);
      globalWs = ws;

      ws.onopen = () => {
        console.log('[WS] Connection opened');
        globalWsConnecting = false;
        // Status will be set to 'connected' when we receive the 'connected' message
      };

      ws.onmessage = handleMessage;

      ws.onerror = (error) => {
        console.error('[WS] Connection error:', error);
        globalWsConnecting = false;
      };

      ws.onclose = (event) => {
        console.log('[WS] Connection closed:', event.code, event.reason);
        wsRef.current = null;
        globalWs = null;
        globalWsConnecting = false;

        if (!isManualCloseRef.current) {
          scheduleReconnect();
        } else {
          setWSStatus('disconnected');
        }
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[WS] Failed to create connection:', error);
      globalWsConnecting = false;
      globalWs = null;
      scheduleReconnect();
    }
  }, [enabled, isOffline, getWebSocketUrl, handleMessage, scheduleReconnect, setWSStatus]);

  // Keep connectRef up to date
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  /**
   * Disconnect from WebSocket
   */
  const disconnect = useCallback(() => {
    isManualCloseRef.current = true;
    globalWsConnecting = false;

    // Clear reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close WebSocket
    if (globalWs) {
      globalWs.close();
      globalWs = null;
    }
    wsRef.current = null;

    stopFallbackPolling();
    setWSStatus('disconnected');
    reconnectAttemptRef.current = 0;
  }, [setWSStatus, stopFallbackPolling]);

  /**
   * Manually trigger reconnection
   */
  const reconnect = useCallback(() => {
    disconnect();
    isManualCloseRef.current = false;
    reconnectAttemptRef.current = 0;
    connect();
  }, [connect, disconnect]);

  // Connect when enabled and online
  useEffect(() => {
    if (enabled && !isOffline) {
      connect();
    } else if (isOffline) {
      // When going offline, start polling as fallback
      setWSStatus('disconnected');
      if (enableFallbackPolling) {
        startFallbackPolling();
      }
    }

    // Don't disconnect on unmount - keep the singleton alive
    // This prevents React Strict Mode from killing the connection
    return () => {
      // Only clean up local refs, not the global connection
      stopFallbackPolling();
    };
  }, [
    enabled,
    isOffline,
    connect,
    setWSStatus,
    enableFallbackPolling,
    startFallbackPolling,
    stopFallbackPolling,
  ]);

  // Reconnect when coming back online (only if not already connected)
  useEffect(() => {
    if (!isOffline && enabled && wsStatus === 'disconnected' && !globalWs && !globalWsConnecting) {
      console.log('[WS] Network restored, reconnecting...');
      reconnectAttemptRef.current = 0;
      connect();
    }
  }, [isOffline, enabled, wsStatus, connect]);

  // Fetch initial unread count on mount
  useEffect(() => {
    if (enabled) {
      fetchUnreadCount();
    }
  }, [enabled, fetchUnreadCount]);

  return {
    status: wsStatus,
    isConnected: wsStatus === 'connected',
    isConnecting: wsStatus === 'connecting',
    isReconnecting: wsStatus === 'reconnecting',
    connect,
    disconnect,
    reconnect,
  };
}

export default useWebSocket;
