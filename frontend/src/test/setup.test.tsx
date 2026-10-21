/**
 * Self-tests for the shared test setup: store isolation, storage reset, jsdom stubs and the
 * router/fetch helpers every other suite relies on.
 */
import { screen } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { gl } from '../services/goodlogs';
import { useAuthStore } from '../store/useAuthStore';
import { useToastStore } from '../store/useToastStore';
import { jsonResponse, mockFetch, renderWithRouter, signIn } from './utils';

describe('test setup', () => {
  describe('store isolation', () => {
    it('lets a test change global stores and storage', () => {
      signIn({ id: 5, username: 'alice' });
      useToastStore.setState({ toasts: [{ id: 't1', message: 'hi', type: 'success' }] });

      expect(useAuthStore.getState().user).toMatchObject({ id: 5, username: 'alice' });
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBe('test-access-token');
    });

    it('starts the next test from the initial state', () => {
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useToastStore.getState().toasts).toEqual([]);
      expect(localStorage.length).toBe(0);
    });
  });

  it('stubs browser APIs that jsdom lacks', () => {
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);
    expect(() => new IntersectionObserver(() => {}).observe(document.body)).not.toThrow();
    expect(() => new ResizeObserver(() => {}).observe(document.body)).not.toThrow();
    expect(URL.createObjectURL(new Blob())).toBe('blob:mock-object-url');
  });

  it('fails unmocked network requests', async () => {
    await expect(fetch('https://example.com/api')).rejects.toThrow('Unmocked fetch');
  });

  it('replaces the analytics SDK with spies', () => {
    signIn();
    useAuthStore.getState().login('token', 'bob', 9);
    expect(gl.identify).toHaveBeenCalledWith('9');
    expect(gl.track).toHaveBeenCalledWith('login', { properties: { username: 'bob' } });
  });

  it('clears spy history between tests', () => {
    expect(gl.track).not.toHaveBeenCalled();
  });

  it('answers mocked requests and rejects unexpected ones', async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith('/ping') ? jsonResponse({ ok: true }) : undefined
    );

    await expect((await fetch('http://api/ping')).json()).resolves.toEqual({ ok: true });
    await expect(fetch('http://api/other')).rejects.toThrow(
      'Unhandled fetch: GET http://api/other'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders at a route and exposes the current location', async () => {
    function Profile() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/settings?tab=privacy')}>Go</button>;
    }

    const { user } = renderWithRouter(<Profile />, { route: '/user/alice', path: '/user/:name' });
    expect(screen.getByTestId('location')).toHaveTextContent('/user/alice');

    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=privacy');
  });
});
