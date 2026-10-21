import { act, screen, waitFor } from '@testing-library/react';
import { useNavigationType } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNotificationPreviewStore } from '../store/useNotificationPreviewStore';
import { makeNotification, renderWithHistory, signOut } from '../test/fixtures/shell';
import { signIn } from '../test/utils';
import type { AutocompleteSuggestion, Notification } from '../types';
import { TAB_RESELECT_EVENT } from '../utils/navigation';
import { Layout } from './Layout';
import styles from './Layout.module.css';

/** What Layout registered with useBackDismiss on its last render. */
const backDismiss = vi.hoisted(() => ({ isOpen: false, dismiss: () => {} }));

vi.mock('../hooks/useBackDismiss', () => ({
  useBackDismiss: (isOpen: boolean, onDismiss: () => void) => {
    backDismiss.isOpen = isOpen;
    backDismiss.dismiss = onDismiss;
  },
}));

// The real search and notification center talk to the API and a WebSocket; these stand-ins
// expose the callbacks Layout wires up.
vi.mock('./search', () => ({
  UserSearchAutocomplete: (props: {
    placeholder?: string;
    autoFocus?: boolean;
    navigateOnSelect?: boolean;
    onSelect?: (suggestion: AutocompleteSuggestion) => void;
    onComplete?: () => void;
    onBlur?: () => void;
  }) => (
    <div role="search">
      <input
        aria-label="Find people"
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        data-navigates={String(props.navigateOnSelect)}
      />
      <button
        type="button"
        onClick={() => props.onSelect?.({ text: 'bob', kind: 'user', score: 1 })}
      >
        Select bob
      </button>
      <button type="button" onClick={props.onComplete}>
        Finish search
      </button>
      <button type="button" onClick={props.onBlur}>
        Leave search
      </button>
    </div>
  ),
}));

vi.mock('./ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ui')>()),
  NotificationCenter: (props: {
    onNotificationClick?: (notification: Notification) => void;
    onUsernameClick?: (username: string) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.onNotificationClick?.({
            id: 1,
            type: 'like_received',
            title: 'New like',
            body: '',
            metadata: { liker_id: 2, liker_username: 'dave', liked_date: '2024-05-01' },
            read_at: null,
            created_at: '2024-05-01T10:00:00Z',
          })
        }
      >
        Open like notification
      </button>
      <button type="button" onClick={() => props.onUsernameClick?.('carol')}>
        Open carol’s profile
      </button>
    </div>
  ),
}));

function NavigationTypeProbe() {
  return <span data-testid="navigation-type">{useNavigationType()}</span>;
}

/** Renders the layout at `url`, keeping the live browser URL in sync with the router. */
const renderLayout = (url = '/') => {
  window.history.replaceState(null, '', url);
  return renderWithHistory(
    <>
      <Layout>
        <p>Page content</p>
      </Layout>
      <NavigationTypeProbe />
    </>,
    { entries: [url] }
  );
};

const location = () => screen.getByTestId('location');
const navigationType = () => screen.getByTestId('navigation-type');
const logoButton = () => screen.queryByRole('button', { name: 'Growth Tracker home' });
const searchButton = () => screen.queryByRole('button', { name: 'Search users' });

