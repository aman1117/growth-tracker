import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Unit-test configuration. It deliberately leaves out vite-plugin-pwa (see vite.config.ts):
// the service worker is not part of unit tests and its virtual module is stubbed below.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'virtual:pwa-register/react': fileURLToPath(
        new URL('./src/test/stubs/pwa-register-react.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Fixed values so a developer's local .env cannot change test behavior.
    env: {
      VITE_API_URL: 'http://localhost:8000',
      VITE_GOODLOGS_PUBLIC_KEY: '',
    },
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // CI fails below these (current coverage is about 99%); keep them in step with the docs
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
