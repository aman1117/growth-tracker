/**
 * ChallengeHero
 *
 * The top of a challenge: activity and rule, dates and status, who is taking part, and — for
 * participants who may invite — Invite and Share link.
 */

import { Share2, UserPlus } from 'lucide-react';
import React from 'react';

import type { ChallengeDetail } from '../../types';
import {
  formatDateRange,
  formatPeopleCount,
  formatRuleText,
  formatStatusText,
} from '../../utils/challenges';
import { AvatarStack, Button } from '../ui';
import { ActivityChip } from './ActivityChip';
import styles from './ChallengeHero.module.css';
import layout from './ChallengeLayout.module.css';

interface ChallengeHeroProps {
  challenge: ChallengeDetail;
  onInvite: () => void;
  onShare: () => void;
  isSharing: boolean;
}

export const ChallengeHero: React.FC<ChallengeHeroProps> = ({
  challenge,
  onInvite,
  onShare,
  isSharing,
}) => {
  const people = challenge.participants.map(({ user }) => ({
    id: user.id,
    name: user.username,
    src: user.profile_pic,
    thumbnailSrc: user.profile_pic_thumb,
  }));

  return (
    <section className={`${layout.card} ${styles.hero}`} aria-label="Challenge details">
      <div className={styles.goal}>
        <ActivityChip activity={challenge.activity} size="lg" />
        <div className={styles.goalText}>
          <p className={styles.rule}>{formatRuleText(challenge)}</p>
          <p className={styles.dates}>
            {formatDateRange(challenge.start_date, challenge.end_date)} ·{' '}
            {formatStatusText(challenge, challenge.today)}
          </p>
        </div>
      </div>

      <div className={styles.people}>
        <AvatarStack people={people} max={5} total={challenge.participant_count} size="sm" />
        <p className={styles.peopleText}>
          <span className={styles.peopleCount}>
            {formatPeopleCount(challenge.participant_count)}
          </span>
          <span className={styles.creator}>Started by {challenge.creator.username}</span>
        </p>
      </div>

      {challenge.can_invite && (
        <div className={styles.actions}>
          <Button
            icon={<UserPlus size={16} />}
            className={`${layout.touchTarget} ${styles.action}`}
            onClick={onInvite}
            aria-haspopup="dialog"
          >
            Invite
          </Button>
          <Button
            variant="secondary"
            icon={<Share2 size={16} />}
            className={`${layout.touchTarget} ${styles.action}`}
            onClick={onShare}
            disabled={isSharing}
          >
            Share link
          </Button>
        </div>
      )}
    </section>
  );
};
