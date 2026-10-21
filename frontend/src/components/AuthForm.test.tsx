import { act, fireEvent, screen } from '@testing-library/react';
import type { InitialEntry } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../constants/storage';
import { api, ApiError } from '../services/api';
import { useAuthStore } from '../store';
import { deferred, renderWithHistory, signOut, tokenWith } from '../test/fixtures/shell';
import { AuthForm } from './AuthForm';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const post = vi.mocked(api.post);
const ALICE_TOKEN = tokenWith({ user_id: 7, username: 'alice' });

const renderForm = (entry: InitialEntry = '/login') =>
  renderWithHistory(<AuthForm />, { entries: [entry] });

const location = () => screen.getByTestId('location');
const identifierField = () => screen.getByLabelText('Username or email');
const passwordField = () => screen.getByLabelText('Password');
const submitButton = (name: string) => screen.getByRole('button', { name });
const formOf = (element: HTMLElement) => element.closest('form')!;
const toast = () => screen.queryByRole('alert') ?? screen.queryByRole('status');

type User = ReturnType<typeof renderForm>['user'];

const logIn = async (user: User, identifier = 'alice', password = 'password123') => {
  await user.type(identifierField(), identifier);
  await user.type(passwordField(), password);
  await user.click(submitButton('Log in'));
};

const openSignUp = async (user: User) => {
  await user.click(screen.getByRole('tab', { name: 'Sign up' }));
};

const signUp = async (user: User, username = 'alice', password = 'password123') => {
  await openSignUp(user);
  await user.type(screen.getByLabelText('Email'), 'alice@example.com');
  await user.type(screen.getByLabelText('Username'), username);
  await user.type(passwordField(), password);
  await user.click(submitButton('Create account'));
};

