-- Growth Tracker schema.
--
-- Reproduces exactly what the Go backend produced with GORM AutoMigrate plus the standalone
-- scripts it shipped in backend/migrations (pg_trgm indexes, story_likes, recent_searches,
-- activity photo columns, profile_pic_thumb). Every statement is idempotent, so running this on
-- startup creates a fresh database and is a no-op on an existing production database.
-- The pg_trgm extension and its trigram index are applied separately and best-effort by
-- `db::migrate` (`OPTIONAL_SCHEMA`), so a server that may not create extensions still starts,
-- like Go.

CREATE TABLE IF NOT EXISTS users (
    id bigserial NOT NULL,
    email text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    profile_pic text,
    profile_pic_thumb text,
    bio character varying(150) DEFAULT NULL::character varying,
    is_private boolean DEFAULT false,
    is_verified boolean DEFAULT false,
    email_verified boolean DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT uni_users_email UNIQUE (email),
    CONSTRAINT uni_users_username UNIQUE (username)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic_thumb text;
CREATE INDEX IF NOT EXISTS idx_users_username_lower_pattern ON users USING btree (lower(username) text_pattern_ops);

CREATE TABLE IF NOT EXISTS activities (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    name character varying(50) NOT NULL,
    duration_hours numeric(4,2) NOT NULL,
    note character varying(500),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    activity_date date DEFAULT CURRENT_DATE,
    CONSTRAINT activities_pkey PRIMARY KEY (id),
    CONSTRAINT chk_activities_duration_hours CHECK (((duration_hours >= (0)::numeric) AND (duration_hours <= (24)::numeric))),
    CONSTRAINT fk_activities_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities USING btree (user_id, activity_date);

CREATE TABLE IF NOT EXISTS streaks (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    current bigint NOT NULL DEFAULT 0,
    longest bigint NOT NULL DEFAULT 0,
    activity_date date DEFAULT CURRENT_DATE,
    CONSTRAINT streaks_pkey PRIMARY KEY (id),
    CONSTRAINT fk_streaks_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_streaks_user_date ON streaks USING btree (user_id, activity_date);

CREATE TABLE IF NOT EXISTS tile_configs (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    config jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT tile_configs_pkey PRIMARY KEY (id),
    CONSTRAINT fk_tile_configs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tile_configs_user_id ON tile_configs USING btree (user_id);

CREATE TABLE IF NOT EXISTS likes (
    id bigserial NOT NULL,
    liker_id bigint NOT NULL,
    liked_user_id bigint NOT NULL,
    liked_date date NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT likes_pkey PRIMARY KEY (id),
    CONSTRAINT fk_likes_liked_user FOREIGN KEY (liked_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_likes_liker FOREIGN KEY (liker_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_likes_liked_user_date ON likes USING btree (liked_user_id, liked_date);
CREATE INDEX IF NOT EXISTS idx_likes_liker ON likes USING btree (liker_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_unique ON likes USING btree (liker_id, liked_user_id, liked_date);

CREATE TABLE IF NOT EXISTS user_badges (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    badge_key character varying(50) NOT NULL,
    earned_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT user_badges_pkey PRIMARY KEY (id),
    CONSTRAINT fk_user_badges_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_badge_unique ON user_badges USING btree (user_id, badge_key);

CREATE TABLE IF NOT EXISTS notifications (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    type character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    body text,
    metadata jsonb,
    read_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT notifications_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_notif_user_created ON notifications USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON notifications USING btree (user_id, read_at);

CREATE TABLE IF NOT EXISTS notification_dedupes (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    actor_id bigint NOT NULL,
    type character varying(50) NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_key character varying(200) NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT notification_dedupes_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_dedupe_user ON notification_dedupes USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notification_dedupes USING btree (user_id, actor_id, type, entity_type, entity_key);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    vapid_key_id character varying(100) NOT NULL,
    status character varying(20) NOT NULL DEFAULT 'active'::character varying,
    failure_count bigint NOT NULL DEFAULT 0,
    user_agent character varying(500),
    platform character varying(50),
    browser character varying(50),
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_push_sub_last_success ON push_subscriptions USING btree (last_success_at);
CREATE INDEX IF NOT EXISTS idx_push_sub_user_status ON push_subscriptions USING btree (user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_sub_endpoint ON push_subscriptions USING btree (endpoint);

CREATE TABLE IF NOT EXISTS push_preferences (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    push_enabled boolean NOT NULL DEFAULT true,
    preferences jsonb DEFAULT '{}'::jsonb,
    quiet_hours_enabled boolean NOT NULL DEFAULT false,
    quiet_start character varying(5),
    quiet_end character varying(5),
    timezone character varying(50) DEFAULT 'Asia/Kolkata'::character varying,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT push_preferences_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_pref_user ON push_preferences USING btree (user_id);

CREATE TABLE IF NOT EXISTS push_delivery_logs (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    subscription_id bigint NOT NULL,
    notification_type character varying(50) NOT NULL,
    dedupe_key character varying(255),
    message_id character varying(100) NOT NULL,
    status_code bigint NOT NULL,
    error text,
    duration_ms bigint NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT push_delivery_logs_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_push_log_dedupe ON push_delivery_logs USING btree (dedupe_key, created_at);
CREATE INDEX IF NOT EXISTS idx_push_log_idempotency ON push_delivery_logs USING btree (subscription_id, message_id);
CREATE INDEX IF NOT EXISTS idx_push_log_user_created ON push_delivery_logs USING btree (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS follow_edges_by_follower (
    follower_id bigint NOT NULL,
    followee_id bigint NOT NULL,
    state character varying(20) NOT NULL DEFAULT 'ACTIVE'::character varying,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    accepted_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT follow_edges_by_follower_pkey PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follow_follower_created ON follow_edges_by_follower USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_follower_state ON follow_edges_by_follower USING btree (follower_id, state);

CREATE TABLE IF NOT EXISTS follow_edges_by_followee (
    followee_id bigint NOT NULL,
    follower_id bigint NOT NULL,
    state character varying(20) NOT NULL DEFAULT 'ACTIVE'::character varying,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    accepted_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT follow_edges_by_followee_pkey PRIMARY KEY (followee_id, follower_id)
);
CREATE INDEX IF NOT EXISTS idx_follow_followee_created ON follow_edges_by_followee USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follow_followee_state ON follow_edges_by_followee USING btree (followee_id, state);

CREATE TABLE IF NOT EXISTS follow_counters (
    user_id bigserial NOT NULL,
    followers_count bigint NOT NULL DEFAULT 0,
    following_count bigint NOT NULL DEFAULT 0,
    pending_requests_count bigint NOT NULL DEFAULT 0,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT follow_counters_pkey PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS cron_job_logs (
    id bigserial NOT NULL,
    job_name character varying(100) NOT NULL,
    job_date date NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    status character varying(20) NOT NULL DEFAULT 'running'::character varying,
    users_count bigint DEFAULT 0,
    error text,
    instance_id character varying(100),
    CONSTRAINT cron_job_logs_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_job_unique ON cron_job_logs USING btree (job_name, job_date);

CREATE TABLE IF NOT EXISTS activity_photos (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    activity_name character varying(50) NOT NULL,
    photo_date date NOT NULL,
    photo_url character varying(500) NOT NULL,
    thumbnail_url character varying(500) NOT NULL,
    activity_icon character varying(50),
    activity_color character varying(20),
    activity_label character varying(50),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT activity_photos_pkey PRIMARY KEY (id),
    CONSTRAINT fk_activity_photos_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
ALTER TABLE activity_photos ADD COLUMN IF NOT EXISTS activity_icon character varying(50);
ALTER TABLE activity_photos ADD COLUMN IF NOT EXISTS activity_color character varying(20);
ALTER TABLE activity_photos ADD COLUMN IF NOT EXISTS activity_label character varying(50);
CREATE INDEX IF NOT EXISTS idx_activity_photo_date ON activity_photos USING btree (photo_date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_photo_user_date ON activity_photos USING btree (user_id, photo_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_photo_unique ON activity_photos USING btree (user_id, activity_name, photo_date);

CREATE TABLE IF NOT EXISTS story_views (
    id bigserial NOT NULL,
    viewer_id bigint NOT NULL,
    photo_id bigint NOT NULL,
    viewed_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT story_views_pkey PRIMARY KEY (id),
    CONSTRAINT fk_story_views_photo FOREIGN KEY (photo_id) REFERENCES activity_photos(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_story_views_viewer FOREIGN KEY (viewer_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_view_photo ON story_views USING btree (photo_id);
CREATE INDEX IF NOT EXISTS idx_story_view_viewer ON story_views USING btree (viewer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_view_unique ON story_views USING btree (viewer_id, photo_id);

-- Created by backend/migrations/add_story_likes.go in the Go era: integer ids and a timestamp
-- WITHOUT time zone (read it as UTC).
CREATE TABLE IF NOT EXISTS story_likes (
    id serial NOT NULL,
    liker_id integer NOT NULL,
    photo_id integer NOT NULL,
    liked_at timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT story_likes_pkey PRIMARY KEY (id),
    CONSTRAINT story_likes_liker_id_fkey FOREIGN KEY (liker_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT story_likes_photo_id_fkey FOREIGN KEY (photo_id) REFERENCES activity_photos(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_story_like_liker ON story_likes USING btree (liker_id);
CREATE INDEX IF NOT EXISTS idx_story_like_photo ON story_likes USING btree (photo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_like_unique ON story_likes USING btree (liker_id, photo_id);

-- Created by backend/migrations/add_recent_searches.go: integer ids, timestamp WITHOUT time zone.
CREATE TABLE IF NOT EXISTS recent_searches (
    id serial NOT NULL,
    user_id integer NOT NULL,
    searched_user_id integer NOT NULL,
    searched_at timestamp without time zone NOT NULL DEFAULT now(),
    CONSTRAINT recent_searches_pkey PRIMARY KEY (id),
    CONSTRAINT recent_searches_searched_user_id_fkey FOREIGN KEY (searched_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT recent_searches_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT uq_recent_search_user_searched UNIQUE (user_id, searched_user_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_search_user_time ON recent_searches USING btree (user_id, searched_at DESC);

CREATE TABLE IF NOT EXISTS comments (
    id bigserial NOT NULL,
    day_owner_id bigint NOT NULL,
    day_date date NOT NULL,
    author_id bigint NOT NULL,
    parent_comment_id bigint,
    root_comment_id bigint,
    reply_to_user_id bigint,
    body text NOT NULL,
    like_count bigint NOT NULL DEFAULT 0,
    reply_count bigint NOT NULL DEFAULT 0,
    is_edited boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT comments_pkey PRIMARY KEY (id),
    CONSTRAINT fk_comments_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comment_author ON comments USING btree (author_id);
CREATE INDEX IF NOT EXISTS idx_comment_day_date ON comments USING btree (day_owner_id, day_date);
CREATE INDEX IF NOT EXISTS idx_comment_parent ON comments USING btree (parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_root_created ON comments USING btree (root_comment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS comment_likes (
    id bigserial NOT NULL,
    comment_id bigint NOT NULL,
    user_id bigint NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT comment_likes_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_comment_like_comment ON comment_likes USING btree (comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_like_user ON comment_likes USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_like_unique ON comment_likes USING btree (comment_id, user_id);

CREATE TABLE IF NOT EXISTS comment_mentions (
    id bigserial NOT NULL,
    comment_id bigint NOT NULL,
    mentioned_user_id bigint NOT NULL,
    username character varying(20) NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT comment_mentions_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_comment_mention_comment ON comment_mentions USING btree (comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_mention_user ON comment_mentions USING btree (mentioned_user_id);

CREATE TABLE IF NOT EXISTS comment_dedupes (
    id bigserial NOT NULL,
    user_id bigint NOT NULL,
    day_owner_id bigint NOT NULL,
    day_date date NOT NULL,
    body_hash character varying(64) NOT NULL,
    idempotency_key character varying(64),
    comment_id bigint NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT comment_dedupes_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_comment_dedupe_created ON comment_dedupes USING btree (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_dedupe ON comment_dedupes USING btree (user_id, day_owner_id, day_date, body_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_idempotency ON comment_dedupes USING btree (idempotency_key);

CREATE TABLE IF NOT EXISTS challenges (
    id bigserial NOT NULL,
    creator_id bigint NOT NULL,
    title character varying(60) NOT NULL,
    activity character varying(50) NOT NULL,
    goal_type character varying(10) NOT NULL,
    target_hours numeric(4,2) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    invite_code character varying(8) NOT NULL,
    locked_through date,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT challenges_pkey PRIMARY KEY (id),
    CONSTRAINT fk_challenges_creator FOREIGN KEY (creator_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_challenge_creator ON challenges USING btree (creator_id);
CREATE INDEX IF NOT EXISTS idx_challenge_end_date ON challenges USING btree (end_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_invite_code ON challenges USING btree (invite_code);

CREATE TABLE IF NOT EXISTS challenge_participants (
    id bigserial NOT NULL,
    challenge_id bigint NOT NULL,
    user_id bigint NOT NULL,
    joined_at timestamp with time zone NOT NULL,
    joined_on date NOT NULL,
    final_rank bigint,
    final_days_met bigint,
    final_total_hours numeric(6,2),
    completed boolean,
    CONSTRAINT challenge_participants_pkey PRIMARY KEY (id),
    CONSTRAINT fk_challenge_participants_challenge FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_challenge_participants_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_challenge_participant_user ON challenge_participants USING btree (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_participant ON challenge_participants USING btree (challenge_id, user_id);

CREATE TABLE IF NOT EXISTS challenge_days (
    id bigserial NOT NULL,
    challenge_id bigint NOT NULL,
    user_id bigint NOT NULL,
    day_date date NOT NULL,
    hours numeric(4,2) NOT NULL DEFAULT 0,
    logged boolean NOT NULL DEFAULT false,
    met boolean NOT NULL DEFAULT false,
    locked_at timestamp with time zone NOT NULL,
    CONSTRAINT challenge_days_pkey PRIMARY KEY (id),
    CONSTRAINT fk_challenge_days_challenge FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_challenge_days_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_day ON challenge_days USING btree (challenge_id, user_id, day_date);

CREATE TABLE IF NOT EXISTS challenge_cheers (
    id bigserial NOT NULL,
    challenge_id bigint NOT NULL,
    from_user_id bigint NOT NULL,
    to_user_id bigint NOT NULL,
    cheer_date date NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT challenge_cheers_pkey PRIMARY KEY (id),
    CONSTRAINT fk_challenge_cheers_challenge FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_challenge_cheers_from_user FOREIGN KEY (from_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_challenge_cheers_to_user FOREIGN KEY (to_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_cheer ON challenge_cheers USING btree (challenge_id, from_user_id, to_user_id, cheer_date);

CREATE TABLE IF NOT EXISTS challenge_invites (
    id bigserial NOT NULL,
    challenge_id bigint NOT NULL,
    inviter_id bigint NOT NULL,
    invitee_id bigint NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT challenge_invites_pkey PRIMARY KEY (id),
    CONSTRAINT fk_challenge_invites_challenge FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_challenge_invites_invitee FOREIGN KEY (invitee_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_challenge_invites_inviter FOREIGN KEY (inviter_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_challenge_invite_invitee ON challenge_invites USING btree (invitee_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_invite ON challenge_invites USING btree (challenge_id, invitee_id);

-- Direct messages: one conversation per pair of users (user_a_id < user_b_id), a row per
-- member with their read/delivered pointers, the messages and one reaction per user and message.
CREATE TABLE IF NOT EXISTS chat_conversations (
    id bigserial NOT NULL,
    user_a_id bigint NOT NULL,
    user_b_id bigint NOT NULL,
    last_message_id bigint,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT chat_conversations_pkey PRIMARY KEY (id),
    CONSTRAINT chk_chat_conversations_pair CHECK (user_a_id < user_b_id),
    CONSTRAINT fk_chat_conversations_user_a FOREIGN KEY (user_a_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_chat_conversations_user_b FOREIGN KEY (user_b_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversation_pair ON chat_conversations USING btree (user_a_id, user_b_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversation_user_b ON chat_conversations USING btree (user_b_id);

CREATE TABLE IF NOT EXISTS chat_members (
    conversation_id bigint NOT NULL,
    user_id bigint NOT NULL,
    last_read_message_id bigint NOT NULL DEFAULT 0,
    last_delivered_message_id bigint NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT chat_members_pkey PRIMARY KEY (conversation_id, user_id),
    CONSTRAINT fk_chat_members_conversation FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_chat_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_member_user ON chat_members USING btree (user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id bigserial NOT NULL,
    conversation_id bigint NOT NULL,
    sender_id bigint NOT NULL,
    body text NOT NULL,
    reply_to_message_id bigint,
    client_message_id character varying(64),
    is_deleted boolean NOT NULL DEFAULT false,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
    CONSTRAINT fk_chat_messages_conversation FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_chat_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_chat_messages_reply_to FOREIGN KEY (reply_to_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_message_conversation ON chat_messages USING btree (conversation_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_client_id ON chat_messages USING btree (sender_id, client_message_id);

CREATE TABLE IF NOT EXISTS chat_reactions (
    message_id bigint NOT NULL,
    user_id bigint NOT NULL,
    emoji character varying(64) NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT chat_reactions_pkey PRIMARY KEY (message_id, user_id),
    CONSTRAINT fk_chat_reactions_message FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_chat_reactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE
);