/**
 * ChallengeDetailPage (/challenges/:id)
 *
 * One challenge: the goal and who takes part, the user's progress and days, the leaderboard
 * with cheers, and — depending on permissions — invite, share, leave and delete.
 *
 * - Data is fetched on every visit (the list summary fills the header meanwhile) and again,
 *   quietly, when the app regains focus so the leaderboard stays fresh.
 * - The view is keyed by id: switching challenges starts over, and answers for the previous
 *   challenge are ignored.
 * - "Not found" covers deleted challenges and challenges the user is not taking part in.
 */

import {
  AlertTriangle,
  Clock,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  SearchX,
  Trash2,
  UserPlus,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { CHALLENGE_ERROR_CODES } from '../../constants/challenges';
import { APP_ROUTES } from '../../constants/routes';
import { useRefreshOnFocus } from '../../hooks/useRefreshOnFocus';
import { useSmartBack } from '../../hooks/useSmartBack';
import { challengeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import { useChallengeStore } from '../../store';
import type { ChallengeDetail, ChallengeInvitesResponse, ChallengeParticipant } from '../../types';
import {
  buildInviteLink,
  formatShortDate,
  getChallengeErrorMessage,
  getErrorCode,
  getErrorStatus,
  isChallengeNotFound,
} from '../../utils/challenges';
import { shareLink } from '../../utils/share';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  PageHeader,
  SkeletonCard,
  SnapToast,
  type SnapToastType,
} from '../ui';
import styles from './ChallengeDetailPage.module.css';
import { afterOverlayCloses, logChallengeFailure } from './challengeEffects';
import { ChallengeHero } from './ChallengeHero';
import layout from './ChallengeLayout.module.css';
import { ChallengeProgressCard } from './ChallengeProgressCard';
import type { ChallengesPageState } from './ChallengesPage';
import { InviteSheet } from './InviteSheet';
import { Leaderboard } from './Leaderboard';

/** Location state when arriving from creating or joining a challenge */
export interface ChallengeDetailLocationState {
  created?: boolean;
  joined?: boolean;
}

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; challenge: ChallengeDetail }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

type ToastState = { message: string; type: SnapToastType } | null;
type ExitAction = 'leave' | 'delete';

/** Largest id the API accepts (it reads ids as unsigned 32-bit numbers) */
const MAX_CHALLENGE_ID = 4_294_967_295;

/** A challenge id from the URL: a whole number the API accepts, else null */
const parseChallengeId = (raw: string | undefined): number | null => {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 && id <= MAX_CHALLENGE_ID ? id : null;
};

/** Keeps "Cheered" on people whose cheer is still being sent when fresh data arrives */
const withPendingCheers = (
  challenge: ChallengeDetail,
  pending: ReadonlySet<number>
): ChallengeDetail =>
  pending.size === 0
    ? challenge
    : {
        ...challenge,
        participants: challenge.participants.map((participant) =>
          pending.has(participant.user.id) ? { ...participant, cheered_today: true } : participant
        ),
      };

const describeInvites = ({ invited, skipped }: ChallengeInvitesResponse): ToastState => {
  if (invited <= 0) {
    return { message: 'No invites sent – they may already be invited', type: 'warning' };
  }
  const friends = `${invited} ${invited === 1 ? 'friend' : 'friends'}`;
  const skippedText = skipped > 0 ? ` (${skipped} couldn't be invited)` : '';
  return { message: `Invited ${friends}${skippedText}`, type: 'success' };
};

const EXIT_DIALOGS: Record<
  ExitAction,
  { title: string; description: string; confirmLabel: string; icon: React.ReactNode }
> = {
  leave: {
    title: 'Leave this challenge?',
    description:
      "Your progress in it will be removed. You can join again with the invite link, but you'll start fresh.",
    confirmLabel: 'Leave',
    icon: <LogOut size={24} strokeWidth={2.25} />,
  },
  delete: {
    title: 'Delete this challenge?',
    description: "It will be removed for everyone, with all progress. This can't be undone.",
    confirmLabel: 'Delete',
    icon: <Trash2 size={24} strokeWidth={2.25} />,
  },
};