describe('Layout', () => {
  beforeEach(() => {
    backDismiss.isOpen = false;
  });

  it.each(['/forgot-password', '/reset-password', '/verify-email'])(
    'gives the auth-flow screen %s a minimal, branded frame',
    (url) => {
      signIn();
      renderLayout(url);

      expect(screen.getByRole('img', { name: 'Growth Tracker' })).toBeInTheDocument();
      expect(screen.getByRole('main')).toHaveTextContent('Page content');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    }
  );

  it('shows the logo and theme toggle to signed-out visitors', () => {
    signOut();
    renderLayout('/login');

    expect(logoButton()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
    expect(searchButton()).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('Page content');
  });

  it('adds search, notifications and the tab bar once signed in', () => {
    signIn();
    renderLayout('/');

    expect(logoButton()).toBeInTheDocument();
    expect(searchButton()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open like notification' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch to/i })).not.toBeInTheDocument();
  });

  describe('search', () => {
    beforeEach(() => {
      signIn();
    });

    it('expands in place of the header icons and takes focus', async () => {
      const { user } = renderLayout('/');

      await user.click(searchButton()!);

      const input = screen.getByRole('textbox', { name: 'Find people' });
      expect(input).toHaveAttribute('placeholder', 'Search users...');
      expect(input).toHaveFocus();
      // Layout navigates itself so it can replace duplicate history entries
      expect(input).toHaveAttribute('data-navigates', 'false');
      expect(logoButton()).not.toBeInTheDocument();
      expect(searchButton()).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Open like notification' })
      ).not.toBeInTheDocument();
      expect(backDismiss.isOpen).toBe(true);
    });

    it('closes when the backdrop is tapped', async () => {
      const { user, container } = renderLayout('/');
      await user.click(searchButton()!);

      await user.click(container.querySelector(`.${styles.backdrop}`)!);

      expect(screen.queryByRole('search')).not.toBeInTheDocument();
      expect(logoButton()).toBeInTheDocument();
      expect(backDismiss.isOpen).toBe(false);
    });

    it('closes on Back instead of leaving the page', async () => {
      const { user } = renderLayout('/settings');
      await user.click(searchButton()!);

      act(() => backDismiss.dismiss());

      expect(screen.queryByRole('search')).not.toBeInTheDocument();
      expect(location()).toHaveTextContent('/settings');
    });

    it.each(['Finish search', 'Leave search'])('closes on "%s"', async (action) => {
      const { user } = renderLayout('/');
      await user.click(searchButton()!);

      await user.click(screen.getByRole('button', { name: action }));

      expect(screen.queryByRole('search')).not.toBeInTheDocument();
    });

    it('opens the selected profile and closes', async () => {
      const { user } = renderLayout('/');
      await user.click(searchButton()!);

      await user.click(screen.getByRole('button', { name: 'Select bob' }));

      expect(location()).toHaveTextContent('/user/bob');
      expect(navigationType()).toHaveTextContent('PUSH');
      expect(screen.queryByRole('search')).not.toBeInTheDocument();
    });

    it('does not stack a duplicate entry when selecting the profile already open', async () => {
      const { user } = renderLayout('/user/bob');
      await user.click(searchButton()!);

      await user.click(screen.getByRole('button', { name: 'Select bob' }));

      expect(location()).toHaveTextContent('/user/bob');
      expect(navigationType()).toHaveTextContent('REPLACE');
    });

    it('closes when the user navigates elsewhere', async () => {
      const { user } = renderLayout('/');
      await user.click(searchButton()!);

      await user.click(screen.getByRole('button', { name: 'Insights' }));

      expect(location()).toHaveTextContent('/analytics');
      expect(screen.queryByRole('search')).not.toBeInTheDocument();
    });
  });

  describe('logo', () => {
    it('returns home from other screens', async () => {
      signIn();
      const { user } = renderLayout('/settings');

      await user.click(logoButton()!);

      expect(location()).toHaveTextContent(/^\/$/);
    });

    it('drops the query when Home shows a specific day', async () => {
      signIn();
      const { user } = renderLayout('/?date=2024-05-01');

      await user.click(logoButton()!);

      expect(location()).toHaveTextContent(/^\/$/);
    });

    it('scrolls Home back to the top and announces the reselect', async () => {
      signIn();
      const reselect = vi.fn();
      window.addEventListener(TAB_RESELECT_EVENT, reselect);
      const { user } = renderLayout('/');

      await user.click(logoButton()!);

      window.removeEventListener(TAB_RESELECT_EVENT, reselect);
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
      expect(reselect).toHaveBeenCalledWith(expect.objectContaining({ detail: { tab: 'home' } }));
      expect(navigationType()).toHaveTextContent('POP');
    });
  });

  describe('notifications', () => {
    beforeEach(() => {
      signIn();
    });

    it('opens what a notification is about', async () => {
      const { user } = renderLayout('/settings');

      await user.click(screen.getByRole('button', { name: 'Open like notification' }));

      expect(location()).toHaveTextContent('/?date=2024-05-01');
    });

    it('opens the profile of a username in a notification', async () => {
      const { user } = renderLayout('/settings');

      await user.click(screen.getByRole('button', { name: 'Open carol’s profile' }));

      expect(location()).toHaveTextContent('/user/carol');
    });

    it('shows a live preview that opens the notification when tapped', async () => {
      useNotificationPreviewStore.getState().showPreview(
        makeNotification({
          id: 42,
          type: 'new_follower',
          title: 'carol started following you',
          metadata: { actor_id: 3, actor_username: 'carol' },
        })
      );
      const { user } = renderLayout('/settings');

      await user.click(screen.getByText('carol started following you'));

      expect(location()).toHaveTextContent('/user/carol');
      expect(useNotificationPreviewStore.getState().preview).toBeNull();
    });

    it('lets the live preview be dismissed', async () => {
      useNotificationPreviewStore.getState().showPreview(makeNotification({ title: 'New like' }));
      const { user } = renderLayout('/settings');

      await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));

      await waitFor(() => expect(useNotificationPreviewStore.getState().preview).toBeNull());
      expect(screen.queryByText('New like')).not.toBeInTheDocument();
      expect(location()).toHaveTextContent('/settings');
    });
  });
});
