//! Journal: meetings are filed into topic notebooks that can be summarized and
//! asked questions, with answers cited back to the meetings they came from.
//!
//! - `repository` - SQLite tables `notebooks`, `notebook_entries`, `journal_meeting_status`
//! - `llm` - calls the user's configured summary model
//! - `service` - organizing, notebook summaries, question answering
//! - `commands` - Tauri commands used by `frontend/src/app/journal`

pub mod commands;
pub mod llm;
pub mod repository;
pub mod service;
