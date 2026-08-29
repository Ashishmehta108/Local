#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::sync::Mutex;

use filefinder_agent::config::AgentConfig;
use filefinder_agent::secrets::protect_secret;
use serde::Serialize;
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
    config.data_directory = data_directory.clone();
    config.validate().map_err(|error| error.to_string())?;
    let encoded = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(data_directory.join("agent-config.json"), encoded)
        .map_err(|error| error.to_string())?;
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
            start_agent,
            agent_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to run FileFinder desktop application");
}
