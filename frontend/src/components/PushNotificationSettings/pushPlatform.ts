/**
 * Push platform helpers
 *
 * Platform hints used to explain how to turn notifications on.
 */

export interface PushPlatform {
  isIOS: boolean;
  isAndroid: boolean;
  /** Running as an installed app (home-screen PWA / TWA) */
  isStandalone: boolean;
}

export const getPushPlatform = (): PushPlatform => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { isIOS: false, isAndroid: false, isStandalone: false };
  }
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop Mac user agent; touch support gives it away
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return { isIOS, isAndroid, isStandalone };
};

export interface BlockedGuide {
  title: string;
  steps: string[];
}

/** Platform-specific steps to (re-)enable notifications */
export const getBlockedGuide = ({ isIOS, isAndroid, isStandalone }: PushPlatform): BlockedGuide => {
  if (isIOS) {
    return isStandalone
      ? {
          title: 'Reset notification permission',
          steps: [
            'Remove the app from your Home Screen (long-press › Remove App)',
            'Open Safari and visit Growth Tracker again',
            'Tap Share › “Add to Home Screen”',
            'Open the app and tap Enable when prompted',
            'Choose “Allow” in the permission dialog',
          ],
        }
      : {
          title: 'Turn on notifications on iOS',
          steps: [
            'Tap the Share button in Safari',
            'Choose “Add to Home Screen”',
            'Open Growth Tracker from your Home Screen',
            'Turn on Push notifications and choose “Allow”',
          ],
        };
  }

  if (isAndroid) {
    return isStandalone
      ? {
          title: 'Turn on in app settings',
          steps: [
            'Open your phone’s Settings › Apps',
            'Find and tap “Growth Tracker”',
            'Tap “Notifications”',
            'Turn on “Allow notifications”',
            'Come back to the app',
          ],
        }
      : {
          title: 'Turn on in your browser',
          steps: [
            'Tap the ⋮ menu in your browser',
            'Go to Settings › Site settings',
            'Tap “Notifications”',
            'Find this site and allow it',
          ],
        };
  }

  return {
    title: 'Turn on notifications',
    steps: [
      'Click the site settings icon next to the address bar',
      'Find “Notifications”',
      'Change it from “Block” to “Allow”',
      'Refresh the page',
    ],
  };
};
