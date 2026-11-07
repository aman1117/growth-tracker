/**
 * Chat logging
 *
 * One place for the direct-message feature's structured logs, so every event is named
 * `chat_<event>` and carries ids, counts and error codes only — never message bodies,
 * usernames or other personal data.
 */

import { getErrorCode, getErrorStatus } from '../utils/challenges';
import { gl } from './goodlogs';

type LogValue = string | number | boolean | null | undefined;

export type ChatLogMetadata = Record<string, LogValue>;

export interface ChatFailureContext extends ChatLogMetadata {
  /** What the app does about it, e.g. "mark_failed", "rollback", "show_retry" */
  recovery: string;
}

export const chatLog = {
  debug(event: string, metadata: ChatLogMetadata = {}): void {
    gl.debug(`chat_${event}`, { metadata });
  },

  info(event: string, metadata: ChatLogMetadata = {}): void {
    gl.info(`chat_${event}`, { metadata });
  },

  /** A failed request or event: tagged in the console and sent as a GoodLogs warning */
  failure(event: string, error: unknown, context: ChatFailureContext): void {
    const metadata: ChatLogMetadata = {
      ...context,
      errorCode: getErrorCode(error),
      status: getErrorStatus(error),
      reason:
        error instanceof Error && getErrorStatus(error) === undefined ? error.name : undefined,
    };
    console.warn(`[Chat] ${event}`, metadata);
    gl.warn(`chat_${event}`, { metadata });
  },
};
