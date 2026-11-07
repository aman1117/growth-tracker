/**
 * NewChatSheet
 *
 * Starts a conversation: lists people the user can message — those they follow and those
 * who follow them, mutuals first — searchable by username, with a server search for anyone
 * not in the first page of those lists. Picking someone get-or-creates the conversation and
 * opens it. Mounted only while open, so every opening starts fresh.
 */

import { CircleAlert, RefreshCw, Search, SquarePen } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

import { API_ROUTES, APP_ROUTES } from '../../constants/routes';
import { useDebounce } from '../../hooks/useDebounce';
import { useOverlayAwareNavigate } from '../../hooks/useOverlayAwareNavigate';
import { apiClient, userApi } from '../../services/api';
import { chatLog } from '../../services/chatLog';
import { useChatStore } from '../../store/useChatStore';
import type { FollowListResponse } from '../../types/follow';
import { getChatErrorMessage } from '../../utils/chat';
import { Avatar, Button, Modal, Skeleton, VerifiedBadge } from '../ui';
import { type ChatCandidate, mergeChatCandidates } from './chatHelpers';
import styles from './NewChatSheet.module.css';

export const NEW_CHAT_SEARCH_DEBOUNCE_MS = 250;
const LIST_LIMIT = 50;
const SEARCH_LIMIT = 8;

interface NewChatSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** The signed-in user's id */
  meId: number;
}

type PeopleState =
  | { status: 'loading' }
  | { status: 'ready'; people: ChatCandidate[] }
  | { status: 'error' };

const PersonButton: React.FC<{
  person: ChatCandidate;
  disabled: boolean;
  busy: boolean;
  onPick: (person: ChatCandidate) => void;
}> = ({ person, disabled, busy, onPick }) => (
  <li>
    <button
      type="button"
      className={styles.person}
      onClick={() => onPick(person)}
      disabled={disabled}
      aria-busy={busy || undefined}
    >
      <Avatar
        src={person.profilePic}
        thumbnailSrc={person.profilePicThumb}
        name={person.username}
        size="md"
      />
      <span className={styles.personName}>
        <span className={styles.username}>{person.username}</span>
        {person.isVerified && <VerifiedBadge size={14} />}
      </span>
      {busy ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : (
        person.isMutual && <span className={styles.tag}>Mutual</span>
      )}
    </button>
  </li>
);

