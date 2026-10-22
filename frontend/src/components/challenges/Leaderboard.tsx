/**
 * Leaderboard
 *
 * Everyone taking part, in the server's order (by rank once the challenge runs): rank (medals
 * for the top three once results are final), progress, streak, the last seven days, today's
 * status and a Cheer button for the others while the challenge runs.
 *
 * Long lists are collapsed to the top ten — plus the user's own row when it is further down.
 */

import { CheckCircle2, Flame, Medal, PartyPopper } from 'lucide-react';
import React, { useId, useState } from 'react';

import type { ChallengeDayStatus, ChallengeDetail, ChallengeParticipant } from '../../types';
import {
  formatPeopleCount,
  formatStreak,
  getRecentDays,
  summarizeDays,
} from '../../utils/challenges';
import { Avatar, Button, VerifiedBadge } from '../ui';
import layout from './ChallengeLayout.module.css';
import styles from './Leaderboard.module.css';
import { TodayStatusChip } from './TodayStatusChip';

/** Rows shown before "Show all" */
export const LEADERBOARD_COLLAPSED_ROWS = 10;

interface LeaderboardProps {
  challenge: ChallengeDetail;
  /** People whose cheer is being sent */
  pendingCheerIds: ReadonlySet<number>;
  onCheer: (participant: ChallengeParticipant) => void;
}

const MEDALS: Record<number, string> = { 1: styles.gold, 2: styles.silver, 3: styles.bronze };

const DOT_CLASSES: Record<ChallengeDayStatus, string> = {
  met: styles.dotMet,
  missed: styles.dotMissed,
  pending: styles.dotPending,
  upcoming: styles.dotUpcoming,
  none: styles.dotNone,
};

const RankBadge: React.FC<{ rank: number | null; finalized: boolean }> = ({ rank, finalized }) => {
  if (rank === null) {
    return (
      <span className={styles.rank}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">No rank yet</span>
      </span>
    );
  }
  const medal = finalized ? MEDALS[rank] : undefined;
  return (
    <span className={`${styles.rank} ${medal ?? ''}`}>
      {medal && <Medal size={14} strokeWidth={2.4} aria-hidden="true" />}
      <span className="sr-only">Rank </span>
      {rank}
    </span>
  );
};

const RecentDays: React.FC<{ statuses: ChallengeDayStatus[] }> = ({ statuses }) => (
  <span
    className={styles.dots}
    role="img"
    aria-label={`Last ${statuses.length} ${statuses.length === 1 ? 'day' : 'days'}: ${summarizeDays(statuses)}`}
  >
    {statuses.map((status, index) => (
      <span key={index} className={`${styles.dot} ${DOT_CLASSES[status]}`} />
    ))}
  </span>
);

const LeaderboardRow: React.FC<{
  participant: ChallengeParticipant;
  challenge: ChallengeDetail;
  isCheerPending: boolean;
  onCheer: (participant: ChallengeParticipant) => void;
}> = ({ participant, challenge, isCheerPending, onCheer }) => {
  const { user } = participant;
  const isActive = challenge.status === 'active';
  const isUpcoming = challenge.status === 'upcoming';
  const streak = isUpcoming ? null : formatStreak(participant.current_streak);
  const recent = isUpcoming
    ? []
    : getRecentDays(participant.days, challenge.start_date, challenge.today);
  const cheered = participant.cheered_today;

  return (
    <li className={`${styles.row} ${participant.is_me ? styles.rowMe : ''}`}>
      {!isUpcoming && <RankBadge rank={participant.rank} finalized={challenge.finalized} />}
      <Avatar
        src={user.profile_pic}
        thumbnailSrc={user.profile_pic_thumb}
        name={user.username}
        size="md"
        className={styles.avatar}
      />
      <div className={styles.info}>
        <div className={styles.nameLine}>
          <span className={styles.name}>{user.username}</span>
          {user.is_verified && <VerifiedBadge size={14} />}
          {participant.is_me && <span className={styles.youTag}>You</span>}
        </div>
        {!isUpcoming && (
          <div className={styles.stats}>
            <span className={styles.statDays}>
              {participant.days_met}/{participant.days_possible} days
            </span>
            {streak && (
              <span className={styles.streak}>
                <Flame size={12} strokeWidth={2.5} aria-hidden="true" />
                {streak}
              </span>
            )}
            {challenge.finalized && participant.completed && (
              <span className={styles.completed}>
                <CheckCircle2 size={12} strokeWidth={2.6} aria-hidden="true" />
                Completed
              </span>
            )}
          </div>
        )}
      </div>
      {(recent.length > 0 || (isActive && participant.today_status !== null)) && (
        <div className={styles.activity}>
          {recent.length > 0 && <RecentDays statuses={recent} />}
          {isActive && (
            <TodayStatusChip
              activity={challenge.activity}
              goalType={challenge.goal_type}
              targetHours={challenge.target_hours}
              todayHours={participant.today_hours}
              todayStatus={participant.today_status}
            />
          )}
        </div>
      )}
      {isActive && !participant.is_me && (
        <Button
          size="sm"
          variant={cheered ? 'ghost' : 'secondary'}
          icon={<PartyPopper size={15} />}
          className={`${layout.touchTarget} ${styles.cheer}`}
          disabled={cheered || isCheerPending}
          aria-label={`Cheer ${user.username}`}
          title={cheered ? `You cheered ${user.username} today` : undefined}
          onClick={() => onCheer(participant)}
        >
          {cheered ? 'Cheered' : 'Cheer'}
        </Button>
      )}
    </li>
  );
};

export const Leaderboard: React.FC<LeaderboardProps> = ({
  challenge,
  pendingCheerIds,
  onCheer,
}) => {
  const titleId = useId();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const { participants } = challenge;
  const isCollapsible = participants.length > LEADERBOARD_COLLAPSED_ROWS;

  let visible = participants;
  if (isCollapsible && !expanded) {
    visible = participants.slice(0, LEADERBOARD_COLLAPSED_ROWS);
    const me = participants.find((participant) => participant.is_me);
    if (me && !visible.includes(me)) visible = [...visible, me];
  }

  return (
    <section className={layout.card} aria-labelledby={titleId}>
      <div className={layout.cardHeader}>
        <h2 id={titleId} className={layout.cardTitle}>
          {challenge.status === 'upcoming' ? "Who's in" : 'Leaderboard'}
        </h2>
        <span className={styles.count}>{formatPeopleCount(challenge.participant_count)}</span>
      </div>

      <ol id={listId} className={styles.list}>
        {visible.map((participant) => (
          <LeaderboardRow
            key={participant.user.id}
            participant={participant}
            challenge={challenge}
            isCheerPending={pendingCheerIds.has(participant.user.id)}
            onCheer={onCheer}
          />
        ))}
      </ol>

      {isCollapsible && (
        <Button
          variant="ghost"
          size="sm"
          fullWidth
          className={`${layout.touchTarget} ${styles.toggle}`}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer' : `Show all ${participants.length}`}
        </Button>
      )}
    </section>
  );
};
