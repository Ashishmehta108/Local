use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedRoot {
    pub id: Uuid,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub coordinator_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protected_agent_token: Option<String>,
    pub command_signing_public_key: String,
    pub client_certificate_pem: Option<PathBuf>,
    pub client_private_key_pem: Option<PathBuf>,
    pub coordinator_ca_pem: Option<PathBuf>,
    pub data_directory: PathBuf,
    pub roots: Vec<IndexedRoot>,
    #[serde(default = "default_batch_size")]
    pub batch_size: usize,
}

fn default_batch_size() -> usize {
    500
}

impl AgentConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).with_context(|| format!("read config {}", path.display()))?;
        let config: Self = serde_json::from_slice(&bytes).context("parse agent config")?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if !self.coordinator_url.starts_with("https://")
            && !self.coordinator_url.starts_with("http://127.0.0.1")
            && !self.coordinator_url.starts_with("http://localhost")
        {
            bail!("coordinator URL must use HTTPS except for loopback development");
        }
        if self.resolved_agent_token()?.len() < 32 {
            bail!("agent token is invalid");
        }
        if self.command_signing_public_key.len() < 40 {
            bail!("command signing public key is invalid");
        }
        let is_loopback = self.coordinator_url.starts_with("http://127.0.0.1")
            || self.coordinator_url.starts_with("http://localhost");
        if !is_loopback
            && (self.client_certificate_pem.is_none() || self.client_private_key_pem.is_none())
        {
            bail!("HTTPS agents require an mTLS client certificate and private key");
        }
        if !(1..=1000).contains(&self.batch_size) {
            bail!("batch size must be between 1 and 1000");
        }
        if self.roots.is_empty() {
            bail!("at least one indexed root is required");
        }
        Ok(())
    }

    pub fn resolved_agent_token(&self) -> Result<String> {
        if let Some(protected) = &self.protected_agent_token {
            return crate::secrets::unprotect_secret(protected);
        }
        self.agent_token
            .clone()
            .ok_or_else(|| anyhow::anyhow!("agent token is missing"))
    }
}
