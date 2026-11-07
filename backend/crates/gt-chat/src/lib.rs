//! Direct messages: 1:1 conversations with text messages, replies (quoting a message),
//! one emoji reaction per user and message, read/delivered receipts and typing indicators.
//!
//! * [`repository`]: `chat_conversations`, `chat_members`, `chat_messages`, `chat_reactions`;
//! * [`rules`]: pure validation (message bodies, reactions, client ids, paging);
//! * [`service`]: [`ChatService`], which checks membership and messaging permission, stores
//!   messages and fans real-time events out through [`realtime::ChatRealtime`];
//! * [`dto`]: request/response bodies and WebSocket event payloads;
//! * [`routes`]: the HTTP endpoints under `/api/chats`.
//!
//! Two users may message each other while either one actively follows the other.
//!
//! Server wiring:
//!
//! ```ignore
//! let chat = gt_chat::ChatContext::new(&core, &notify);
//! let app = Router::new().merge(gt_chat::routes(&core, &chat));
//! ```

pub mod context;
pub mod dto;
mod handlers;
pub mod realtime;
pub mod repository;
pub mod routes;
pub mod rules;
pub mod service;

pub use context::ChatContext;
pub use realtime::{ChatRealtime, NotifyRealtime};
pub use repository::ChatRepository;
pub use routes::routes;
pub use service::{ChatError, ChatService};
