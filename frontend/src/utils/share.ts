/**
 * Share helpers
 *
 * Share a link with the system share sheet where the browser has one, and fall back to
 * copying it to the clipboard everywhere else.
 */

/** How a share attempt ended */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export interface ShareLinkOptions {
  url: string;
  title?: string;
  text?: string;
}

/** Copies `text` to the clipboard; false when the browser refuses (no permission, no API) */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const isAbort = (error: unknown): boolean =>
  (error as { name?: unknown } | null | undefined)?.name === 'AbortError';

/**
 * Opens the system share sheet for a link, or copies the link where sharing is unavailable
 * or fails. Dismissing the share sheet counts as cancelled (nothing is copied).
 */
export async function shareLink({ url, title, text }: ShareLinkOptions): Promise<ShareOutcome> {
  const data: ShareData = { url, title, text };
  const canShare =
    typeof navigator.share === 'function' &&
    (typeof navigator.canShare !== 'function' || navigator.canShare(data));

  if (canShare) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (error) {
      if (isAbort(error)) return 'cancelled';
      // e.g. NotAllowedError when the browser wants a fresh tap: copy instead
    }
  }

  return (await copyText(url)) ? 'copied' : 'failed';
}
