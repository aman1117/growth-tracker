import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyText, shareLink } from './share';

const URL_TO_SHARE = 'https://trackgrowth.in/c/ABCD2345';

/** Installs (or removes, with undefined) a navigator API for the current test */
function stubNavigatorApi(name: 'share' | 'canShare' | 'clipboard', value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value });
}

describe('share helpers', () => {
  afterEach(() => {
    for (const name of ['share', 'canShare', 'clipboard'] as const) {
      Reflect.deleteProperty(navigator, name);
    }
  });

  describe('copyText', () => {
    it('copies to the clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubNavigatorApi('clipboard', { writeText });

      await expect(copyText('hello')).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith('hello');
    });

    it('reports a refused copy', async () => {
      stubNavigatorApi('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('denied')) });

      await expect(copyText('hello')).resolves.toBe(false);
    });

    it('reports that there is no clipboard', async () => {
      stubNavigatorApi('clipboard', undefined);

      await expect(copyText('hello')).resolves.toBe(false);
    });
  });

  describe('shareLink', () => {
    it('opens the system share sheet when there is one', async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      stubNavigatorApi('share', share);
      stubNavigatorApi(
        'canShare',
        vi.fn(() => true)
      );

      await expect(shareLink({ url: URL_TO_SHARE, title: 'Join me' })).resolves.toBe('shared');
      expect(share).toHaveBeenCalledWith({ url: URL_TO_SHARE, title: 'Join me', text: undefined });
    });

    it('treats a dismissed share sheet as cancelled and copies nothing', async () => {
      const writeText = vi.fn();
      stubNavigatorApi('share', vi.fn().mockRejectedValue(new DOMException('', 'AbortError')));
      stubNavigatorApi('clipboard', { writeText });

      await expect(shareLink({ url: URL_TO_SHARE })).resolves.toBe('cancelled');
      expect(writeText).not.toHaveBeenCalled();
    });

    it('copies the link when sharing fails for another reason', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubNavigatorApi('share', vi.fn().mockRejectedValue(new DOMException('', 'NotAllowedError')));
      stubNavigatorApi('clipboard', { writeText });

      await expect(shareLink({ url: URL_TO_SHARE })).resolves.toBe('copied');
      expect(writeText).toHaveBeenCalledWith(URL_TO_SHARE);
    });

    it('copies the link when the data cannot be shared', async () => {
      const share = vi.fn();
      stubNavigatorApi('share', share);
      stubNavigatorApi(
        'canShare',
        vi.fn(() => false)
      );
      stubNavigatorApi('clipboard', { writeText: vi.fn().mockResolvedValue(undefined) });

      await expect(shareLink({ url: URL_TO_SHARE })).resolves.toBe('copied');
      expect(share).not.toHaveBeenCalled();
    });

    it('copies the link where there is no share sheet', async () => {
      stubNavigatorApi('clipboard', { writeText: vi.fn().mockResolvedValue(undefined) });

      await expect(shareLink({ url: URL_TO_SHARE })).resolves.toBe('copied');
    });

    it('reports failure when neither sharing nor copying works', async () => {
      stubNavigatorApi('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('denied')) });

      await expect(shareLink({ url: URL_TO_SHARE })).resolves.toBe('failed');
    });
  });
});
