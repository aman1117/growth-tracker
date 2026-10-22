/**
 * JoinChallengePage (/c/:code)
 *
 * Where an invite link leads: what the challenge is, who started it and who is in, and the
 * way in — "Join challenge", "Open challenge" for participants, or why joining is not
 * possible (ended, full, or the user is in too many challenges). Anyone who left a challenge
 * can join it again here. Signed-out visitors log in first and come back (ProtectedRoute).
 */

import { AlertTriangle, ArrowRight, Link2Off, RefreshCw, UserPlus } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { APP_ROUTES } from '../../constants/routes';
import { useSmartBack } from '../../hooks/useSmartBack';
import { challengeApi } from '../../services/api';
import { useChallengeStore } from '../../store';
import type { ChallengeJoinBlockedReason, ChallengePreview } from '../../types';
import {
  formatDateRange,
  formatPeopleCount,
  formatRuleText,
  formatStatusText,
  getChallengeErrorMessage,
  getErrorStatus,
  getIstToday,
  getJoinBlockedMessage,
  getJoinBlockedReason,
} from '../../utils/challenges';
import { AvatarStack, Button, EmptyState, PageHeader, Skeleton, VerifiedBadge } from '../ui';
import { ActivityChip } from './ActivityChip';
import type { ChallengeDetailLocationState } from './ChallengeDetailPage';
import { logChallengeFailure } from './challengeEffects';
import layout from './ChallengeLayout.module.css';
import styles from './JoinChallengePage.module.css';

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: ChallengePreview }
  | { status: 'invalid' }
  | { status: 'error'; message: string };

/** The server answers 404 for an unknown code and 400 for a malformed one; retrying won't help */
const isInvalidInviteLink = (error: unknown): boolean => {
  const status = getErrorStatus(error);
  return status === 404 || status === 400;
};

