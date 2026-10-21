import { describe, expect, it, vi } from 'vitest';

/** Re-evaluates the module so it reads the currently stubbed `import.meta.env`. */
async function loadEnv() {
  vi.resetModules();
  return (await import('./env')).env;
}

function stubMode(mode: 'development' | 'production') {
  vi.stubEnv('DEV', mode === 'development');
  vi.stubEnv('PROD', mode === 'production');
}

describe('env', () => {
  it('uses VITE_API_URL when it is set, without warnings', async () => {
    const warn = vi.spyOn(console, 'warn');
    const info = vi.spyOn(console, 'info');
    vi.stubEnv('VITE_API_URL', 'https://staging-api.example.com');

    await expect(loadEnv()).resolves.toMatchObject({
      apiUrl: 'https://staging-api.example.com',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('falls back to the local API in development and warns about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VITE_API_URL', '');
    stubMode('development');

    await expect(loadEnv()).resolves.toMatchObject({
      apiUrl: 'http://localhost:8000',
      isDevelopment: true,
      isProduction: false,
    });
    expect(warn).toHaveBeenCalledWith(
      '[Config] VITE_API_URL not set, using default: http://localhost:8000'
    );
  });

  it('falls back to the production API in production builds', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn');
    vi.stubEnv('VITE_API_URL', '');
    stubMode('production');

    await expect(loadEnv()).resolves.toMatchObject({
      apiUrl: 'https://api.trackgrowth.in',
      isDevelopment: false,
      isProduction: true,
    });
    expect(info).toHaveBeenCalledWith(
      '[Config] VITE_API_URL not set, using production default: https://api.trackgrowth.in'
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('exposes the GoodLogs public key', async () => {
    vi.stubEnv('VITE_GOODLOGS_PUBLIC_KEY', 'gl_pk_123');

    await expect(loadEnv()).resolves.toMatchObject({ goodlogsPublicKey: 'gl_pk_123' });
  });

  it('defaults the GoodLogs public key to an empty string', async () => {
    vi.stubEnv('VITE_GOODLOGS_PUBLIC_KEY', undefined);

    await expect(loadEnv()).resolves.toMatchObject({ goodlogsPublicKey: '' });
  });
});
