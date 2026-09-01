#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::sync::Mutex;

use filefinder_agent::config::AgentConfig;
use filefinder_agent::identity::generate_device_identity;
use filefinder_agent::secrets::protect_secret;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

struct AgentProcess(Mutex<Option<CommandChild>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    configured: bool,
    running: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdentity {
    public_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingAgentIdentity {
    public_key: String,
    protected_private_key: String,
}

#[tauri::command]
fn create_agent_identity(app: tauri::AppHandle) -> Result<AgentIdentity, String> {
    let data_directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let pending_path = data_directory.join("pending-agent-identity.json");
    if pending_path.exists() {
        let pending: PendingAgentIdentity = serde_json::from_slice(
            &fs::read(&pending_path).map_err(|error| error.to_string())?,
        ).map_err(|error| error.to_string())?;
        return Ok(AgentIdentity { public_key: pending.public_key });
    }
    let identity = generate_device_identity().map_err(|error| error.to_string())?;
    let pending = PendingAgentIdentity {
        public_key: identity.public_key_spki_base64,
        protected_private_key: protect_secret(&identity.private_key_base64)
            .map_err(|error| error.to_string())?,
    };
    fs::write(
        &pending_path,
        serde_json::to_vec_pretty(&pending).map_err(|error| error.to_string())?,
    ).map_err(|error| error.to_string())?;
    Ok(AgentIdentity { public_key: pending.public_key })
}

#[tauri::command]
fn configure_agent(app: tauri::AppHandle, mut config: AgentConfig) -> Result<AgentStatus, String> {
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let token = config
        .agent_token
        .take()
        .ok_or("An enrolment token is required")?;
    config.protected_agent_token = Some(protect_secret(&token).map_err(|error| error.to_string())?);
    let pending_path = data_directory.join("pending-agent-identity.json");
    let pending: PendingAgentIdentity = serde_json::from_slice(
        &fs::read(&pending_path).map_err(|_| "Create the device identity before enrolment".to_string())?,
    ).map_err(|error| error.to_string())?;
    config.protected_device_signing_key = Some(pending.protected_private_key);
    config.data_directory = data_directory.clone();
    config.validate().map_err(|error| error.to_string())?;
    let encoded = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(data_directory.join("agent-config.json"), encoded)
        .map_err(|error| error.to_string())?;
    fs::remove_file(pending_path).map_err(|error| error.to_string())?;
    Ok(AgentStatus {
        configured: true,
        running: false,
    })
}

#[tauri::command]
fn start_agent(
    app: tauri::AppHandle,
    state: State<'_, AgentProcess>,
) -> Result<AgentStatus, String> {
    let config = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("agent-config.json");
    if !config.exists() {
        return Err("Configure the agent before starting it".into());
    }
    let mut process = state
        .0
        .lock()
        .map_err(|_| "Agent process lock was poisoned")?;
    if process.is_none() {
        let (_, child) = app
            .shell()
            .sidecar("filefinder-agent")
            .map_err(|error| error.to_string())?
            .arg(config)
            .spawn()
            .map_err(|error| error.to_string())?;
        *process = Some(child);
    }
    Ok(AgentStatus {
        configured: true,
        running: true,
    })
}

#[tauri::command]
fn agent_status(
    app: tauri::AppHandle,
    state: State<'_, AgentProcess>,
) -> Result<AgentStatus, String> {
    let configured = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("agent-config.json")
        .exists();
    let running = state
        .0
        .lock()
        .map_err(|_| "Agent process lock was poisoned")?
        .is_some();
    Ok(AgentStatus {
        configured,
        running,
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AgentProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            configure_agent,
            create_agent_identity,
            start_agent,
            agent_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to run FileFinder desktop application");
}
