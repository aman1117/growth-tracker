import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, challengeApi, commentApi, likeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import {
  makeChallengeSummary,
  makeProgress,
  makeUpcomingSummary,
} from '../../test/fixtures/challenges';
import {
  ALICE,
  dashboardRoutes,
  FIXED_TODAY,
  makeActivity,
  mockChallengeList,
  mockQuietSocial,
  resetStoryStubs,
  routeApi,
  TODAY_KEY,
} from '../../test/fixtures/dashboard';
import { renderWithRouter, signIn } from '../../test/utils';
import { Dashboard } from '.';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  api: { get: vi.fn(), post: vi.fn() },
  likeApi: { getLikes: vi.fn(), likeDay: vi.fn(), unlikeDay: vi.fn() },
  commentApi: { getCommentCount: vi.fn(), getComments: vi.fn() },
  challengeApi: { list: vi.fn() },
}));
vi.mock('../story', async () => {
  const { StoryCirclesRowStub, StoryViewerStub } = await import('../../test/fixtures/dashboard');
  return { StoryCirclesRow: StoryCirclesRowStub, StoryViewer: StoryViewerStub };
});
vi.mock('../ui', async (importOriginal) => {
  const { PullToRefreshStub } = await import('../../test/fixtures/dashboard');
  return {
    ...(await importOriginal<typeof import('../ui')>()),
    PullToRefreshWrapper: PullToRefreshStub,
  };
});
vi.mock('../../utils/sounds', () => ({ playActivitySound: vi.fn(), playCompletionSound: vi.fn() }));
vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

// The theme store (store barrel) reads matchMedia when its module loads, before the shared
// setup stubs it for each test.
await vi.hoisted(async () => {
  const { createMatchMedia } = await import('../../test/browser-mocks');
  vi.stubGlobal('matchMedia', createMatchMedia());
});

/** Alice logged 1.5h of study today, towards her "Study 2h+ a day" challenge. */
const aliceDay = { success: true, data: [makeActivity({ name: 'study', hours: 1.5 })] };
const studyChallenge = makeChallengeSummary();

/** Renders alice's own day and waits for her tiles. */
async function renderOwnDay() {
  const view = renderWithRouter(<Dashboard />, { route: '/', path: '/' });
  await screen.findByRole('button', { name: 'Study, 1.5 hours' });
  return view;
}

const findStrip = () => screen.findByRole('region', { name: 'Challenges' });
const queryStrip = () => screen.queryByRole('region', { name: 'Challenges' });
const studyCard = () => screen.getByRole('link', { name: /^Study 2h\+ a day/ });
const hoursField = () => screen.getByRole('textbox', { name: 'Hours' });

/** Logs `hours` of study through the tile's dialog. */
async function logStudy(user: ReturnType<typeof renderWithRouter>['user'], hours: string) {
  await user.click(screen.getByRole('button', { name: 'Study, 1.5 hours' }));
  const dialog = screen.getByRole('dialog', { name: 'Log Study' });
  await user.clear(hoursField());
  await user.type(hoursField(), hours);
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
}

