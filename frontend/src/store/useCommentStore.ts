/**
 * Comment Store
 *
 * Zustand store for managing day comment state.
 * Handles fetching, creating, deleting, liking/unliking comments
 * with optimistic updates and error handling.
 */

import { create } from 'zustand';

import { commentApi } from '../services/api';
import type { Comment } from '../types/comment';

// ==================== Types ====================

interface ReplyState {
  comments: Comment[];
  hasMore: boolean;
  loading: boolean;
}

interface CommentState {
  /** Top-level comments keyed by "username:date" */
  commentsByDay: Record<string, Comment[]>;
  /** Replies keyed by root comment ID */
  repliesByRoot: Record<number, ReplyState>;
  /** Comment counts keyed by "username:date" */
  counts: Record<string, number>;
  /** Loading state for top-level comments */
  loading: boolean;
  /** Whether more top-level comments exist */
  hasMore: boolean;
  /** Current sort mode */
  sort: 'top' | 'newest';
}

interface CommentActions {
  fetchComments: (
    username: string,
    date: string,
    sort?: 'top' | 'newest',
    reset?: boolean
  ) => Promise<void>;
  fetchReplies: (commentId: number, reset?: boolean) => Promise<void>;
  createComment: (username: string, date: string, body: string) => Promise<Comment | null>;
  createReply: (
    username: string,
    date: string,
    commentId: number,
    body: string
  ) => Promise<Comment | null>;
  deleteComment: (commentId: number, dayKey: string) => Promise<boolean>;
  editComment: (commentId: number, body: string, dayKey: string) => Promise<Comment | null>;
  likeComment: (commentId: number, dayKey: string) => void;
  unlikeComment: (commentId: number, dayKey: string) => void;
  fetchCommentCount: (username: string, date: string) => Promise<void>;
  setSort: (sort: 'top' | 'newest') => void;
  clearComments: (dayKey?: string) => void;
}

type CommentStore = CommentState & CommentActions;

const makeDayKey = (username: string, date: string) => `${username}:${date}`;

// Helper to find and update a comment in the top-level list or replies
const updateCommentInState = (
  state: CommentState,
  commentId: number,
  dayKey: string,
  updater: (c: Comment) => Comment
): Partial<CommentState> => {
  // Check top-level comments
  const dayComments = state.commentsByDay[dayKey];
  if (dayComments) {
    const idx = dayComments.findIndex((c) => c.id === commentId);
    if (idx !== -1) {
      const updated = [...dayComments];
      updated[idx] = updater(updated[idx]);
      return { commentsByDay: { ...state.commentsByDay, [dayKey]: updated } };
    }
  }

  // Check replies
  for (const [rootId, replyState] of Object.entries(state.repliesByRoot)) {
    const idx = replyState.comments.findIndex((c) => c.id === commentId);
    if (idx !== -1) {
      const updated = [...replyState.comments];
      updated[idx] = updater(updated[idx]);
      return {
        repliesByRoot: {
          ...state.repliesByRoot,
          [rootId]: { ...replyState, comments: updated },
        },
      };
    }
  }

  return {};
};

