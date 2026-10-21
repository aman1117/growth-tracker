import { describe, expect, it, vi } from 'vitest';

interface GoodLogsOptions {
  apiKey: string;
  autocapture: boolean;
  disabled: boolean;
  defaultContext: Record<string, string>;
  onError: (err: Error) => void;
}

/** Loads a fresh analytics singleton and returns the options it was created with. */
async function loadOptions() {
  vi.resetModules();
  const { gl } = await import('./goodlogs');
  return (gl as unknown as { options: GoodLogsOptions }).options;
}

function stubProduction(publicKey: string) {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_GOODLOGS_PUBLIC_KEY', publicKey);
}

describe('GoodLogs analytics singleton', () => {
  it('is disabled outside production', async () => {
    vi.stubEnv('VITE_GOODLOGS_PUBLIC_KEY', 'gl_pk_live');

    await expect(loadOptions()).resolves.toMatchObject({
      apiKey: 'gl_pk_live',
      autocapture: true,
      disabled: true,
      defaultContext: { service: 'growth-tracker-web' },
    });
  });

  it('is enabled in production when a public key is configured', async () => {
    stubProduction('gl_pk_live');

    await expect(loadOptions()).resolves.toMatchObject({ apiKey: 'gl_pk_live', disabled: false });
  });

  it('stays disabled in production without a public key', async () => {
    stubProduction('');

    await expect(loadOptions()).resolves.toMatchObject({ disabled: true });
  });

  it('reports flush errors to the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onError } = await loadOptions();

    onError(new Error('quota exceeded'));

    expect(consoleError).toHaveBeenCalledWith('[GoodLogs] flush error', 'quota exceeded');
  });
});
