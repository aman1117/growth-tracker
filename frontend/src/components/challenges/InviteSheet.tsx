/**
 * InviteSheet
 *
 * Invites people to a challenge: share or copy the invite link, or pick people the user
 * follows (or who follow them) — searchable by username — and invite up to 20 at once.
 * `onInvited` reports the result; the parent closes the sheet and confirms it.
 * Mounted only while open, so every opening starts fresh.
 */

import { AlertCircle, Check, Copy, RefreshCw, Search, Share2, UserPlus } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { CHALLENGE_LIMITS } from '../../constants/challenges';
import { useDebounce } from '../../hooks/useDebounce';
import { challengeApi } from '../../services/api';
import { gl } from '../../services/goodlogs';
import type { ChallengeInvitesResponse, InviteCandidate } from '../../types';
import { buildInviteLink, getChallengeErrorMessage } from '../../utils/challenges';
import { copyText, shareLink } from '../../utils/share';
import { Avatar, Button, Modal, Skeleton, VerifiedBadge } from '../ui';
import { logChallengeFailure } from './challengeEffects';
import styles from './InviteSheet.module.css';

export const INVITE_SEARCH_DEBOUNCE_MS = 250;
/** How long "Copied" stays on the copy button */
export const COPIED_FEEDBACK_MS = 2000;
const CANDIDATE_LIMIT = 50;
const MAX_SELECTED = CHALLENGE_LIMITS.MAX_INVITES_PER_REQUEST;

interface InviteSheetProps {
  isOpen: boolean;
  onClose: () => void;
  challengeId: number;
  challengeTitle: string;
  inviteCode: string;
  /** After invites were sent; the parent closes the sheet and confirms */
  onInvited: (result: ChallengeInvitesResponse) => void;
}

type CandidatesState =
  | { status: 'loading' }
  | { status: 'ready'; users: InviteCandidate[]; query: string }
  | { status: 'error' };

