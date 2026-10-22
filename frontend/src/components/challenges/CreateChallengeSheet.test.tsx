import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, challengeApi } from '../../services/api';
import { useChallengeStore } from '../../store';
import {
  CHALLENGE_NOW,
  detailResponse,
  IST_TODAY,
  makeChallengeDetail,
} from '../../test/fixtures/challenges';
import { deferred, renderWithHistory } from '../../test/fixtures/shell';
import type { ChallengeDetailResponse } from '../../types';
import { CreateChallengeSheet } from './CreateChallengeSheet';

vi.mock('../../services/api', async (importOriginal) => {
  const { createChallengeApiMock } = await import('../../test/fixtures/challenges');
  return {
    ...(await importOriginal<typeof import('../../services/api')>()),
    challengeApi: createChallengeApiMock(),
  };
});

const api = vi.mocked(challengeApi);
const created = makeChallengeDetail({ id: 50, title: 'Reels-free days', status: 'upcoming' });

function renderSheet({ isOpen = true } = {}) {
  const onClose = vi.fn();
  const view = renderWithHistory(
    <CreateChallengeSheet isOpen={isOpen} onClose={onClose} today={IST_TODAY} />,
    { entries: ['/challenges'] }
  );
  return { ...view, onClose };
}

const dialog = () => screen.getByRole('dialog', { name: 'New challenge' });
const radio = (group: string, name: string) =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });
const target = () => screen.getByRole('textbox', { name: 'Daily target in hours' });
const title = () => screen.getByRole('textbox', { name: 'Title' });
const submit = () => screen.getByRole('button', { name: /Create challenge|Creating/ });
const summary = () => screen.getByText(/· \d+ days$/);

