/**
 * Environment configuration
 *
 * Centralizes all environment variables in one place with type safety.
 * Uses Vite's import.meta.env for environment variable access.
 */

interface EnvConfig {
  /** Base URL for the API server */
  apiUrl: string;
  /** Whether the app is running in development mode */
  isDevelopment: boolean;
  /** Whether the app is running in production mode */
  isProduction: boolean;
}

const DEFAULT_DEV_API_URL = 'http://localhost:8000';
const DEFAULT_PROD_API_URL = 'https://api.trackgrowth.in';

function resolveApiUrl(): string {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  return import.meta.env.PROD ? DEFAULT_PROD_API_URL : DEFAULT_DEV_API_URL;
}

/**
 * Validated environment configuration
 */
export const env: EnvConfig = {
  apiUrl: resolveApiUrl(),
  isDevelopment: import.meta.env.DEV,
  isProduction: import.meta.env.PROD,
};

// Validate required environment variables in development
if (env.isDevelopment && !import.meta.env.VITE_API_URL) {
  console.warn(`[Config] VITE_API_URL not set, using default: ${DEFAULT_DEV_API_URL}`);
}

if (env.isProduction && !import.meta.env.VITE_API_URL) {
  console.info(`[Config] VITE_API_URL not set, using production default: ${DEFAULT_PROD_API_URL}`);
}
