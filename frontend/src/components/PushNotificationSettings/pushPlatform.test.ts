import { describe, expect, it, vi } from 'vitest';

import {
  ANDROID_CHROME_UA,
  DESKTOP_CHROME_UA,
  IPAD_DESKTOP_UA,
  IPHONE_SAFARI_UA,
  stubInstalledApp,
  stubNavigator,
  stubUserAgent,
} from '../../test/fixtures/settings';
import { getBlockedGuide, getPushPlatform, type PushPlatform } from './pushPlatform';

describe('getPushPlatform', () => {
  it.each([
    ['an iPhone', IPHONE_SAFARI_UA, 5, { isIOS: true, isAndroid: false }],
    [
      'an iPad reporting a desktop Mac user agent',
      IPAD_DESKTOP_UA,
      5,
      { isIOS: true, isAndroid: false },
    ],
    ['a Mac without touch', IPAD_DESKTOP_UA, 0, { isIOS: false, isAndroid: false }],
    ['an Android phone', ANDROID_CHROME_UA, 5, { isIOS: false, isAndroid: true }],
    ['a desktop browser', DESKTOP_CHROME_UA, 0, { isIOS: false, isAndroid: false }],
  ])('detects %s', (_label, userAgent, touchPoints, expected) => {
    stubUserAgent(userAgent, touchPoints);

    expect(getPushPlatform()).toEqual({ ...expected, isStandalone: false });
  });

  it('detects an installed app from the standalone display mode', () => {
    stubUserAgent(ANDROID_CHROME_UA, 5);
    stubInstalledApp();

    expect(getPushPlatform()).toEqual({ isIOS: false, isAndroid: true, isStandalone: true });
    expect(window.matchMedia).toHaveBeenCalledWith('(display-mode: standalone)');
  });

  it('detects a Home Screen app on older iOS through navigator.standalone', () => {
    stubUserAgent(IPHONE_SAFARI_UA, 5);
    stubNavigator('standalone', true);

    expect(getPushPlatform()).toMatchObject({ isIOS: true, isStandalone: true });
  });

  it('still works where matchMedia is missing', () => {
    stubUserAgent(IPHONE_SAFARI_UA, 5);
    vi.stubGlobal('matchMedia', undefined);

    expect(getPushPlatform()).toMatchObject({ isIOS: true, isStandalone: false });
  });

  it('reports no platform outside a browser', () => {
    vi.stubGlobal('navigator', undefined);

    expect(getPushPlatform()).toEqual({ isIOS: false, isAndroid: false, isStandalone: false });
  });
});

describe('getBlockedGuide', () => {
  const platform = (overrides: Partial<PushPlatform>): PushPlatform => ({
    isIOS: false,
    isAndroid: false,
    isStandalone: false,
    ...overrides,
  });

  it.each([
    [
      'an iOS Home Screen app',
      platform({ isIOS: true, isStandalone: true }),
      'Reset notification permission',
      'Remove the app from your Home Screen (long-press › Remove App)',
      5,
    ],
    [
      'iOS Safari',
      platform({ isIOS: true }),
      'Turn on notifications on iOS',
      'Tap the Share button in Safari',
      4,
    ],
    [
      'an installed Android app',
      platform({ isAndroid: true, isStandalone: true }),
      'Turn on in app settings',
      'Open your phone’s Settings › Apps',
      5,
    ],
    [
      'an Android browser',
      platform({ isAndroid: true }),
      'Turn on in your browser',
      'Tap the ⋮ menu in your browser',
      4,
    ],
    [
      'a desktop browser',
      platform({}),
      'Turn on notifications',
      'Click the site settings icon next to the address bar',
      4,
    ],
  ])('gives %s its own steps', (_label, input, title, firstStep, stepCount) => {
    const guide = getBlockedGuide(input);

    expect(guide.title).toBe(title);
    expect(guide.steps[0]).toBe(firstStep);
    expect(guide.steps).toHaveLength(stepCount);
  });

  it('prefers the iOS steps when a device reports both platforms', () => {
    expect(getBlockedGuide(platform({ isIOS: true, isAndroid: true })).title).toBe(
      'Turn on notifications on iOS'
    );
  });
});
