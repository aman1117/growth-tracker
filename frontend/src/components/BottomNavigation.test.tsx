import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gl } from '../services/goodlogs';
import { renderWithHistory } from '../test/fixtures/shell';
import { signIn } from '../test/utils';
import { TAB_RESELECT_EVENT } from '../utils/navigation';
import { BottomNavigation } from './BottomNavigation';

const PROFILE_TAB = 'You: profile and settings';

/** Renders the tab bar at `url`, keeping the live browser URL in sync with the router. */
const renderAt = (url: string, props: Parameters<typeof BottomNavigation>[0] = {}) => {
  window.history.replaceState(null, '', url);
  return renderWithHistory(<BottomNavigation {...props} />, { entries: [url] });
};

const tab = (name: string) => screen.getByRole('button', { name });
const location = () => screen.getByTestId('location');

const listeners: Array<[string, EventListener]> = [];

const listenFor = (type: string) => {
  const listener = vi.fn();
  window.addEventListener(type, listener);
  listeners.push([type, listener]);
  return listener;
};

describe('BottomNavigation', () => {
  afterEach(() => {
    listeners.splice(0).forEach(([type, listener]) => window.removeEventListener(type, listener));
  });

  it('renders nothing for signed-out visitors', () => {
    renderAt('/');

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('offers Home, Customize, Insights and the profile tab', () => {
    signIn();
    renderAt('/');

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Home', 'Customize tiles', 'Insights', PROFILE_TAB]);
  });

  it.each([
    ['/', 'Home'],
    ['/user/TestUser', 'Home'],
    ['/analytics', 'Insights'],
    ['/analytics?user=testuser', 'Insights'],
    ['/settings', PROFILE_TAB],
  ])('marks the tab for %s as the current page', (url, name) => {
    signIn({ username: 'testuser' });
    renderAt(url);

    expect(tab(name)).toHaveAttribute('aria-current', 'page');
    const others = screen.getAllByRole('button').filter((button) => button !== tab(name));
    for (const button of others) {
      expect(button).not.toHaveAttribute('aria-current');
    }
  });

  it.each(['/user/bob', '/analytics?user=bob', '/analytics/bob'])(
    'highlights no tab on another user’s screen (%s)',
    (url) => {
      signIn({ username: 'testuser' });
      renderAt(url);

      for (const button of screen.getAllByRole('button')) {
        expect(button).not.toHaveAttribute('aria-current');
      }
    }
  );

  describe('profile tab avatar', () => {
    it('prefers the thumbnail', () => {
      signIn({ profilePic: 'full.jpg', profilePicThumb: 'thumb.jpg' });
      renderAt('/');

      expect(tab(PROFILE_TAB).querySelector('img')).toHaveAttribute('src', 'thumb.jpg');
    });

    it('falls back to the full picture', () => {
      signIn({ profilePic: 'full.jpg' });
      renderAt('/');

      expect(tab(PROFILE_TAB).querySelector('img')).toHaveAttribute('src', 'full.jpg');
    });

    it('shows the first letter of the username without a picture', () => {
      signIn({ username: 'zoe' });
      renderAt('/');

      expect(tab(PROFILE_TAB).querySelector('img')).not.toBeInTheDocument();
      expect(within(tab(PROFILE_TAB)).getByText('z')).toBeInTheDocument();
    });

    it('shows a generic icon when there is nothing else to show', () => {
      signIn({ username: '' });
      renderAt('/');

      expect(tab(PROFILE_TAB).querySelectorAll('svg')).toHaveLength(1);
    });
  });

  describe('tapping a tab', () => {
    it('opens the root screen of another tab', async () => {
      signIn();
      const { user } = renderAt('/');

      await user.click(tab('Insights'));

      expect(location()).toHaveTextContent('/analytics');
      expect(gl.debug).toHaveBeenCalledWith('tab_selected', {
        metadata: { tab: 'analytics', from: 'home' },
      });
    });

    it('works from screens that belong to no tab', async () => {
      signIn();
      const { user } = renderAt('/user/bob');

      await user.click(tab(PROFILE_TAB));

      expect(location()).toHaveTextContent('/settings');
      expect(gl.debug).toHaveBeenCalledWith('tab_selected', {
        metadata: { tab: 'profile', from: 'none' },
      });
    });

    it('returns to the tab root from a nested screen of the same tab', async () => {
      signIn({ username: 'testuser' });
      const { user } = renderAt('/analytics?user=testuser');

      await user.click(tab('Insights'));

      expect(location()).toHaveTextContent(/^\/analytics$/);
    });

    it('scrolls to the top and announces the reselect when already on the tab root', async () => {
      signIn();
      const reselect = listenFor(TAB_RESELECT_EVENT);
      const { user } = renderAt('/');

      await user.click(tab('Home'));

      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
      expect(reselect).toHaveBeenCalledWith(expect.objectContaining({ detail: { tab: 'home' } }));
      expect(gl.debug).toHaveBeenCalledWith('tab_reselected', { metadata: { tab: 'home' } });
      expect(location()).toHaveTextContent(/^\/$/);
    });

    it('can be operated from the keyboard', async () => {
      signIn();
      const { user } = renderAt('/');

      await user.tab();
      await user.tab();
      await user.tab();
      expect(tab('Insights')).toHaveFocus();

      await user.keyboard('{Enter}');
      expect(location()).toHaveTextContent('/analytics');
    });
  });

  describe('Customize', () => {
    it('uses the screen’s own handler when provided', async () => {
      signIn();
      const onCustomizeTiles = vi.fn();
      const toggle = listenFor('toggleEditMode');
      const { user } = renderAt('/settings', { onCustomizeTiles });

      await user.click(tab('Customize tiles'));

      expect(onCustomizeTiles).toHaveBeenCalledTimes(1);
      expect(toggle).not.toHaveBeenCalled();
      expect(location()).toHaveTextContent('/settings');
    });

    it.each(['/', '/user/TESTUSER'])(
      'toggles edit mode right away on your dashboard (%s)',
      async (url) => {
        signIn({ username: 'testuser' });
        const toggle = listenFor('toggleEditMode');
        const { user } = renderAt(url);

        await user.click(tab('Customize tiles'));

        expect(toggle).toHaveBeenCalledTimes(1);
        expect(location()).toHaveTextContent(url);
      }
    );

    it('opens Home in edit mode from any other screen', async () => {
      signIn();
      const toggle = listenFor('toggleEditMode');
      const { user } = renderAt('/settings');

      await user.click(tab('Customize tiles'));

      expect(toggle).not.toHaveBeenCalled();
      expect(location()).toHaveTextContent(/^\/$/);
      expect(location()).toHaveAttribute('data-state', JSON.stringify({ enterEditMode: true }));
      expect(gl.debug).toHaveBeenCalledWith('customize_from_other_screen', {
        metadata: { tab: 'profile' },
      });
    });

    it('opens Home in edit mode from another user’s profile', async () => {
      signIn({ username: 'testuser' });
      const { user } = renderAt('/user/bob');

      await user.click(tab('Customize tiles'));

      expect(location()).toHaveTextContent(/^\/$/);
      expect(gl.debug).toHaveBeenCalledWith('customize_from_other_screen', {
        metadata: { tab: 'none' },
      });
    });
  });
});