describe('Dashboard challenges strip', () => {
  beforeEach(() => {
    vi.setSystemTime(FIXED_TODAY);
    // Overlay history logs its steps with console.debug in development builds
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    signIn(ALICE);
    routeApi(api, dashboardRoutes({ 'POST /get-activities': aliceDay }));
    mockQuietSocial({ likeApi, commentApi });
    mockChallengeList(challengeApi, [studyChallenge, makeUpcomingSummary()]);
    resetStoryStubs();
  });

  it('shows the active challenges on the own day, linking to each', async () => {
    await renderOwnDay();

    const strip = await findStrip();
    expect(within(strip).getAllByRole('listitem')).toHaveLength(1);
    expect(studyCard()).toHaveAttribute('href', '/challenges/42');
    expect(studyCard()).toHaveTextContent('Day 5/21');
    expect(studyCard()).toHaveTextContent('1.5 / 2h today');
    expect(challengeApi.list).toHaveBeenCalledTimes(1);
  });

  it('stays hidden without active challenges', async () => {
    mockChallengeList(challengeApi, [makeUpcomingSummary()]);
    await renderOwnDay();

    await waitFor(() => expect(challengeApi.list).toHaveBeenCalledTimes(1));
    expect(queryStrip()).not.toBeInTheDocument();
  });

  it('stays hidden, without disturbing the day, when challenges cannot load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(challengeApi.list).mockRejectedValue(new TypeError('Failed to fetch'));
    await renderOwnDay();

    await waitFor(() =>
      expect(gl.warn).toHaveBeenCalledWith('challenge_strip_hidden', {
        metadata: { reason: 'list_failed' },
      })
    );
    expect(gl.warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Challenges] Could not load the challenge list',
      expect.objectContaining({ recovery: 'show_retry' })
    );
    expect(queryStrip()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Study, 1.5 hours' })).toBeInTheDocument();
  });

  it('shows only on today, reusing the list it just loaded', async () => {
    routeApi(
      api,
      dashboardRoutes({
        'POST /get-activities': (body: unknown) =>
          (body as { start_date: string }).start_date === TODAY_KEY
            ? aliceDay
            : { success: true, data: [makeActivity({ name: 'workout', hours: 1 })] },
      })
    );
    const { user } = await renderOwnDay();
    await findStrip();

    await user.click(screen.getByRole('button', { name: 'Previous day' }));
    await screen.findByRole('button', { name: 'Workout, 1 hour' });
    expect(screen.getByRole('region', { name: 'Yesterday summary' })).toBeInTheDocument();
    expect(queryStrip()).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next day' }));
    expect(await findStrip()).toBeInTheDocument();
    expect(challengeApi.list).toHaveBeenCalledTimes(1);
  });

  it('steps aside in edit mode', async () => {
    await renderOwnDay();
    await findStrip();

    act(() => void window.dispatchEvent(new Event('toggleEditMode')));

    expect(await screen.findByRole('toolbar', { name: 'Customize tiles' })).toBeInTheDocument();
    expect(queryStrip()).not.toBeInTheDocument();
  });

  it('is not shown on someone else’s day', async () => {
    renderWithRouter(<Dashboard />, { route: '/user/bob', path: '/user/:username' });

    await screen.findByRole('button', { name: 'Study, 1.5 hours' });
    expect(await screen.findByRole('region', { name: "bob's profile" })).toBeInTheDocument();
    expect(queryStrip()).not.toBeInTheDocument();
    expect(challengeApi.list).not.toHaveBeenCalled();
  });

  it('refreshes challenge progress after hours are saved', async () => {
    const { user } = await renderOwnDay();
    await findStrip();
    mockChallengeList(challengeApi, [
      makeChallengeSummary({ me: makeProgress({ today_hours: 2.5, today_status: 'met' }) }),
    ]);

    await logStudy(user, '2.5');

    expect(await screen.findByText('Activity saved successfully')).toBeInTheDocument();
    await waitFor(() => expect(studyCard()).toHaveTextContent('2.5 / 2h today'));
    expect(challengeApi.list).toHaveBeenCalledTimes(2);
  });

  it('keeps the challenges as they are when saving fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    routeApi(
      api,
      dashboardRoutes({
        'POST /get-activities': aliceDay,
        'POST /create-activity': { success: false, error: 'Daily limit reached' },
      })
    );
    const { user } = await renderOwnDay();
    await findStrip();

    await logStudy(user, '2.5');

    expect(await screen.findByText('Failed to save activity')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(
      '[ActivityModal] Save failed; keeping the dialog open for retry',
      { activity: 'study' }
    );
    expect(challengeApi.list).toHaveBeenCalledTimes(1);
    expect(studyCard()).toHaveTextContent('1.5 / 2h today');
  });
});