export const useCommentStore = create<CommentStore>((set, get) => ({
  // State
  commentsByDay: {},
  repliesByRoot: {},
  counts: {},
  loading: false,
  hasMore: false,
  sort: 'top',

  // Actions
  setSort: (sort) => set({ sort }),

  clearComments: (dayKey) => {
    if (dayKey) {
      set((state) => {
        const nextCommentsByDay = { ...state.commentsByDay };
        delete nextCommentsByDay[dayKey];
        return { commentsByDay: nextCommentsByDay, repliesByRoot: {}, hasMore: false };
      });
    } else {
      set({ commentsByDay: {}, repliesByRoot: {}, hasMore: false });
    }
  },

  fetchComments: async (username, date, sort, reset) => {
    const dayKey = makeDayKey(username, date);
    const currentSort = sort || get().sort;
    const existing = get().commentsByDay[dayKey] || [];
    const cursor = reset ? undefined : existing[existing.length - 1]?.id;

    // Only show loading spinner if there are no existing comments to display
    if (existing.length === 0) {
      set({ loading: true });
    }

    try {
      const response = await commentApi.getComments(username, date, currentSort, cursor, 20);
      if (response.success) {
        const newComments = reset ? response.comments : [...existing, ...response.comments];
        set((state) => ({
          commentsByDay: { ...state.commentsByDay, [dayKey]: newComments },
          hasMore: response.has_more,
          loading: false,
          sort: currentSort,
        }));
      }
    } catch (error) {
      console.error('[CommentStore] fetchComments failed:', error);
      set({ loading: false });
    }
  },

  fetchReplies: async (commentId, reset) => {
    const existing = reset ? [] : get().repliesByRoot[commentId]?.comments || [];
    const cursor = reset ? undefined : existing[existing.length - 1]?.id;

    set((state) => ({
      repliesByRoot: {
        ...state.repliesByRoot,
        [commentId]: {
          comments: existing,
          hasMore: get().repliesByRoot[commentId]?.hasMore ?? true,
          loading: true,
        },
      },
    }));

    try {
      const response = await commentApi.getReplies(commentId, cursor, 20);
      if (response.success) {
        const newReplies = reset ? response.comments : [...existing, ...response.comments];
        set((state) => ({
          repliesByRoot: {
            ...state.repliesByRoot,
            [commentId]: {
              comments: newReplies,
              hasMore: response.has_more,
              loading: false,
            },
          },
        }));
      }
    } catch (error) {
      console.error('[CommentStore] fetchReplies failed:', error);
      set((state) => ({
        repliesByRoot: {
          ...state.repliesByRoot,
          [commentId]: {
            ...state.repliesByRoot[commentId],
            loading: false,
          },
        },
      }));
    }
  },

  createComment: async (username, date, body) => {
    const dayKey = makeDayKey(username, date);
    const idempotencyKey = crypto.randomUUID();

    try {
      const response = await commentApi.createComment(username, date, body, idempotencyKey);
      if (response.success && response.comment) {
        set((state) => ({
          commentsByDay: {
            ...state.commentsByDay,
            [dayKey]: [response.comment!, ...(state.commentsByDay[dayKey] || [])],
          },
          counts: {
            ...state.counts,
            [dayKey]: (state.counts[dayKey] || 0) + 1,
          },
        }));
        return response.comment;
      }
    } catch (error) {
      console.error('[CommentStore] createComment failed:', error);
    }
    return null;
  },

  createReply: async (username, date, commentId, body) => {
    const dayKey = makeDayKey(username, date);
    const idempotencyKey = crypto.randomUUID();

    // Determine the root comment ID (for thread grouping)
    // If commentId is a top-level comment, root = commentId
    // If commentId is a reply, root = its root_comment_id
    const allComments = get().commentsByDay[dayKey] || [];
    const parentComment = allComments.find((c) => c.id === commentId);
    let rootId = commentId;
    if (parentComment?.root_comment_id) {
      rootId = parentComment.root_comment_id;
    }
    // Also check in replies
    if (!parentComment) {
      for (const replyState of Object.values(get().repliesByRoot)) {
        const found = replyState.comments.find((c) => c.id === commentId);
        if (found) {
          rootId = found.root_comment_id || commentId;
          break;
        }
      }
    }

    try {
      const response = await commentApi.createReply(
        username,
        date,
        commentId,
        body,
        idempotencyKey
      );
      if (response.success && response.comment) {
        // Add reply to repliesByRoot
        set((state) => {
          const existingReplies = state.repliesByRoot[rootId]?.comments || [];
          return {
            repliesByRoot: {
              ...state.repliesByRoot,
              [rootId]: {
                comments: [...existingReplies, response.comment!],
                hasMore: state.repliesByRoot[rootId]?.hasMore ?? false,
                loading: false,
              },
            },
            counts: {
              ...state.counts,
              [dayKey]: (state.counts[dayKey] || 0) + 1,
            },
          };
        });

        // Increment reply_count on all ancestor comments (parent → root)
        set((state) => {
          const result: Partial<CommentState> = {};
          const ancestorIds = new Set<number>();
          let currentId: number | null | undefined = commentId;

          const allTopLevel = state.commentsByDay[dayKey] || [];
          const allReplies = state.repliesByRoot[rootId]?.comments || [];
          const allComments = [...allTopLevel, ...allReplies];

          while (currentId != null) {
            ancestorIds.add(currentId);
            const current = allComments.find((c) => c.id === currentId);
            currentId = current?.parent_comment_id ?? null;
          }

          if (state.commentsByDay[dayKey]) {
            result.commentsByDay = {
              ...state.commentsByDay,
              [dayKey]: state.commentsByDay[dayKey].map((c) =>
                ancestorIds.has(c.id) ? { ...c, reply_count: c.reply_count + 1 } : c
              ),
            };
          }
          if (state.repliesByRoot[rootId]) {
            result.repliesByRoot = {
              ...state.repliesByRoot,
              [rootId]: {
                ...state.repliesByRoot[rootId],
                comments: state.repliesByRoot[rootId].comments.map((c) =>
                  ancestorIds.has(c.id) ? { ...c, reply_count: c.reply_count + 1 } : c
                ),
              },
            };
          }
          return result;
        });

        return response.comment;
      }
    } catch (error) {
      console.error('[CommentStore] createReply failed:', error);
    }
    return null;
  },

  deleteComment: async (commentId, dayKey) => {
    try {
      const response = await commentApi.deleteComment(commentId);
      if (response.success) {
        // Find the comment before marking deleted, to check if it's a leaf
        const state = get();
        let deletedComment: Comment | undefined;
        const dayComments = state.commentsByDay[dayKey] || [];
        deletedComment = dayComments.find((c) => c.id === commentId);
        let rootId: number | undefined;
        if (!deletedComment) {
          for (const [rid, replyState] of Object.entries(state.repliesByRoot)) {
            deletedComment = replyState.comments.find((c) => c.id === commentId);
            if (deletedComment) {
              rootId = Number(rid);
              break;
            }
          }
        }

        // Soft delete: mark as deleted in state
        set((state) => {
          const changes = updateCommentInState(state, commentId, dayKey, (c) => ({
            ...c,
            is_deleted: true,
            body: '[Deleted]',
          }));
          return {
            ...changes,
            counts: {
              ...state.counts,
              [dayKey]: Math.max(0, (state.counts[dayKey] || 0) - 1),
            },
          };
        });

        // Decrement ancestor reply_counts if leaf (no children)
        if (
          deletedComment &&
          deletedComment.parent_comment_id != null &&
          deletedComment.reply_count === 0
        ) {
          set((state) => {
            const result: Partial<CommentState> = {};
            const ancestorIds = new Set<number>();
            let currentId: number | null | undefined = deletedComment!.parent_comment_id;
            const effectiveRootId = rootId ?? deletedComment!.root_comment_id;

            const allTopLevel = state.commentsByDay[dayKey] || [];
            const allReplies = effectiveRootId
              ? state.repliesByRoot[effectiveRootId]?.comments || []
              : [];
            const allComments = [...allTopLevel, ...allReplies];

            while (currentId != null) {
              ancestorIds.add(currentId);
              const current = allComments.find((c) => c.id === currentId);
              currentId = current?.parent_comment_id ?? null;
            }

            if (state.commentsByDay[dayKey]) {
              result.commentsByDay = {
                ...state.commentsByDay,
                [dayKey]: state.commentsByDay[dayKey].map((c) =>
                  ancestorIds.has(c.id) ? { ...c, reply_count: Math.max(0, c.reply_count - 1) } : c
                ),
              };
            }
            if (effectiveRootId && state.repliesByRoot[effectiveRootId]) {
              result.repliesByRoot = {
                ...state.repliesByRoot,
                [effectiveRootId]: {
                  ...state.repliesByRoot[effectiveRootId],
                  comments: state.repliesByRoot[effectiveRootId].comments.map((c) =>
                    ancestorIds.has(c.id)
                      ? { ...c, reply_count: Math.max(0, c.reply_count - 1) }
                      : c
                  ),
                },
              };
            }
            return result;
          });
        }

        return true;
      }
    } catch (error) {
      console.error('[CommentStore] deleteComment failed:', error);
    }
    return false;
  },

  editComment: async (commentId, body, dayKey) => {
    // Save original for rollback
    const state = get();
    let originalComment: Comment | undefined;
    const dayComments = state.commentsByDay[dayKey] || [];
    originalComment = dayComments.find((c) => c.id === commentId);
    if (!originalComment) {
      for (const replyState of Object.values(state.repliesByRoot)) {
        originalComment = replyState.comments.find((c) => c.id === commentId);
        if (originalComment) break;
      }
    }

    // Optimistic update
    set((s) =>
      updateCommentInState(s, commentId, dayKey, (c) => ({
        ...c,
        body,
        is_edited: true,
      }))
    );

    try {
      const response = await commentApi.editComment(commentId, body);
      if (response.success && response.comment) {
        // Apply server response
        set((s) => updateCommentInState(s, commentId, dayKey, () => response.comment!));
        return response.comment;
      }
    } catch (error) {
      console.error('[CommentStore] editComment failed:', error);
    }

    // Revert on failure
    if (originalComment) {
      set((s) => updateCommentInState(s, commentId, dayKey, () => originalComment!));
    }
    return null;
  },

  likeComment: async (commentId, dayKey) => {
    // Optimistic update
    set((state) =>
      updateCommentInState(state, commentId, dayKey, (c) => ({
        ...c,
        liked_by_me: true,
        like_count: c.like_count + 1,
      }))
    );

    try {
      const response = await commentApi.likeComment(commentId);
      if (response.success) {
        set((state) =>
          updateCommentInState(state, commentId, dayKey, (c) => ({
            ...c,
            liked_by_me: response.liked,
            like_count: response.new_count,
          }))
        );
      }
    } catch (error) {
      console.error('[CommentStore] likeComment failed:', error);
      // Revert
      set((state) =>
        updateCommentInState(state, commentId, dayKey, (c) => ({
          ...c,
          liked_by_me: false,
          like_count: Math.max(0, c.like_count - 1),
        }))
      );
    }
  },

  unlikeComment: async (commentId, dayKey) => {
    // Optimistic update
    set((state) =>
      updateCommentInState(state, commentId, dayKey, (c) => ({
        ...c,
        liked_by_me: false,
        like_count: Math.max(0, c.like_count - 1),
      }))
    );

    try {
      const response = await commentApi.unlikeComment(commentId);
      if (response.success) {
        set((state) =>
          updateCommentInState(state, commentId, dayKey, (c) => ({
            ...c,
            liked_by_me: response.liked,
            like_count: response.new_count,
          }))
        );
      }
    } catch (error) {
      console.error('[CommentStore] unlikeComment failed:', error);
      // Revert
      set((state) =>
        updateCommentInState(state, commentId, dayKey, (c) => ({
          ...c,
          liked_by_me: true,
          like_count: c.like_count + 1,
        }))
      );
    }
  },

  fetchCommentCount: async (username, date) => {
    const dayKey = makeDayKey(username, date);
    try {
      const response = await commentApi.getCommentCount(username, date);
      if (response.success) {
        set((state) => ({
          counts: { ...state.counts, [dayKey]: response.count },
        }));
      }
    } catch (error) {
      console.error('[CommentStore] fetchCommentCount failed:', error);
    }
  },
}));
