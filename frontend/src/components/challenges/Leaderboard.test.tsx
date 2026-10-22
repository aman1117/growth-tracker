import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  ALICE_USER,
  makeChallengeDetail,
  makeChallengeUser,
  makeParticipant,
  makeProgress,
} from '../../test/fixtures/challenges';
import type { ChallengeDetail } from '../../types';
import { Leaderboard } from './Leaderboard';

function renderBoard(challenge: ChallengeDetail, pending: number[] = []) {
  const onCheer = vi.fn();
  const user = userEvent.setup();
  render(
    <Leaderboard challenge={challenge} pendingCheerIds={new Set(pending)} onCheer={onCheer} />
  );
  return { onCheer, user };
}

const rows = () => within(screen.getByRole('list')).getAllByRole('listitem');
const row = (username: string) =>
  rows().find((item) => within(item).queryByText(username, { exact: true }))!;

describe('Leaderboard', () => {
  it('lists everyone in the given order with their progress', () => {
    renderBoard(makeChallengeDetail());

    expect(screen.getByRole('heading', { name: 'Leaderboard' })).toBeInTheDocument();
    expect(screen.getByText('3 people')).toBeInTheDocument();
    expect(
      rows().map((item) => within(item).getAllByText(/^(alice|bob|carol)$/)[0].textContent)
    ).toEqual(['alice', 'bob', 'carol']);

    const me = row('alice');
    expect(me).toHaveTextContent('Rank 1');
    expect(within(me).getByText('You')).toBeInTheDocument();
    expect(me).toHaveTextContent('3/21 days');
    expect(me).toHaveTextContent('2-day streak');
    expect(
      within(me).getByRole('img', { name: 'Last 5 days: 3 met, 1 missed, 1 pending' })
    ).toBeVisible();
    expect(me).toHaveTextContent('Not done yet today: 1.5 / 2h today');
    expect(within(me).queryByRole('button')).not.toBeInTheDocument();

    const bob = row('bob');
    expect(bob).toHaveTextContent('Rank 2');
    expect(within(bob).getByRole('img', { name: 'bob' })).toHaveAttribute(
      'src',
      'https://cdn.test/bob-thumb.jpg'
    );
    expect(within(bob).getByRole('img', { name: 'Verified account' })).toBeInTheDocument();
    expect(bob).toHaveTextContent('Done today: 2 / 2h today');
  });

  it('shows a late joiner with the days before they joined', () => {
    renderBoard(makeChallengeDetail());

    const carol = row('carol');
    expect(within(carol).getByText('C')).toBeInTheDocument();
    expect(
      within(carol).getByRole('img', {
        name: 'Last 5 days: 1 missed, 1 pending, 3 not taking part',
      })
    ).toBeInTheDocument();
    expect(carol).not.toHaveTextContent('streak');
  });

  it('lets the user cheer the others, once a day', async () => {
    const challenge = makeChallengeDetail();
    challenge.participants[2] = { ...challenge.participants[2], cheered_today: true };
    const { onCheer, user } = renderBoard(challenge);

    const cheerBob = screen.getByRole('button', { name: 'Cheer bob' });
    expect(cheerBob).toHaveTextContent('Cheer');
    await user.click(cheerBob);
    expect(onCheer).toHaveBeenCalledExactlyOnceWith(challenge.participants[1]);

    const cheerCarol = screen.getByRole('button', { name: 'Cheer carol' });
    expect(cheerCarol).toBeDisabled();
    expect(cheerCarol).toHaveTextContent('Cheered');
    expect(cheerCarol).toHaveAttribute('title', 'You cheered carol today');
  });

  it('disables a cheer that is being sent', () => {
    renderBoard(makeChallengeDetail(), [2]);

    expect(screen.getByRole('button', { name: 'Cheer bob' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cheer carol' })).toBeEnabled();
  });

  it('shows who is in an upcoming challenge without ranks, days or cheers', () => {
    const challenge = makeChallengeDetail({
      status: 'upcoming',
      day_number: null,
      participants: [
        makeParticipant({ ...makeProgress({ rank: null }), user: ALICE_USER, is_me: true }),
        makeParticipant({ ...makeProgress({ rank: null }) }),
      ],
    });
    renderBoard(challenge);

    expect(screen.getByRole('heading', { name: "Who's in" })).toBeInTheDocument();
    expect(screen.queryByText(/Rank/)).not.toBeInTheDocument();
    expect(screen.queryByText(/days/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows medals and completion once the results are final', () => {
    const challenge = makeChallengeDetail({
      status: 'ended',
      finalized: true,
      day_number: null,
      participants: [
        makeParticipant({ user: ALICE_USER, is_me: true, rank: 1, completed: true }),
        makeParticipant({ rank: 2, completed: false, today_status: null }),
        makeParticipant({ user: makeChallengeUser({ id: 3, username: 'carol' }), rank: 3 }),
        makeParticipant({ user: makeChallengeUser({ id: 4, username: 'dave' }), rank: 4 }),
      ],
    });
    renderBoard(challenge);

    const medals = rows().map((item) => !!item.querySelector('.lucide-medal'));
    expect(medals).toEqual([true, true, true, false]);
    expect(within(row('alice')).getByText('Completed')).toBeInTheDocument();
    expect(within(row('bob')).queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
  });

  it('shows no medals before the results are final, and a dash without a rank', () => {
    const challenge = makeChallengeDetail({
      status: 'ended',
      finalized: false,
      participants: [makeParticipant({ user: ALICE_USER, is_me: true, rank: null })],
    });
    renderBoard(challenge);

    expect(rows()[0]).toHaveTextContent('No rank yet');
    expect(rows()[0].querySelector('.lucide-medal')).toBeNull();
  });

  it('collapses a big group to the top ten plus the user', async () => {
    const participants = Array.from({ length: 50 }, (_, index) =>
      makeParticipant({
        user: makeChallengeUser({
          id: index + 1,
          username: index === 24 ? ALICE_USER.username : `racer_with_a_long_name_${index + 1}`,
        }),
        is_me: index === 24,
        rank: index + 1,
      })
    );
    const { user } = renderBoard(makeChallengeDetail({ participants, participant_count: 50 }));

    expect(rows()).toHaveLength(11);
    expect(rows()[10]).toHaveTextContent('Rank 25');
    const toggle = screen.getByRole('button', { name: 'Show all 50' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(rows()).toHaveLength(50);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('does not repeat the user when they are in the top ten', () => {
    const participants = Array.from({ length: 12 }, (_, index) =>
      makeParticipant({
        user: makeChallengeUser({ id: index + 1 }),
        is_me: index === 0,
        rank: index + 1,
      })
    );
    renderBoard(makeChallengeDetail({ participants, participant_count: 12 }));

    expect(rows()).toHaveLength(10);
  });
});
