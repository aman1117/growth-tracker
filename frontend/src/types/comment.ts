/**
 * Comment Types
 *
 * Type definitions for the day comment system.
 */

// ==================== Core Types ====================

export interface MentionInfo {
  user_id: number;
  username: string;
}

export interface Comment {
  id: number;
  day_owner_id: number;
  day_date: string;
  author_id: number;
  author_username: string;
  author_avatar?: string;
  author_verified: boolean;
  parent_comment_id?: number;
  root_comment_id?: number;
  reply_to_user_id?: number;
  reply_to_username?: string;
  body: string;
  like_count: number;
  reply_count: number;
  is_deleted: boolean;
  is_edited: boolean;
  liked_by_me: boolean;
  mentions: MentionInfo[];
  created_at: string;
}

// ==================== API Response Types ====================

export interface CommentsListResponse {
  success: boolean;
  comments: Comment[];
  has_more: boolean;
  next_cursor?: number;
}

export interface CommentCountResponse {
  success: boolean;
  count: number;
}

export interface CommentActionResponse {
  success: boolean;
  comment?: Comment;
  message?: string;
}

export interface CommentLikeResponse {
  success: boolean;
  liked: boolean;
  new_count: number;
}
