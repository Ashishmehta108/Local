use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use filefinder_agent::client::CoordinatorClient;
use filefinder_agent::commands;
use filefinder_agent::config::{AgentConfig, IndexedRoot};
use filefinder_agent::journal::{Journal, deletion_event};
use filefinder_agent::models::CommandAcknowledgement;
use filefinder_agent::scanner::{metadata_event, scan_root};
use filefinder_agent::watcher::RootWatcher;
use tokio::time::{Instant, interval};
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let config_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("agent-config.json"));
    let config = AgentConfig::load(&config_path)?;
    fs::create_dir_all(&config.data_directory)?;
    let mut journal = Journal::open(&config.data_directory.join("journal.sqlite3"))?;
    let agent_token = config.resolved_agent_token()?;
    let client = CoordinatorClient::new(
        config.coordinator_url.clone(),
        agent_token,
        config.client_certificate_pem.as_deref(),
        config.client_private_key_pem.as_deref(),
        config.coordinator_ca_pem.as_deref(),
    )?;
    let watchers = start_watchers(&config.roots)?;
    let (live_sender, mut live_notifications) = tokio::sync::mpsc::channel(8);
    let live_client = client.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = live_client.live_notifications(live_sender.clone()).await {
                warn!(%error, "live channel disconnected; retrying");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    initial_scan(&config.roots, &mut journal)?;
    let mut sync_tick = interval(Duration::from_secs(2));
    let mut heartbeat_tick = interval(Duration::from_secs(30));
    let mut command_fallback_tick = interval(Duration::from_secs(15));
    let mut reconcile_tick = interval(Duration::from_secs(15 * 60));
    reconcile_tick.reset_at(Instant::now() + Duration::from_secs(15 * 60));

    loop {
        tokio::select! {
            _ = sync_tick.tick() => {
                ingest_watcher_changes(&watchers, &config.roots, &mut journal)?;
                if let Err(error) = sync_pending(&client, &journal, config.batch_size).await { warn!(%error, "event synchronization deferred"); }
            }
            _ = heartbeat_tick.tick() => {
                if let Err(error) = client.heartbeat().await { warn!(%error, "heartbeat failed"); }
            }
            _ = reconcile_tick.tick() => {
                for root in &config.roots {
                    if let Err(error) = reconcile(&client, root, config.batch_size).await { warn!(%error, root = %root.path.display(), "reconciliation failed"); }
                }
            }
            _ = command_fallback_tick.tick() => {
                if let Err(error) = execute_commands(&client, &config.roots, &journal, &config.command_signing_public_key).await { warn!(%error, "fallback command polling failed"); }
            }
            Some(()) = live_notifications.recv() => {
                if let Err(error) = execute_commands(&client, &config.roots, &journal, &config.command_signing_public_key).await { warn!(%error, "live command delivery failed"); }
            }
            _ = tokio::signal::ctrl_c() => { info!("agent shutdown requested"); break; }
        }
    }
    Ok(())
}

fn start_watchers(roots: &[IndexedRoot]) -> Result<HashMap<uuid::Uuid, RootWatcher>> {
    roots
        .iter()
        .map(|root| Ok((root.id, RootWatcher::start(&root.path)?)))
        .collect()
}

fn initial_scan(roots: &[IndexedRoot], journal: &mut Journal) -> Result<()> {
    for root in roots {
        for event in scan_root(root.id, &root.path) {
            journal.append(event?)?;
        }
    }
    info!(pending = journal.pending_count()?, "initial scan journaled");
    Ok(())
}

fn ingest_watcher_changes(
    watchers: &HashMap<uuid::Uuid, RootWatcher>,
    roots: &[IndexedRoot],
    journal: &mut Journal,
) -> Result<()> {
    for root in roots {
        let Some(watcher) = watchers.get(&root.id) else {
            continue;
        };
        for path in watcher.drain_paths() {
            if path.is_file() {
                if let Ok(event) = metadata_event(root.id, &root.path, &path) {
                    journal.append(event)?;
                }
            } else if let Ok(relative) = path.strip_prefix(&root.path) {
                let relative = relative.to_string_lossy().replace('\\', "/");
                if let Some((stable_id, known_path)) = journal.file_for_path(root.id, &relative)? {
                    let name = Path::new(&known_path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    journal.append(deletion_event(root.id, stable_id, name, known_path))?;
                }
            }
        }
    }
    Ok(())
}

async fn sync_pending(
    client: &CoordinatorClient,
    journal: &Journal,
    batch_size: usize,
) -> Result<()> {
    let events = journal.pending(batch_size)?;
    if events.is_empty() {
        return Ok(());
    }
    let acknowledged = client.upload_events(events).await?;
    journal.acknowledge(acknowledged)?;
    Ok(())
}

async fn reconcile(
    client: &CoordinatorClient,
    root: &IndexedRoot,
    batch_size: usize,
) -> Result<()> {
    let session_id = client.start_reconciliation(root.id).await?;
    let mut chunk = Vec::with_capacity(batch_size);
    for entry in scan_root(root.id, &root.path) {
        chunk.push(entry?);
        if chunk.len() == batch_size {
            client
                .upload_reconciliation_chunk(session_id, &chunk)
                .await?;
            chunk.clear();
        }
    }
    if !chunk.is_empty() {
        client
            .upload_reconciliation_chunk(session_id, &chunk)
            .await?;
    }
    client.complete_reconciliation(session_id).await
}

async fn execute_commands(
    client: &CoordinatorClient,
    roots: &[IndexedRoot],
    journal: &Journal,
    command_signing_public_key: &str,
) -> Result<()> {
    for envelope in client.commands().await?.items {
        let command = match commands::verify_envelope(&envelope, command_signing_public_key) {
            Ok(command) => command,
            Err(error) => {
                error!(%error, "signed command rejected");
                continue;
            }
        };
        if !journal.claim_command(command.id)? {
            warn!(command_id = %command.id, "replayed command ignored");
            continue;
        }
        match commands::execute(&command, roots, journal) {
            Ok(()) => {
                journal.complete_command(command.id, "SUCCEEDED")?;
                client
                    .acknowledge_command(
                        command.id,
                        CommandAcknowledgement {
                            outcome: "SUCCEEDED",
                            code: "OK",
                            message: None,
                        },
                    )
                    .await?
            }
            Err(error) => {
                journal.complete_command(command.id, "FAILED")?;
                error!(command_id = %command.id, %error, "command failed");
                client
                    .acknowledge_command(
                        command.id,
                        CommandAcknowledgement {
                            outcome: "FAILED",
                            code: "OS_ERROR",
                            message: Some(&error.to_string()),
                        },
                    )
                    .await?;
            }
        }
    }
    Ok(())
}
