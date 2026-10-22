/**
 * ChallengesPage (/challenges)
 *
 * The Challenges tab: the user's active, upcoming and ended challenges, and the way to start
 * a new one. The list lives in the challenge store, so coming back from a challenge shows it
 * at once; it refreshes when the tab is tapped again and when the app regains focus.
 */

import { AlertTriangle, Plus, RefreshCw, Trophy } from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useRefreshOnFocus } from '../../hooks/useRefreshOnFocus';
import { gl } from '../../services/goodlogs';
import { useChallengeStore } from '../../store';
import type { ChallengeStatus, ChallengeSummary } from '../../types';
import { getIstToday, groupChallengesByStatus } from '../../utils/challenges';
import { TAB_RESELECT_EVENT, type TabReselectDetail } from '../../utils/navigation';
import { Button, EmptyState, PageHeader, SkeletonCard, SnapToast } from '../ui';
import { ChallengeCard } from './ChallengeCard';
import layout from './ChallengeLayout.module.css';
import { CreateChallengeSheet } from './CreateChallengeSheet';

/** Location state of /challenges after leaving or deleting a challenge */
export interface ChallengesPageState {
  notice?: 'left' | 'deleted';
}

const NOTICES: Record<NonNullable<ChallengesPageState['notice']>, string> = {
  left: 'You left the challenge',
  deleted: 'Challenge deleted',
};

const SECTIONS: { status: ChallengeStatus; title: string }[] = [
  { status: 'active', title: 'Active' },
  { status: 'upcoming', title: 'Upcoming' },
  { status: 'ended', title: 'Ended' },
];

const ChallengeSection: React.FC<{
  title: string;
  challenges: ChallengeSummary[];
  today: string;
}> = ({ title, challenges, today }) => {
  const headingId = useId();
  return (
    <section className={layout.section} aria-labelledby={headingId}>
      <div className={layout.sectionHeader}>
        <h2 id={headingId} className={layout.sectionTitle}>
          {title}
        </h2>
        <span className={layout.sectionCount} aria-hidden="true">
          {challenges.length}
        </span>
      </div>
      <ul className={layout.list}>
        {challenges.map((challenge) => (
          <li key={challenge.id}>
            <ChallengeCard challenge={challenge} today={today} />
          </li>
        ))}
      </ul>
    </section>
  );
};

export const ChallengesPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const challenges = useChallengeStore((state) => state.challenges);
  const status = useChallengeStore((state) => state.status);
  const fetchChallenges = useChallengeStore((state) => state.fetchChallenges);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const today = getIstToday();

  useEffect(() => {
    void fetchChallenges();
  }, [fetchChallenges]);

  // A notice handed over by the challenge screen (left / deleted) is shown once
  const notice = (location.state as ChallengesPageState | null)?.notice;
  useEffect(() => {
    if (!notice) return;
    setToast(NOTICES[notice] ?? null);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [notice, navigate, location.pathname, location.search]);

  // Tapping the tab again refreshes the list (scrolling up is done by the tab bar)
  useEffect(() => {
    const handleReselect = (event: Event) => {
      if ((event as CustomEvent<TabReselectDetail>).detail?.tab !== 'challenges') return;
      void fetchChallenges({ force: true });
    };
    window.addEventListener(TAB_RESELECT_EVENT, handleReselect);
    return () => window.removeEventListener(TAB_RESELECT_EVENT, handleReselect);
  }, [fetchChallenges]);

  const refreshOnFocus = useCallback(() => void fetchChallenges(), [fetchChallenges]);
  useRefreshOnFocus(refreshOnFocus, { enabled: status === 'ready' });

  const sections = useMemo(() => groupChallengesByStatus(challenges), [challenges]);

  const openCreate = (source: 'header' | 'empty_state') => {
    gl.track('challenge_create_opened', { properties: { source } });
    setIsCreateOpen(true);
  };

  const renderContent = () => {
    if (challenges.length === 0 && (status === 'idle' || status === 'loading')) {
      return (
        <div className={layout.list} aria-hidden="true">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
          <SkeletonCard lines={3} />
        </div>
      );
    }

    if (challenges.length === 0 && status === 'error') {
      return (
        <section className={`${layout.card} ${layout.stateCard}`} role="alert">
          <EmptyState
            icon={<AlertTriangle size={26} />}
            title="Couldn't load your challenges"
            description="Check your connection and try again."
            action={{
              label: 'Try again',
              icon: <RefreshCw size={16} />,
              onClick: () => void fetchChallenges({ force: true }),
            }}
          />
        </section>
      );
    }

    if (challenges.length === 0) {
      return (
        <section className={`${layout.card} ${layout.stateCard}`}>
          <EmptyState
            icon={<Trophy size={26} />}
            title="Challenge your friends"
            description="Pick an activity and a daily goal. Everyone's logged hours count automatically."
            action={{
              label: 'Start a challenge',
              icon: <Plus size={16} />,
              onClick: () => openCreate('empty_state'),
            }}
          />
        </section>
      );
    }

    return SECTIONS.map(({ status: sectionStatus, title }) =>
      sections[sectionStatus].length > 0 ? (
        <ChallengeSection
          key={sectionStatus}
          title={title}
          challenges={sections[sectionStatus]}
          today={today}
        />
      ) : null
    );
  };

  return (
    <div className={layout.page} aria-busy={status === 'loading'}>
      <PageHeader
        title="Challenges"
        actions={
          <Button
            size="sm"
            icon={<Plus size={16} />}
            className={layout.touchTarget}
            onClick={() => openCreate('header')}
          >
            New challenge
          </Button>
        }
      />

      {renderContent()}

      <CreateChallengeSheet
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        today={today}
      />

      {toast && <SnapToast message={toast} type="success" onClose={() => setToast(null)} />}
    </div>
  );
};

export default ChallengesPage;