const NewChatSheetContent: React.FC<Omit<NewChatSheetProps, 'isOpen'>> = ({ onClose, meId }) => {
  const searchId = useId();
  const navigate = useOverlayAwareNavigate();
  const startConversation = useChatStore((state) => state.startConversation);
  const [people, setPeople] = useState<PeopleState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim().toLowerCase(), NEW_CHAT_SEARCH_DEBOUNCE_MS);
  const [searchResults, setSearchResults] = useState<ChatCandidate[]>([]);
  const [startingId, setStartingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The people the user follows and who follow them
  useEffect(() => {
    let current = true;
    setPeople({ status: 'loading' });
    Promise.allSettled([
      apiClient.get<FollowListResponse>(
        `${API_ROUTES.FOLLOW.GET_FOLLOWING(meId)}?limit=${LIST_LIMIT}`
      ),
      apiClient.get<FollowListResponse>(
        `${API_ROUTES.FOLLOW.GET_FOLLOWERS(meId)}?limit=${LIST_LIMIT}`
      ),
    ]).then(([following, followers]) => {
      if (!current) return;
      if (following.status === 'rejected' && followers.status === 'rejected') {
        chatLog.failure('candidates_load_failed', following.reason, { recovery: 'show_retry' });
        setPeople({ status: 'error' });
        return;
      }
      const users = (result: PromiseSettledResult<FollowListResponse>) =>
        result.status === 'fulfilled' && Array.isArray(result.value.users)
          ? result.value.users
          : [];
      setPeople({
        status: 'ready',
        people: mergeChatCandidates(users(following), users(followers)).filter(
          (person) => person.id !== meId
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [meId, reloadKey]);

  // Anyone else matching the search (the server decides whether they can be messaged)
  useEffect(() => {
    if (!debouncedQuery) {
      setSearchResults([]);
      return;
    }
    const controller = new AbortController();
    userApi
      .autocomplete(debouncedQuery, SEARCH_LIMIT, controller.signal)
      .then((res) => {
        const suggestions = Array.isArray(res?.suggestions) ? res.suggestions : [];
        setSearchResults(
          suggestions.flatMap((suggestion): ChatCandidate[] => {
            const userId = suggestion.meta?.userId;
            if (suggestion.kind !== 'user' || !userId || userId === meId) return [];
            return [
              {
                id: userId,
                username: suggestion.text,
                profilePic: suggestion.meta?.profilePic ?? null,
                profilePicThumb: suggestion.meta?.profilePicThumb ?? null,
                isVerified: !!suggestion.meta?.isVerified,
                isMutual: false,
              },
            ];
          })
        );
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        chatLog.failure('candidate_search_failed', failure, { recovery: 'show_local_only' });
        setSearchResults([]);
      });
    return () => controller.abort();
  }, [debouncedQuery, meId]);

  const { matches, others } = useMemo(() => {
    const list = people.status === 'ready' ? people.people : [];
    const filtered = debouncedQuery
      ? list.filter((person) => person.username.toLowerCase().includes(debouncedQuery))
      : list;
    const known = new Set(list.map((person) => person.id));
    return {
      matches: filtered,
      others: searchResults.filter((person) => !known.has(person.id)),
    };
  }, [people, debouncedQuery, searchResults]);

  const pick = async (person: ChatCandidate) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStartingId(person.id);
    setError(null);
    try {
      const conversation = await startConversation(person.id);
      if (mountedRef.current) navigate(APP_ROUTES.CHAT(conversation.id));
    } catch (failure) {
      if (mountedRef.current) setError(getChatErrorMessage(failure, 'start'));
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStartingId(null);
    }
  };

  const renderList = (list: ChatCandidate[], label: string) => (
    <ul className={styles.list} aria-label={label}>
      {list.map((person) => (
        <PersonButton
          key={person.id}
          person={person}
          busy={startingId === person.id}
          disabled={startingId !== null}
          onPick={pick}
        />
      ))}
    </ul>
  );

  const renderPeople = () => {
    if (people.status === 'loading') {
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
    if (people.status === 'error') {
      return (
        <div className={styles.state} role="alert">
          <p className={styles.stateText}>Couldn&apos;t load people you follow.</p>
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw size={15} />}
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Try again
          </Button>
        </div>
      );
    }
    if (matches.length === 0 && others.length === 0) {
      return (
        <div className={styles.state}>
          <p className={styles.stateText}>
            {debouncedQuery
              ? `No one called “${query.trim()}”.`
              : 'Follow people to start chatting with them.'}
          </p>
        </div>
      );
    }
    return (
      <>
        {matches.length > 0 && renderList(matches, 'People you follow or who follow you')}
        {others.length > 0 && (
          <>
            <h3 className={styles.sectionTitle}>More people</h3>
            {renderList(others, 'More people')}
          </>
        )}
      </>
    );
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="New message"
      subtitle="Message people you follow or who follow you"
      icon={<SquarePen size={20} />}
      mobileLayout="dialog"
    >
      <div className={styles.content}>
        <label htmlFor={searchId} className="sr-only">
          Search people
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
        {error && (
          <div className={styles.error} role="alert">
            <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {renderPeople()}
      </div>
    </Modal>
  );
};

export const NewChatSheet: React.FC<NewChatSheetProps> = ({ isOpen, ...props }) =>
  isOpen ? <NewChatSheetContent {...props} /> : null;

export default NewChatSheet;