describe('CreateChallengeSheet', () => {
  beforeEach(() => {
    vi.setSystemTime(CHALLENGE_NOW);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    api.create.mockResolvedValue(detailResponse(created));
  });

  it('renders nothing while closed', () => {
    renderSheet({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts from sensible defaults', () => {
    renderSheet();

    expect(dialog()).toBeInTheDocument();
    expect(
      within(screen.getByRole('radiogroup', { name: 'Activity' })).getAllByRole('radio')
    ).toHaveLength(16);
    expect(radio('Activity', 'Study')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Daily goal', 'At least')).toHaveAttribute('aria-checked', 'true');
    expect(target()).toHaveValue('2');
    expect(screen.getByText('At least 2h of Study a day')).toBeInTheDocument();
    expect(radio('Length', '21 days')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Start', 'Tomorrow')).toHaveAttribute('aria-checked', 'true');
    expect(title()).toHaveValue('Study 2h+ a day');
    expect(screen.getByText('15/60')).toBeInTheDocument();
    expect(summary()).toHaveTextContent('Oct 23 – Nov 12 · 21 days');
  });

  it('keeps the title in step with the goal until it is edited', async () => {
    const { user } = renderSheet();

    await user.click(radio('Activity', 'Reels'));
    expect(title()).toHaveValue('Reels 2h+ a day');

    await user.click(radio('Daily goal', 'At most'));
    expect(target()).toHaveValue('1');
    expect(title()).toHaveValue('Reels under 1h a day');
    expect(screen.getByText('At most 1h of Reels a day')).toBeInTheDocument();

    const decrease = screen.getByRole('button', { name: 'Decrease daily target by 15 minutes' });
    for (let i = 0; i < 4; i += 1) await user.click(decrease);
    expect(target()).toHaveValue('0');
    expect(decrease).toBeDisabled();
    expect(title()).toHaveValue('Reels-free days');
    expect(screen.getByText('No Reels at all')).toBeInTheDocument();

    await user.clear(title());
    await user.type(title(), 'No scrolling squad');
    await user.click(radio('Activity', 'Sleep'));
    expect(title()).toHaveValue('No scrolling squad');
  });

  it('moves between options with the arrow keys', async () => {
    const { user } = renderSheet();

    radio('Activity', 'Study').focus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Activity', 'Reading')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Activity', 'Reading')).toHaveFocus();
    expect(radio('Activity', 'Study')).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{Home}');
    expect(radio('Activity', 'Sleep')).toHaveAttribute('aria-checked', 'true');

    radio('Length', '21 days').focus();
    await user.keyboard('{ArrowLeft}');
    expect(radio('Length', '14 days')).toHaveAttribute('aria-checked', 'true');
  });

  it('steps the daily target in quarter hours within the allowed range', async () => {
    const { user } = renderSheet();
    const increase = screen.getByRole('button', { name: 'Increase daily target by 15 minutes' });

    await user.click(increase);
    expect(target()).toHaveValue('2.25');
    expect(title()).toHaveValue('Study 2.25h+ a day');

    await user.clear(target());
    await user.type(target(), '24');
    expect(increase).toBeDisabled();

    // Switching goals keeps a typed target, moved into the new range
    await user.click(radio('Daily goal', 'At most'));
    expect(target()).toHaveValue('23.75');
    await user.clear(target());
    await user.type(target(), '0');
    await user.click(radio('Daily goal', 'At least'));
    expect(target()).toHaveValue('0.25');
    await user.click(radio('Daily goal', 'At least'));
    expect(target()).toHaveValue('0.25');
  });

  it('tidies a typed target and explains one that is not allowed', async () => {
    const { user } = renderSheet();

    await user.clear(target());
    await user.type(target(), '1,50');
    await user.tab();
    expect(target()).toHaveValue('1.5');
    expect(target()).not.toHaveAttribute('aria-invalid');

    await user.clear(target());
    await user.type(target(), '1.3');
    await user.tab();
    expect(target()).toHaveAttribute('aria-invalid', 'true');
    expect(target()).toHaveAccessibleDescription('Use quarter hours, e.g. 0.25, 1.5 or 2');

    await user.clear(target());
    await user.type(target(), 'lots');
    expect(title()).toHaveValue('Study 2h+ a day');
    await user.click(screen.getByRole('button', { name: 'Increase daily target by 15 minutes' }));
    expect(target()).toHaveValue('2.25');

    await user.clear(target());
    await user.click(submit());
    expect(target()).toHaveAccessibleDescription('Pick between 0.25 and 24 hours');
    expect(target()).toHaveFocus();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('picks the length and start, within the next 30 days', async () => {
    const { user } = renderSheet();

    await user.click(radio('Length', '7 days'));
    expect(summary()).toHaveTextContent('Oct 23 – 29 · 7 days');

    await user.click(radio('Start', 'Today'));
    expect(summary()).toHaveTextContent('Oct 22 – 28 · 7 days');

    await user.click(radio('Start', 'Pick a date'));
    const date = screen.getByLabelText('Start date');
    expect(date).toHaveAttribute('min', '2026-10-22');
    expect(date).toHaveAttribute('max', '2026-11-21');
    expect(date).toHaveValue('2026-10-24');
    expect(summary()).toHaveTextContent('Oct 24 – 30 · 7 days');

    fireEvent.change(date, { target: { value: '2026-12-01' } });
    expect(screen.getByText('Pick a start date within the next 30 days')).toBeInTheDocument();
    expect(summary()).toHaveTextContent('Pick a start date · 7 days');

    await user.click(submit());
    expect(date).toHaveFocus();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('limits the title to 60 characters, counting emoji once', async () => {
    const { user } = renderSheet();

    fireEvent.change(title(), { target: { value: 'Run 🏃' } });
    expect(screen.getByText('5/60')).toBeInTheDocument();

    await user.clear(title());
    await user.type(title(), 'x'.repeat(70));
    expect(title()).toHaveValue('x'.repeat(60));
    expect(screen.getByText('60/60')).toBeInTheDocument();
  });

  it('asks for a title before creating', async () => {
    const { user } = renderSheet();

    await user.clear(title());
    await user.type(title(), '   ');
    await user.click(submit());

    expect(screen.getByText('Give your challenge a title')).toBeInTheDocument();
    expect(title()).toHaveFocus();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('creates the challenge, adds it to the list and opens it', async () => {
    const { user, onClose } = renderSheet();

    await user.click(radio('Activity', 'Reels'));
    await user.click(radio('Daily goal', 'At most'));
    for (let i = 0; i < 4; i += 1) {
      await user.click(screen.getByRole('button', { name: 'Decrease daily target by 15 minutes' }));
    }
    await user.click(radio('Length', '30 days'));
    await user.click(submit());

    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      title: 'Reels-free days',
      activity: 'reels',
      goal_type: 'at_most',
      target_hours: 0,
      duration_days: 30,
      start_date: '2026-10-23',
    });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/challenges/50'));
    expect(screen.getByTestId('location')).toHaveAttribute(
      'data-state',
      JSON.stringify({ created: true })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useChallengeStore.getState().challenges.map((challenge) => challenge.id)).toEqual([50]);
  });

  it('creates only once, and cannot be dismissed while creating', async () => {
    const response = deferred<ChallengeDetailResponse>();
    api.create.mockReturnValue(response.promise);
    const { user, onClose } = renderSheet();

    await user.dblClick(submit());
    expect(submit()).toHaveTextContent('Creating…');
    expect(submit()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledTimes(1);

    response.resolve(detailResponse(created));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('explains that the user is in too many challenges (CHALLENGE_LIMIT_REACHED)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.create.mockRejectedValue(
      new ApiError('Too many open challenges', 409, 'CHALLENGE_LIMIT_REACHED')
    );
    const { user, onClose } = renderSheet();

    await user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You're already in 10 challenges – finish one first"
    );
    expect(submit()).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('[Challenges] create_failed', {
      recovery: 'show_error',
      activity: 'study',
      durationDays: 21,
      errorCode: 'CHALLENGE_LIMIT_REACHED',
      status: 409,
    });
  });

  it.each([
    [
      'a validation message from the server',
      new ApiError('title must be 1–60 characters', 400, 'INVALID_CHALLENGE'),
      'title must be 1–60 characters',
    ],
    [
      'a connection problem',
      new TypeError('Failed to fetch'),
      "Couldn't create the challenge. Check your connection and try again.",
    ],
  ])('shows %s, until the form changes', async (_label, error, message) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.create.mockRejectedValue(error);
    const { user } = renderSheet();

    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(message);

    await user.click(radio('Length', '14 days'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closes with Cancel', async () => {
    const { user, onClose } = renderSheet();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("starts from India's date, not the device's", async () => {
    // 20:00 UTC on Oct 22 is already 01:30 on Oct 23 in India
    vi.setSystemTime(new Date('2026-10-22T20:00:00Z'));
    const { user } = renderWithHistory(<CreateChallengeSheet isOpen onClose={vi.fn()} />, {
      entries: ['/challenges'],
    });

    await user.click(radio('Start', 'Today'));

    expect(summary()).toHaveTextContent('Oct 23 – Nov 12 · 21 days');
  });
});
