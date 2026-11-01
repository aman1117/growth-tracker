//! Users, authentication, profiles, follows, streaks, badges, search suggestions and email.
//!
//! Data and service layer only (no HTTP handlers). Build a [`UsersContext`] from the
//! [`gt_core::CoreContext`] once at startup and share it with the handler crates.

pub mod context;
pub mod dto;
pub mod repository;
pub mod service;

pub use context::UsersContext;
pub use dto::BadgeDto;
pub use repository::{
    AutocompleteResult, BadgeRepository, CronJobLogRepository, FollowListCursor, FollowRepository, MutualEdgeRow,
    RecentSearchRepository, RecentSearchResult, StreakRepository, TombstoneCleanupError, TrendingUserResult,
    UserRepository,
};
pub use service::{
    AuthError, AuthService, BadgeService, EmailError, EmailSender, EmailService, FollowError, FollowResult,
    FollowService, MutualEdge, ProfileService, ResendEmailSender, SearchSuggestionsService, SmtpEmailSender,
    StreakService,
};