describe('AuthForm', () => {
  beforeEach(() => {
    post.mockReset();
    signOut();
  });

  describe('log in', () => {
    it('starts on the login form', () => {
      renderForm();

      expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
      expect(screen.getByText('Log in to keep your streak glowing.')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Log in' })).toHaveAttribute('aria-selected', 'true');
      expect(identifierField()).toHaveAttribute('autocomplete', 'username');
      expect(passwordField()).toHaveAttribute('autocomplete', 'current-password');
      expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
        'href',
        '/forgot-password'
      );
      expect(submitButton('Log in')).toBeEnabled();
    });

    it('keeps the identifier as typed, without leading spaces', async () => {
      const { user } = renderForm();

      await user.type(identifierField(), '  JohnDoe');

      expect(identifierField()).toHaveValue('JohnDoe');
    });

    it('keeps a pasted email address as it was written', async () => {
      const { user } = renderForm();

      await user.click(identifierField());
      await user.paste('John@Example.com');

      expect(identifierField()).toHaveValue('John@Example.com');
    });

    // Regression: keystrokes before the "@" used to be lowercased, so a typed
    // "John@Example.com" became "john@Example.com" and the backend (which matches emails
    // exactly) could not find the account.
    it('keeps a typed email address as it was written', async () => {
      const { user } = renderForm();

      await user.type(identifierField(), 'John@Example.com');

      expect(identifierField()).toHaveValue('John@Example.com');
    });

    it('sends a typed username in lowercase without changing the field', async () => {
      post.mockResolvedValue({ success: false, error: 'Invalid credentials' });
      const { user } = renderForm();

      await logIn(user, 'Alice.Smith');

      expect(post).toHaveBeenCalledWith('/login', {
        identifier: 'alice.smith',
        password: 'password123',
      });
      expect(identifierField()).toHaveValue('Alice.Smith');
    });

    it('sends a typed email address exactly as it was written', async () => {
      post.mockResolvedValue({ success: true, access_token: ALICE_TOKEN });
      const { user } = renderForm();

      await logIn(user, 'John@Example.com');

      expect(post).toHaveBeenCalledWith('/login', {
        identifier: 'John@Example.com',
        password: 'password123',
      });
      expect(location()).toHaveTextContent(/^\/$/);
    });

    it('trims the identifier when leaving the field', async () => {
      const { user } = renderForm();

      await user.type(identifierField(), 'alice  ');
      expect(identifierField()).toHaveValue('alice  ');

      await user.tab();
      expect(identifierField()).toHaveValue('alice');
    });

    it('signs the user in and continues to Home', async () => {
      post.mockResolvedValue({ success: true, access_token: ALICE_TOKEN });
      const { user } = renderForm();

      await logIn(user);

      expect(post).toHaveBeenCalledWith('/login', {
        identifier: 'alice',
        password: 'password123',
      });
      expect(location()).toHaveTextContent(/^\/$/);
      expect(useAuthStore.getState()).toMatchObject({
        isAuthenticated: true,
        user: { id: 7, username: 'alice' },
      });
      expect(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)).toBe(ALICE_TOKEN);
    });

    it('returns to the page that required login', async () => {
      post.mockResolvedValue({ success: true, access_token: ALICE_TOKEN });
      const { user } = renderForm({
        pathname: '/login',
        state: { from: '/settings?tab=privacy' },
      });

      await logIn(user);

      expect(location()).toHaveTextContent('/settings?tab=privacy');
    });

    it('never follows a redirect that leaves the app', async () => {
      post.mockResolvedValue({ success: true, access_token: ALICE_TOKEN });
      const { user } = renderForm({ pathname: '/login', state: { from: '//evil.example' } });

      await logIn(user);

      expect(location()).toHaveTextContent(/^\/$/);
    });

    it('submits with Enter and trims what was typed', async () => {
      post.mockResolvedValue({ success: true, access_token: ALICE_TOKEN });
      const { user } = renderForm();

      await user.type(passwordField(), 'password123');
      await user.type(identifierField(), 'alice  {Enter}');

      expect(post).toHaveBeenCalledWith('/login', {
        identifier: 'alice',
        password: 'password123',
      });
    });

    it('shows progress and ignores repeated submits while logging in', async () => {
      const request = deferred<unknown>();
      post.mockReturnValue(request.promise);
      const { user } = renderForm();

      await logIn(user);

      const busy = submitButton('Logging in…');
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');

      fireEvent.submit(formOf(busy));
      await user.click(screen.getByRole('tab', { name: 'Sign up' }));
      expect(post).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();

      await act(async () => request.resolve({ success: false, error: 'Invalid credentials' }));
      expect(submitButton('Log in')).toBeEnabled();
    });

    it.each([
      [{ success: false, error: 'Invalid credentials' }, 'Invalid credentials'],
      [{ success: false }, 'Login failed'],
    ])('shows why the server refused (%j)', async (response, message) => {
      post.mockResolvedValue(response);
      const { user } = renderForm();

      await logIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(location()).toHaveTextContent('/login');
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it.each([
      [
        new ApiError('Too many attempts, try again later', 429),
        'Too many attempts, try again later',
      ],
      [new Error('Failed to fetch'), 'An error occurred. Please try again.'],
    ])('reports a failed request (%s)', async (error, message) => {
      post.mockRejectedValue(error);
      const { user } = renderForm();

      await logIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(submitButton('Log in')).toBeEnabled();
    });

    it('rejects a malformed access token', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      post.mockResolvedValue({ success: true, access_token: 'not-a-jwt' });
      const { user } = renderForm();

      await logIn(user);

      expect(await screen.findByRole('alert')).toHaveTextContent('Login failed. Please try again.');
      expect(consoleError).toHaveBeenCalledWith('[AuthForm] Received malformed access token');
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(location()).toHaveTextContent('/login');
    });

    it('lets the error message time out', async () => {
      vi.useFakeTimers();
      post.mockResolvedValue({ success: false, error: 'Invalid credentials' });
      renderForm();

      fireEvent.change(identifierField(), { target: { value: 'alice' } });
      fireEvent.change(passwordField(), { target: { value: 'password123' } });
      fireEvent.submit(formOf(submitButton('Log in')));
      await act(async () => {});
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials');

      act(() => vi.advanceTimersByTime(3000));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('sign up', () => {
    it('switches to the sign-up form and back', async () => {
      const { user } = renderForm();

      await openSignUp(user);

      expect(screen.getByRole('heading', { name: 'Start growing' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Sign up' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
      expect(screen.getByLabelText('Username')).toHaveAccessibleDescription(
        'Lowercase letters, numbers, _ and . only'
      );
      expect(passwordField()).toHaveAccessibleDescription('At least 8 characters');
      expect(passwordField()).toHaveAttribute('autocomplete', 'new-password');
      expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument();
      expect(submitButton('Create account')).toBeEnabled();

      await user.click(screen.getByRole('tab', { name: 'Log in' }));
      expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    });

    it('normalises the username and email as they are typed', async () => {
      const { user } = renderForm();
      await openSignUp(user);

      await user.type(screen.getByLabelText('Username'), ' John_Doe');
      expect(screen.getByLabelText('Username')).toHaveValue('john_doe');

      await user.type(screen.getByLabelText('Email'), '  me@example.com ');
      await user.tab();
      expect(screen.getByLabelText('Email')).toHaveValue('me@example.com');
    });

    it('carries a username typed on the login form over in lowercase', async () => {
      const { user } = renderForm();
      await user.type(identifierField(), 'Alice.Smith');

      await openSignUp(user);

      expect(screen.getByLabelText('Username')).toHaveValue('alice.smith');
      expect(screen.getByLabelText('Username')).toBeValid();
    });

    it('rejects usernames with unsupported characters before calling the server', async () => {
      const { user } = renderForm();
      await openSignUp(user);
      await user.type(screen.getByLabelText('Email'), 'alice@example.com');
      await user.type(screen.getByLabelText('Username'), 'alice-smith');
      await user.type(passwordField(), 'password123');

      // The browser blocks the pattern mismatch; the form double-checks on submit
      expect(screen.getByLabelText('Username')).toBeInvalid();
      fireEvent.submit(formOf(submitButton('Create account')));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Username can only contain lowercase letters, numbers, _ and .'
      );
      expect(post).not.toHaveBeenCalled();
      expect(submitButton('Create account')).toBeEnabled();
    });

    // Regression: only the native minLength (UTF-16 units) guarded this, so 4–7 emoji reached
    // the server, which counts characters and refused them
    it('rejects a password of 7 emoji with the length message before calling the server', async () => {
      const { user } = renderForm();

      await signUp(user, 'alice', '🌱'.repeat(7));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Password must be at least 8 characters'
      );
      expect(post).not.toHaveBeenCalled();
      expect(submitButton('Create account')).toBeEnabled();
    });

    it('accepts a password of 8 emoji, which the server counts as 8 characters', async () => {
      post
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true, access_token: ALICE_TOKEN });
      const { user } = renderForm();

      await signUp(user, 'alice', '🌱'.repeat(8));

      expect(post).toHaveBeenNthCalledWith(1, '/register', {
        email: 'alice@example.com',
        username: 'alice',
        password: '🌱'.repeat(8),
      });
      expect(location()).toHaveTextContent(/^\/$/);
    });

    it('creates the account and signs straight in', async () => {
      post
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true, access_token: ALICE_TOKEN });
      const { user } = renderForm();

      await signUp(user);

      expect(post).toHaveBeenNthCalledWith(1, '/register', {
        email: 'alice@example.com',
        username: 'alice',
        password: 'password123',
      });
      expect(post).toHaveBeenNthCalledWith(2, '/login', {
        identifier: 'alice',
        password: 'password123',
      });
      expect(location()).toHaveTextContent(/^\/$/);
      expect(useAuthStore.getState().user).toMatchObject({ id: 7, username: 'alice' });
    });

    it('shows progress while the account is created', async () => {
      const request = deferred<unknown>();
      post.mockReturnValue(request.promise);
      const { user } = renderForm();

      await signUp(user);

      expect(submitButton('Creating account…')).toBeDisabled();
      await act(async () => request.resolve({ success: false }));
    });

    it('asks the user to log in when signing in after registration fails', async () => {
      post.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
      const { user } = renderForm();

      await signUp(user);

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Registration successful, please login.'
      );
      expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
      expect(location()).toHaveTextContent('/login');
    });

    it('also falls back to the login form when the new session is malformed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      post
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true, access_token: 'broken' });
      const { user } = renderForm();

      await signUp(user);

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Registration successful, please login.'
      );
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it.each([
      [{ success: false, error: 'Username already taken' }, 'Username already taken'],
      [{ success: false }, 'Registration failed'],
    ])('shows why the account was not created (%j)', async (response, message) => {
      post.mockResolvedValue(response);
      const { user } = renderForm();

      await signUp(user);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('heading', { name: 'Start growing' })).toBeInTheDocument();
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('clears the message when switching between forms', async () => {
      post.mockResolvedValue({ success: false, error: 'Username already taken' });
      const { user } = renderForm();
      await signUp(user);
      expect(await screen.findByRole('alert')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'Log in' }));

      expect(toast()).not.toBeInTheDocument();
    });
  });
});
