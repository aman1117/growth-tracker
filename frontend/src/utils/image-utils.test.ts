import { describe, expect, it, vi } from 'vitest';

import { makeFile } from '../test/fixtures/core';
import {
  compressImage,
  compressImageToFile,
  createThumbnailPreview,
  formatDateForAPI,
  isDateWithinUploadWindow,
  isValidImageSize,
  isValidImageType,
} from './image-utils';

const MB = 1024 * 1024;

interface ImageOptions {
  width?: number;
  height?: number;
  fails?: boolean;
}

/** Replaces `Image` with one that "decodes" asynchronously to the given size. */
function stubImage({ width = 4000, height = 3000, fails = false }: ImageOptions = {}) {
  const images: Array<{ src: string }> = [];
  class FakeImage {
    width = width;
    height = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    #src = '';

    get src() {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      images.push(this);
      queueMicrotask(() => (fails ? this.onerror?.() : this.onload?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return images;
}

/** jsdom has no canvas: stub the 2D context and JPEG encoding, recording the output size. */
function stubCanvas({
  hasContext = true,
  blob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' }) as Blob | null,
} = {}) {
  const context = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    hasContext ? (context as unknown as RenderingContext) : null
  );
  const output = { width: 0, height: 0 };
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback
  ) {
    output.width = this.width;
    output.height = this.height;
    callback(blob);
  });
  return { context, toBlob, output, blob };
}

describe('image validation', () => {
  it.each([
    ['image/jpeg', true],
    ['image/png', true],
    ['image/webp', true],
    ['image/gif', false],
    ['image/heic', false],
    ['', false],
  ])('accepts %s uploads: %s', (type, valid) => {
    expect(isValidImageType(makeFile('photo', type))).toBe(valid);
  });

  it.each([
    [0, true],
    [5 * MB, true],
    [5 * MB + 1, false],
  ])('accepts a %i byte upload: %s', (size, valid) => {
    expect(isValidImageSize(makeFile('photo.png', 'image/png', size))).toBe(valid);
  });
});

describe('compressImage', () => {
  it('returns JPEGs that are already small enough untouched', async () => {
    const images = stubImage();
    const file = makeFile('small.jpg', 'image/jpeg', 900 * 1024);

    await expect(compressImage(file)).resolves.toBe(file);
    expect(images).toHaveLength(0);
  });

  it('scales large landscape images to 1920px wide and re-encodes them as JPEG', async () => {
    const images = stubImage({ width: 4000, height: 3000 });
    const { context, toBlob, output, blob } = stubCanvas();
    const file = makeFile('big.png', 'image/png', 3 * MB);

    await expect(compressImage(file)).resolves.toBe(blob);

    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(images[0].src).toBe('blob:mock-object-url');
    expect(output).toEqual({ width: 1920, height: 1440 });
    expect(context.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 1920, 1440);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);
  });

  it('scales tall images by their height', async () => {
    stubImage({ width: 3000, height: 4000 });
    const { output } = stubCanvas();

    await compressImage(makeFile('tall.webp', 'image/webp', 2 * MB));

    expect(output).toEqual({ width: 1440, height: 1920 });
  });

  it('keeps the dimensions of images that already fit', async () => {
    stubImage({ width: 800, height: 600 });
    const { output } = stubCanvas();

    await compressImage(makeFile('icon.png', 'image/png', 200 * 1024));

    expect(output).toEqual({ width: 800, height: 600 });
  });

  it('re-encodes JPEGs that are too large', async () => {
    stubImage({ width: 1200, height: 1200 });
    const { toBlob } = stubCanvas();

    await compressImage(makeFile('huge.jpg', 'image/jpeg', 2 * MB));

    expect(toBlob).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the canvas has no 2D context',
      () => stubCanvas({ hasContext: false }),
      {},
      'Failed to get canvas context',
    ],
    ['the image cannot be decoded', () => stubCanvas(), { fails: true }, 'Failed to load image'],
    ['JPEG encoding fails', () => stubCanvas({ blob: null }), {}, 'Failed to compress image'],
  ])('rejects when %s', async (_label, setUpCanvas, imageOptions, message) => {
    stubImage(imageOptions);
    setUpCanvas();

    await expect(compressImage(makeFile('photo.png', 'image/png', 2 * MB))).rejects.toThrow(
      message
    );
  });
});

describe('compressImageToFile', () => {
  it.each([
    ['holiday.photo.png', 'holiday.photo.jpg', 'image/png', 3 * MB],
    ['IMG_0001.JPEG', 'IMG_0001.jpg', 'image/jpeg', 100 * 1024],
    ['scan', 'scan', 'image/png', 3 * MB],
  ])('turns %s into the JPEG file %s', async (name, expectedName, type, size) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T10:00:00Z'));
    stubImage({ width: 1000, height: 800 });
    stubCanvas();

    const result = await compressImageToFile(makeFile(name, type, size));

    expect(result).toBeInstanceOf(File);
    expect(result).toMatchObject({
      name: expectedName,
      type: 'image/jpeg',
      lastModified: new Date('2026-10-21T10:00:00Z').getTime(),
    });
  });
});

describe('isDateWithinUploadWindow', () => {
  // 12:00 on 21 Oct 2026 in India (IST, UTC+5:30), whatever the test machine's time zone.
  const NOW = '2026-10-21T06:30:00Z';

  it.each([
    ['now', true, NOW],
    ['the last minute of today (IST)', true, '2026-10-21T18:29:00Z'],
    ['the first minute of tomorrow (IST)', false, '2026-10-21T18:31:00Z'],
    ['exactly seven days ago', true, '2026-10-14T06:30:00Z'],
    ['the first minute of the seventh day back (IST)', true, '2026-10-13T18:31:00Z'],
    ['the last minute of the eighth day back (IST)', false, '2026-10-13T18:29:00Z'],
    ['a month ago', false, '2026-09-21T06:30:00Z'],
  ])('%s → %s', (_label, allowed, instant) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));

    expect(isDateWithinUploadWindow(new Date(instant))).toBe(allowed);
  });
});

describe('formatDateForAPI', () => {
  it.each([
    [new Date(2026, 0, 5, 23, 59), '2026-01-05'],
    [new Date(2026, 11, 31, 0, 0), '2026-12-31'],
  ])('formats %s as %s using the local calendar day', (date, expected) => {
    expect(formatDateForAPI(date)).toBe(expected);
  });
});

describe('createThumbnailPreview', () => {
  it('reads the file as a data URL', async () => {
    const file = new File(['hi'], 'preview.png', { type: 'image/png' });

    await expect(createThumbnailPreview(file)).resolves.toBe('data:image/png;base64,aGk=');
  });

  it('rejects when the file cannot be read', async () => {
    class FailingReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('FileReader', FailingReader);

    await expect(createThumbnailPreview(makeFile())).rejects.toThrow('Failed to read file');
  });
});
