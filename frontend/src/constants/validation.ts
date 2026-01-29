/**
 * Validation Constants
 *
 * Centralized validation rules and limits used across the application.
 */

export const VALIDATION = {
  // File upload
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB in bytes
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  ALLOWED_IMAGE_EXTENSIONS: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],

  // Password
  PASSWORD_MIN_LENGTH: 8,

  // Bio
  BIO_MAX_LENGTH: 500,

  // Notes
  NOTE_MAX_LENGTH: 500,

  // Username
  USERNAME_MIN_LENGTH: 3,
  USERNAME_MAX_LENGTH: 30,
};

/**
 * Error messages for validation
 */
export const VALIDATION_MESSAGES = {
  FILE_TYPE_ERROR: 'Only JPG, PNG, WebP, and HEIC images are allowed',
  FILE_SIZE_ERROR: `Image size must be less than ${VALIDATION.MAX_FILE_SIZE / (1024 * 1024)}MB`,
  PASSWORD_LENGTH_ERROR: `Password must be at least ${VALIDATION.PASSWORD_MIN_LENGTH} characters`,
} as const;
