import { describe, expect, it } from 'vitest';

import { VALIDATION, VALIDATION_MESSAGES } from './validation';

describe('VALIDATION', () => {
  it.each(['alice', 'a_b.c', 'user123', '___', 'x.y'])('accepts the username "%s"', (name) => {
    expect(VALIDATION.USERNAME_PATTERN.test(name)).toBe(true);
  });

  it.each(['Alice', 'al ice', 'al-ice', 'émile', 'bob!', ''])(
    'rejects the username "%s"',
    (name) => {
      expect(VALIDATION.USERNAME_PATTERN.test(name)).toBe(false);
    }
  );

  it('keeps the limits the backend enforces', () => {
    expect(VALIDATION).toMatchObject({
      USERNAME_MIN_LENGTH: 3,
      USERNAME_MAX_LENGTH: 20,
      PASSWORD_MIN_LENGTH: 8,
      BIO_MAX_LENGTH: 150,
      NOTE_MAX_LENGTH: 500,
      MAX_FILE_SIZE: 5 * 1024 * 1024,
    });
  });

  it('has a file extension for every accepted image type', () => {
    const extensionsFor: Record<string, string[]> = { jpeg: ['jpg', 'jpeg'] };

    VALIDATION.ALLOWED_IMAGE_TYPES.forEach((type) => {
      const subtype = type.replace('image/', '');
      (extensionsFor[subtype] ?? [subtype]).forEach((extension) =>
        expect(VALIDATION.ALLOWED_IMAGE_EXTENSIONS).toContain(extension)
      );
    });
  });

  it('describes the limits in its error messages', () => {
    expect(VALIDATION_MESSAGES.FILE_SIZE_ERROR).toBe('Image size must be less than 5MB');
    expect(VALIDATION_MESSAGES.PASSWORD_LENGTH_ERROR).toBe(
      'Password must be at least 8 characters'
    );
    ['JPG', 'PNG', 'WebP', 'HEIC'].forEach((format) =>
      expect(VALIDATION_MESSAGES.FILE_TYPE_ERROR).toContain(format)
    );
  });
});