export const JoinChallengePage: React.FC = () => {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const goBack = useSmartBack(APP_ROUTES.CHALLENGES);
  const upsertFromDetail = useChallengeStore((state) => state.upsertFromDetail);
  const titleId = useId();
  const reasonId = useId();
  const joinErrorId = useId();

  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const joiningRef = useRef(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isCurrent = () => mountedRef.current && requestId === requestIdRef.current;
    setState({ status: 'loading' });
    if (!code.trim()) {
      setState({ status: 'invalid' });
      return;
    }
    try {
      const { preview } = await challengeApi.getPreview(code);
      if (isCurrent()) setState({ status: 'ready', preview });
    } catch (error) {
      if (!isCurrent()) return;
      if (isInvalidInviteLink(error)) {
        logChallengeFailure('invite_link_invalid', error, { recovery: 'show_invalid_link' });
        setState({ status: 'invalid' });
        return;
      }
      logChallengeFailure('preview_load_failed', error, { recovery: 'show_retry' });
      setState({ status: 'error', message: getChallengeErrorMessage(error, 'load') });
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  const openChallenge = (id: number, arrival?: ChallengeDetailLocationState) =>
    navigate(APP_ROUTES.CHALLENGE(id), { replace: true, state: arrival });

  const blockJoining = (preview: ChallengePreview, reason: ChallengeJoinBlockedReason) =>
    setState({
      status: 'ready',
      preview: { ...preview, can_join: false, join_blocked_reason: reason },
    });

  const handleJoin = async (preview: ChallengePreview) => {
    if (joiningRef.current) return;
    joiningRef.current = true;
    setIsJoining(true);
    setJoinError(null);
    try {
      const { challenge } = await challengeApi.join(code);
      upsertFromDetail(challenge);
      if (mountedRef.current) openChallenge(challenge.id, { joined: true });
    } catch (error) {
      const reason = getJoinBlockedReason(error);
      logChallengeFailure('join_failed', error, {
        recovery: reason ? 'show_blocked_reason' : 'show_error',
        challengeId: preview.id,
      });
      if (!mountedRef.current) return;
      joiningRef.current = false;
      setIsJoining(false);
      if (reason) blockJoining(preview, reason);
      else setJoinError(getChallengeErrorMessage(error, 'join'));
    }
  };

  const renderAction = (preview: ChallengePreview) => {
    if (preview.is_participant) {
      return (
        <Button
          size="lg"
          fullWidth
          iconRight={<ArrowRight size={18} />}
          className={layout.touchTarget}
          onClick={() => openChallenge(preview.id)}
        >
          Open challenge
        </Button>
      );
    }

    if (preview.can_join) {
      return (
        <>
          <Button
            size="lg"
            fullWidth
            icon={<UserPlus size={18} />}
            className={layout.touchTarget}
            loading={isJoining}
            onClick={() => void handleJoin(preview)}
            aria-describedby={joinError ? joinErrorId : undefined}
          >
            {isJoining ? 'Joining…' : 'Join challenge'}
          </Button>
          {joinError && (
            <p id={joinErrorId} className={styles.error} role="alert">
              {joinError}
            </p>
          )}
        </>
      );
    }

    const reason = preview.join_blocked_reason
      ? getJoinBlockedMessage(preview.join_blocked_reason)
      : "You can't join this challenge";
    return (
      <>
        <p id={reasonId} className={styles.reason} role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          {reason}
        </p>
        <Button
          size="lg"
          fullWidth
          disabled
          className={layout.touchTarget}
          aria-describedby={reasonId}
        >
          Join challenge
        </Button>
      </>
    );
  };

  const renderBody = () => {
    if (state.status === 'loading') {
      return (
        <section className={layout.card} aria-hidden="true">
          <div className={styles.skeletonTop}>
            <Skeleton width={56} height={56} radius="lg" />
            <div className={styles.skeletonText}>
              <Skeleton width="70%" height={20} />
              <Skeleton width="50%" height={14} />
            </div>
          </div>
          <Skeleton width="100%" height={48} radius="lg" />
        </section>
      );
    }

    if (state.status === 'invalid') {
      return (
        <section className={`${layout.card} ${layout.stateCard}`}>
          <EmptyState
            icon={<Link2Off size={26} />}
            title="This invite link isn't valid"
            description="Check the link, or ask your friend to send it again."
            action={{
              label: 'Go to your challenges',
              variant: 'secondary',
              onClick: () => navigate(APP_ROUTES.CHALLENGES, { replace: true }),
            }}
          />
        </section>
      );
    }

    if (state.status === 'error') {
      return (
        <section className={`${layout.card} ${layout.stateCard}`} role="alert">
          <EmptyState
            icon={<AlertTriangle size={26} />}
            title="Couldn't open this invite"
            description={state.message}
            action={{
              label: 'Try again',
              icon: <RefreshCw size={16} />,
              onClick: () => void load(),
            }}
          />
        </section>
      );
    }

    const { preview } = state;
    const people = preview.participants_preview.map((user) => ({
      id: user.id,
      name: user.username,
      src: user.profile_pic,
      thumbnailSrc: user.profile_pic_thumb,
    }));

    return (
      <section className={`${layout.card} ${styles.preview}`} aria-labelledby={titleId}>
        <div className={styles.top}>
          <ActivityChip activity={preview.activity} size="lg" />
          <div className={styles.heading}>
            <h2 id={titleId} className={styles.title}>
              {preview.title}
            </h2>
            <p className={styles.rule}>{formatRuleText(preview)}</p>
          </div>
        </div>

        <p className={styles.dates}>
          {formatDateRange(preview.start_date, preview.end_date)} ·{' '}
          {formatStatusText({ ...preview, day_number: null }, getIstToday())}
        </p>

        <p className={styles.creator}>
          Started by <span className={styles.creatorName}>{preview.creator.username}</span>
          {preview.creator.is_verified && <VerifiedBadge size={14} />}
        </p>

        <div className={styles.people}>
          <AvatarStack people={people} max={5} total={preview.participant_count} size="sm" />
          <span className={styles.peopleCount}>{formatPeopleCount(preview.participant_count)}</span>
        </div>

        <div className={styles.action}>{renderAction(preview)}</div>
      </section>
    );
  };

  return (
    <div className={`${layout.page} ${layout.pagePushed}`} aria-busy={state.status === 'loading'}>
      <PageHeader title="Join challenge" onBack={goBack} />
      {renderBody()}
    </div>
  );
};

export default JoinChallengePage;