const NotFoundView: React.FC = () => {
  const navigate = useNavigate();
  const goBack = useSmartBack(APP_ROUTES.CHALLENGES);
  return (
    <div className={`${layout.page} ${layout.pagePushed}`}>
      <PageHeader title="Challenge" onBack={goBack} />
      <section className={`${layout.card} ${layout.stateCard}`}>
        <EmptyState
          icon={<SearchX size={26} />}
          title="Challenge not found"
          description="It may have been deleted, or you're not taking part."
          action={{
            label: 'See your challenges',
            variant: 'secondary',
            onClick: () => navigate(APP_ROUTES.CHALLENGES, { replace: true }),
          }}
        />
      </section>
    </div>
  );
};

const ChallengeDetailView: React.FC<{ challengeId: number }> = ({ challengeId }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = useSmartBack(APP_ROUTES.CHALLENGES);
  const upsertFromDetail = useChallengeStore((state) => state.upsertFromDetail);
  const removeFromStore = useChallengeStore((state) => state.remove);
  const cachedTitle = useChallengeStore(
    (state) => state.challenges.find((challenge) => challenge.id === challengeId)?.title
  );

  const [state, setState] = useState<DetailState>({ status: 'loading' });
  // How the user got here (created / joined) — read once, then cleared from history
  const [arrival] = useState<ChallengeDetailLocationState>(
    () => (location.state as ChallengeDetailLocationState | null) ?? {}
  );
  const [showInvitePrompt, setShowInvitePrompt] = useState(!!arrival.created);
  const [toast, setToast] = useState<ToastState>(() =>
    arrival.joined
      ? { message: "You're in! Hours you log count automatically.", type: 'success' }
      : null
  );
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const [exitAction, setExitAction] = useState<ExitAction | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [pendingCheers, setPendingCheers] = useState<ReadonlySet<number>>(() => new Set());

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingCheersRef = useRef(new Set<number>());
  const exitingRef = useRef(false);
  const sharingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!location.state) return;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const requestId = ++requestIdRef.current;
      const isCurrent = () => mountedRef.current && requestId === requestIdRef.current;
      if (!silent)
        setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));

      try {
        const { challenge } = await challengeApi.get(challengeId);
        if (!isCurrent()) return;
        setState({
          status: 'ready',
          challenge: withPendingCheers(challenge, pendingCheersRef.current),
        });
        upsertFromDetail(challenge);
      } catch (error) {
        if (!isCurrent()) return;
        if (isChallengeNotFound(error)) {
          logChallengeFailure('detail_not_found', error, {
            recovery: 'show_not_found',
            challengeId,
          });
          removeFromStore(challengeId);
          setState({ status: 'not_found' });
          return;
        }
        logChallengeFailure('detail_load_failed', error, {
          recovery: silent ? 'keep_loaded_detail' : 'show_retry',
          challengeId,
        });
        if (!silent)
          setState({ status: 'error', message: getChallengeErrorMessage(error, 'load') });
      }
    },
    [challengeId, removeFromStore, upsertFromDetail]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const refreshQuietly = useCallback(() => void load({ silent: true }), [load]);
  useRefreshOnFocus(refreshQuietly, { enabled: state.status === 'ready' });

  const setCheered = (userId: number, cheered: boolean) =>
    setState((current) =>
      current.status !== 'ready'
        ? current
        : {
            ...current,
            challenge: {
              ...current.challenge,
              participants: current.challenge.participants.map((participant) =>
                participant.user.id === userId
                  ? { ...participant, cheered_today: cheered }
                  : participant
              ),
            },
          }
    );

  const handleCheer = async (participant: ChallengeParticipant) => {
    const userId = participant.user.id;
    if (participant.cheered_today || pendingCheersRef.current.has(userId)) return;

    pendingCheersRef.current.add(userId);
    setPendingCheers(new Set(pendingCheersRef.current));
    setCheered(userId, true);

    try {
      await challengeApi.cheer(challengeId, userId);
      if (mountedRef.current) {
        setToast({ message: `You cheered ${participant.user.username}`, type: 'success' });
      }
    } catch (error) {
      logChallengeFailure('cheer_failed', error, {
        recovery: 'rollback',
        challengeId,
        toUserId: userId,
      });
      if (mountedRef.current) {
        setCheered(userId, false);
        setToast({ message: getChallengeErrorMessage(error, 'cheer'), type: 'error' });
        // The challenge may have ended or changed: show what is true now
        if (
          getErrorCode(error) === CHALLENGE_ERROR_CODES.NOT_ACTIVE ||
          isChallengeNotFound(error)
        ) {
          void load({ silent: true });
        }
      }
    } finally {
      pendingCheersRef.current.delete(userId);
      if (mountedRef.current) setPendingCheers(new Set(pendingCheersRef.current));
    }
  };

  const handleShare = async (challenge: ChallengeDetail) => {
    if (sharingRef.current) return;
    sharingRef.current = true;
    setIsSharing(true);
    try {
      const outcome = await shareLink({
        url: buildInviteLink(window.location.origin, challenge.invite_code),
        title: challenge.title,
        text: `Join my challenge “${challenge.title}” on Growth Tracker`,
      });
      if (outcome === 'shared' || outcome === 'copied') {
        gl.track('challenge_link_shared', {
          properties: {
            challengeId,
            method: outcome === 'shared' ? 'share' : 'copy',
            source: 'detail',
          },
        });
      }
      if (!mountedRef.current) return;
      if (outcome === 'copied') setToast({ message: 'Invite link copied', type: 'success' });
      if (outcome === 'failed') {
        setToast({ message: "Couldn't share the link. Try Invite instead.", type: 'error' });
      }
    } finally {
      sharingRef.current = false;
      if (mountedRef.current) setIsSharing(false);
    }
  };

  const openInvite = () => {
    gl.track('challenge_invite_opened', { properties: { challengeId } });
    setIsInviteOpen(true);
  };

  const handleInvited = (result: ChallengeInvitesResponse) => {
    setIsInviteOpen(false);
    setShowInvitePrompt(false);
    setToast(describeInvites(result));
  };

  const askToExit = (action: ExitAction) => {
    setIsOptionsOpen(false);
    setExitAction(action);
  };

  const finishExit = (action: ExitAction) => {
    removeFromStore(challengeId);
    const nextState: ChallengesPageState = { notice: action === 'leave' ? 'left' : 'deleted' };
    // Replace this screen (not the dialog's history entry), so Back never returns here
    afterOverlayCloses(() => navigate(APP_ROUTES.CHALLENGES, { replace: true, state: nextState }));
    setExitAction(null);
  };

  const handleConfirmExit = async () => {
    const action = exitAction;
    if (!action || exitingRef.current) return;
    exitingRef.current = true;
    setIsExiting(true);
    try {
      if (action === 'leave') await challengeApi.leave(challengeId);
      else await challengeApi.remove(challengeId);
      if (mountedRef.current) finishExit(action);
    } catch (error) {
      const alreadyGone = isChallengeNotFound(error);
      logChallengeFailure(`${action}_failed`, error, {
        recovery: alreadyGone ? 'treat_as_done' : 'show_error',
        challengeId,
      });
      if (!mountedRef.current) return;
      if (alreadyGone) {
        finishExit(action);
        return;
      }
      exitingRef.current = false;
      setIsExiting(false);
      setExitAction(null);
      setToast({ message: getChallengeErrorMessage(error, action), type: 'error' });
      // e.g. the challenge started or someone joined: refresh what the user may do
      if (getErrorStatus(error) === 409) void load({ silent: true });
    }
  };

  const renderBody = () => {
    if (state.status === 'loading') {
      return (
        <div aria-hidden="true" className={styles.skeletons}>
          <SkeletonCard lines={3} />
          <SkeletonCard avatar lines={4} />
        </div>
      );
    }

    if (state.status === 'error') {
      return (
        <section className={`${layout.card} ${layout.stateCard}`} role="alert">
          <EmptyState
            icon={<AlertTriangle size={26} />}
            title="Couldn't load this challenge"
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

    if (state.status !== 'ready') return null;
    const { challenge } = state;
    const showResultsBanner = challenge.status === 'ended' && !challenge.finalized;

    return (
      <>
        {showInvitePrompt && challenge.can_invite && (
          <Notice
            tone="brand"
            icon={<UserPlus />}
            title="Invite friends to join"
            description="Challenges are more fun together – share the link or invite people you know."
            action={{ label: 'Invite', onClick: openInvite }}
            onDismiss={() => setShowInvitePrompt(false)}
            className={styles.notice}
          />
        )}

        {showResultsBanner && (
          <Notice
            tone="info"
            icon={<Clock />}
            title={`Final results on ${formatShortDate(challenge.results_date)}`}
            description="Days can still be logged or fixed until then."
            className={styles.notice}
          />
        )}

        <ChallengeHero
          challenge={challenge}
          onInvite={openInvite}
          onShare={() => void handleShare(challenge)}
          isSharing={isSharing}
        />

        <ChallengeProgressCard
          challenge={challenge}
          onLogToday={() => {
            gl.track('challenge_log_today_clicked', { properties: { challengeId } });
            navigate(APP_ROUTES.HOME);
          }}
        />

        <Leaderboard
          challenge={challenge}
          pendingCheerIds={pendingCheers}
          onCheer={(participant) => void handleCheer(participant)}
        />

        <InviteSheet
          isOpen={isInviteOpen}
          onClose={() => setIsInviteOpen(false)}
          challengeId={challenge.id}
          challengeTitle={challenge.title}
          inviteCode={challenge.invite_code}
          onInvited={handleInvited}
        />

        <Modal
          isOpen={isOptionsOpen}
          onClose={() => setIsOptionsOpen(false)}
          title="Challenge options"
          size="small"
        >
          <div className={styles.options}>
            {challenge.can_leave && (
              <Button
                variant="secondary"
                fullWidth
                icon={<LogOut size={18} />}
                className={layout.touchTarget}
                onClick={() => askToExit('leave')}
              >
                Leave challenge
              </Button>
            )}
            {challenge.can_delete && (
              <Button
                variant="danger"
                fullWidth
                icon={<Trash2 size={18} />}
                className={layout.touchTarget}
                onClick={() => askToExit('delete')}
              >
                Delete challenge
              </Button>
            )}
          </div>
        </Modal>

        {exitAction && (
          <ConfirmDialog
            title={EXIT_DIALOGS[exitAction].title}
            description={EXIT_DIALOGS[exitAction].description}
            icon={EXIT_DIALOGS[exitAction].icon}
            tone="danger"
            confirmLabel={EXIT_DIALOGS[exitAction].confirmLabel}
            cancelLabel="Cancel"
            loading={isExiting}
            onConfirm={() => void handleConfirmExit()}
            onCancel={() => {
              if (!exitingRef.current) setExitAction(null);
            }}
          />
        )}
      </>
    );
  };

  const challenge = state.status === 'ready' ? state.challenge : null;
  const hasOptions = !!challenge && (challenge.can_leave || challenge.can_delete);
  const title = challenge?.title ?? cachedTitle ?? 'Challenge';

  if (state.status === 'not_found') return <NotFoundView />;

  return (
    <div className={`${layout.page} ${layout.pagePushed}`} aria-busy={state.status === 'loading'}>
      <PageHeader
        title={<span className={layout.headerTitle}>{title}</span>}
        onBack={goBack}
        actions={
          hasOptions ? (
            <IconButton
              variant="glass"
              size="lg"
              icon={<MoreHorizontal size={20} />}
              aria-label="More options"
              aria-haspopup="dialog"
              onClick={() => setIsOptionsOpen(true)}
            />
          ) : undefined
        }
      />

      {renderBody()}

      {toast && (
        <SnapToast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  );
};

export const ChallengeDetailPage: React.FC = () => {
  const { id } = useParams();
  const challengeId = parseChallengeId(id);
  if (challengeId === null) return <NotFoundView />;
  return <ChallengeDetailView key={challengeId} challengeId={challengeId} />;
};

export default ChallengeDetailPage;
