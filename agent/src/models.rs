use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Operation {
    Upsert,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEvent {
    pub event_id: Uuid,
    pub sequence: u64,
    pub operation: Operation,
    pub root_id: Uuid,
    pub stable_file_id: String,
    pub name: String,
    pub relative_path: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventBatch {
    pub events: Vec<FileEvent>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchAcknowledgement {
    pub acknowledged_sequence: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCommand {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub command_type: CommandType,
    pub expires_at: DateTime<Utc>,
    pub file_id: Uuid,
    pub root_id: Uuid,
    pub stable_file_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CommandType {
    RevealFile,
    OpenFile,
}

#[derive(Debug, Deserialize)]
pub struct CommandList {
    pub items: Vec<SignedCommandEnvelope>,
}

#[derive(Debug, Deserialize)]
pub struct SignedCommandEnvelope {
    pub payload: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAcknowledgement<'a> {
    pub outcome: &'a str,
    pub code: &'a str,
    pub message: Option<&'a str>,
}
