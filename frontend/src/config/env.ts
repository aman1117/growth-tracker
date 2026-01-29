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

/**
 * Validated environment configuration
 */
export const env: EnvConfig = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:8000',
  isDevelopment: import.meta.env.DEV,
  isProduction: import.meta.env.PROD,
};

// Validate required environment variables in development
if (env.isDevelopment && !import.meta.env.VITE_API_URL) {
  console.warn('[Config] VITE_API_URL not set, using default: http://localhost:8000');
}