const InviteSheetContent: React.FC<Omit<InviteSheetProps, 'isOpen'>> = ({
  onClose,
  challengeId,
  challengeTitle,
  inviteCode,
  onInvited,
}) => {
  const searchId = useId();
  const linkId = useId();
  const errorId = useId();
  const link = buildInviteLink(window.location.origin, inviteCode);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), INVITE_SEARCH_DEBOUNCE_MS);
  const [candidates, setCandidates] = useState<CandidatesState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<Map<number, InviteCandidate>>(() => new Map());
  const [invitedIds, setInvitedIds] = useState<Set<number>>(() => new Set());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Load people to invite; a newer search (or closing the sheet) discards older answers
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    // Keep showing the previous results while a new search loads
    setCandidates((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    challengeApi
      .getInviteCandidates(challengeId, { q: debouncedQuery, limit: CANDIDATE_LIMIT })
      .then((res) => {
        if (requestId !== requestIdRef.current) return;
        setCandidates({
          status: 'ready',
          users: Array.isArray(res.users) ? res.users : [],
          query: debouncedQuery,
        });
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        logChallengeFailure('invite_candidates_failed', error, {
          recovery: 'show_retry',
          challengeId,
        });
        setCandidates({ status: 'error' });
      });
    return () => {
      // Invalidate this request when the query changes or the sheet closes
      requestIdRef.current += 1;
    };
  }, [challengeId, debouncedQuery, reloadKey]);

  // "Copied" shows for a moment; copying again restarts the countdown
  const showCopied = () => {
    if (!mountedRef.current) return;
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
  };

  const trackShare = useCallback(
    (method: 'copy' | 'share') =>
      gl.track('challenge_link_shared', { properties: { challengeId, method, source: 'invite' } }),
    [challengeId]
  );

  const handleCopy = async () => {
    setLinkError(null);
    if (await copyText(link)) {
      trackShare('copy');
      showCopied();
    } else {
      setLinkError("Couldn't copy the link. Select it and copy it yourself.");
    }
  };

  const handleShare = async () => {
    setLinkError(null);
    const outcome = await shareLink({
      url: link,
      title: challengeTitle,
      text: `Join my challenge “${challengeTitle}” on Growth Tracker`,
    });
    if (outcome === 'shared') trackShare('share');
    if (outcome === 'copied') {
      trackShare('copy');
      showCopied();
    }
    if (outcome === 'failed') {
      setLinkError("Couldn't share the link. Select it and copy it yourself.");
    }
  };

  const isInvited = (user: InviteCandidate) => user.invited || invitedIds.has(user.id);
  const isSearching = candidates.status === 'ready' && candidates.query !== debouncedQuery;

  const toggle = (user: InviteCandidate) => {
    setSendError(null);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(user.id)) next.delete(user.id);
      else if (next.size < MAX_SELECTED) next.set(user.id, user);
      return next;
    });
  };

  const handleInvite = async () => {
    if (sendingRef.current || selected.size === 0) return;
    const userIds = Array.from(selected.keys());
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const result = await challengeApi.invite(challengeId, userIds);
      sendingRef.current = false;
      if (!mountedRef.current) return;
      setInvitedIds((current) => new Set([...current, ...userIds]));
      setSelected(new Map());
      setSending(false);
      onInvited(result);
    } catch (error) {
      sendingRef.current = false;
      logChallengeFailure('invite_failed', error, {
        recovery: 'keep_selection',
        challengeId,
        count: userIds.length,
      });
      if (!mountedRef.current) return;
      setSendError(getChallengeErrorMessage(error, 'invite'));
      setSending(false);
    }
  };

  const renderCandidates = () => {
    if (candidates.status === 'loading') {
      return (
        <ul className={styles.list} aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <li key={key} className={styles.skeletonRow}>
              <Skeleton width={40} height={40} radius="full" />
              <Skeleton width="45%" height={14} />
            </li>
          ))}
        </ul>
      );
    }

    if (candidates.status === 'error') {
      return (
        <div className={styles.state} role="alert">
          <p className={styles.stateText}>Couldn&apos;t load people to invite.</p>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={15} />}
            className={styles.touchTarget}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Try again
          </Button>
        </div>
      );
    }

    if (candidates.users.length === 0) {
      return (
        <div className={styles.state} aria-busy={isSearching || undefined}>
          <p className={styles.stateText}>
            {candidates.query
              ? `No one called “${candidates.query}” to invite.`
              : 'No one to invite yet – share the link instead.'}
          </p>
        </div>
      );
    }

    const isFull = selected.size >= MAX_SELECTED;
    return (
      <ul
        className={`${styles.list} ${isSearching ? styles.listSearching : ''}`}
        aria-label="People you can invite"
        aria-busy={isSearching || undefined}
      >
        {candidates.users.map((user) => {
          const invited = isInvited(user);
          const checked = selected.has(user.id);
          const disabled = invited || sending || (isFull && !checked);
          const invitedId = `${searchId}-invited-${user.id}`;
          return (
            <li key={user.id}>
              <label
                className={`${styles.person} ${checked ? styles.personSelected : ''} ${
                  disabled ? styles.personDisabled : ''
                }`}
              >
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(user)}
                  aria-label={user.username}
                  aria-describedby={invited ? invitedId : undefined}
                />
                <Avatar
                  src={user.profile_pic}
                  thumbnailSrc={user.profile_pic_thumb}
                  name={user.username}
                  size="md"
                />
                <span className={styles.personName}>
                  <span className={styles.username}>{user.username}</span>
                  {user.is_verified && <VerifiedBadge size={14} />}
                </span>
                {invited ? (
                  <span id={invitedId} className={styles.invitedTag}>
                    Invited
                  </span>
                ) : (
                  <span
                    className={`${styles.check} ${checked ? styles.checkOn : ''}`}
                    aria-hidden="true"
                  >
                    {checked && <Check size={14} strokeWidth={3} />}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    );
  };

  const count = selected.size;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Invite friends"
      subtitle="They'll get a notification with the invite"
      icon={<UserPlus size={20} />}
      mobileLayout="dialog"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            className={styles.footerButton}
          >
            Done
          </Button>
          <Button
            type="button"
            onClick={handleInvite}
            disabled={count === 0}
            loading={sending}
            className={styles.footerButton}
            aria-describedby={sendError ? errorId : undefined}
          >
            {count > 0 ? `Invite ${count}` : 'Invite'}
          </Button>
        </>
      }
    >
      <div className={styles.content}>
        <div className={styles.share}>
          <label htmlFor={linkId} className={styles.label}>
            Invite link
          </label>
          <div className={styles.linkRow}>
            <input
              id={linkId}
              className={styles.link}
              value={link}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
          <div className={styles.shareButtons}>
            <Button
              variant="secondary"
              icon={copied ? <Check size={16} /> : <Copy size={16} />}
              className={styles.touchTarget}
              onClick={handleCopy}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button
              variant="secondary"
              icon={<Share2 size={16} />}
              className={styles.touchTarget}
              onClick={handleShare}
            >
              Share
            </Button>
          </div>
          <p
            className={`${styles.linkMessage} ${linkError ? styles.linkMessageError : ''}`}
            aria-live="polite"
          >
            {copied ? 'Link copied' : linkError}
          </p>
        </div>

        <div className={styles.people}>
          <label htmlFor={searchId} className={styles.label}>
            Find people to invite
          </label>
          <div className={styles.search}>
            <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              className={styles.searchInput}
              placeholder="Search by username"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {selected.size >= MAX_SELECTED && (
            <p className={styles.limit} role="status">
              You can invite up to {MAX_SELECTED} people at a time
            </p>
          )}
          {sendError && (
            <div id={errorId} className={styles.error} role="alert">
              <AlertCircle size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{sendError}</span>
            </div>
          )}
          {renderCandidates()}
        </div>
      </div>
    </Modal>
  );
};

export const InviteSheet: React.FC<InviteSheetProps> = ({ isOpen, ...props }) =>
  isOpen ? <InviteSheetContent {...props} /> : null;
