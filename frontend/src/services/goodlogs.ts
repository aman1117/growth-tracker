/**
 * GoodLogs Analytics Singleton
 *
 * Initializes the GoodLogs SDK for browser analytics and structured logging.
 * Uses the public key (gl_pk_*) — safe for client-side.
 * Disabled in non-production environments to avoid noise during development.
 */

import { GoodLogs } from '@aj-2000-test/goodlogs-sdk';

import { env } from '../config/env';

export const gl = new GoodLogs({
  apiKey: env.goodlogsPublicKey,
  autocapture: true,
  disabled: !env.isProduction || !env.goodlogsPublicKey,
  defaultContext: { service: 'growth-tracker-web' },
  onError: (err: Error) => {
    console.error('[GoodLogs] flush error', err.message);
  },
});
