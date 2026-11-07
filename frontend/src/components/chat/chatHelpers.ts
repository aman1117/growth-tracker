/**
 * Small helpers shared by the chat screens (kept out of the component files so they can be
 * unit-tested and fast refresh keeps working).
 */

import type { CSSProperties } from 'react';

import type { FollowUser } from '../../types/follow';

/** A conversation id from the URL: a positive integer, or null */
export const parseConversationId = (raw: string | undefined): number | null => {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** DOM id of a message row, used to scroll to (and highlight) a quoted message */
export const getMessageElementId = (messageId: number) => `chat-msg-${messageId}`;

const MENU_GAP_PX = 8;
const MENU_EDGE_PX = 12;
const MENU_MIN_HEIGHT_PX = 160;

/**
 * Where the message actions menu goes: below a message in the top half of the screen and
 * above it otherwise, aligned with the message's side. Centered (undefined) without an anchor.
 */
export function getMenuPosition(
  anchor: DOMRect | null,
  isMine: boolean,
  viewport: { width: number; height: number }
): CSSProperties | undefined {
  if (!anchor) return undefined;
  const horizontal: CSSProperties = isMine
    ? { right: Math.max(MENU_EDGE_PX, viewport.width - anchor.right) }
    : { left: Math.max(MENU_EDGE_PX, anchor.left) };
  const below = anchor.top + anchor.height / 2 < viewport.height / 2;
  if (below) {
    const top = Math.max(MENU_EDGE_PX, anchor.bottom + MENU_GAP_PX);
    return {
      ...horizontal,
      top,
      maxHeight: Math.max(MENU_MIN_HEIGHT_PX, viewport.height - top - MENU_EDGE_PX),
    };
  }
  const bottom = Math.max(MENU_EDGE_PX, viewport.height - anchor.top + MENU_GAP_PX);
  return {
    ...horizontal,
    bottom,
    maxHeight: Math.max(MENU_MIN_HEIGHT_PX, viewport.height - bottom - MENU_EDGE_PX),
  };
}

export interface ChatCandidate {
  id: number;
  username: string;
  profilePic: string | null;
  profilePicThumb: string | null;
  isVerified: boolean;
  /** Follows the user and is followed back */
  isMutual: boolean;
}

const toCandidate = (user: FollowUser, isMutual: boolean): ChatCandidate => ({
  id: user.id,
  username: user.username,
  profilePic: user.profile_pic ?? null,
  profilePicThumb: user.profile_pic_thumb ?? null,
  isVerified: !!user.is_verified,
  isMutual,
});

/** People the user follows and who follow them, deduped, mutuals first, then by name */
export function mergeChatCandidates(
  following: FollowUser[],
  followers: FollowUser[]
): ChatCandidate[] {
  const followerIds = new Set(followers.map((user) => user.id));
  const byId = new Map<number, ChatCandidate>();
  following.forEach((user) => byId.set(user.id, toCandidate(user, followerIds.has(user.id))));
  followers.forEach((user) => {
    if (!byId.has(user.id)) byId.set(user.id, toCandidate(user, false));
  });
  return Array.from(byId.values()).sort(
    (a, b) => Number(b.isMutual) - Number(a.isMutual) || a.username.localeCompare(b.username)
  );
}
