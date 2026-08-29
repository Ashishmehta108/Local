use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::Engine;
use chrono::Utc;
use ed25519_dalek::{Signature, Verifier, VerifyingKey, pkcs8::DecodePublicKey};

use crate::config::IndexedRoot;
use crate::journal::Journal;
use crate::models::{CommandType, DeviceCommand, SignedCommandEnvelope};
use crate::scanner::contained_path;

pub fn execute(command: &DeviceCommand, roots: &[IndexedRoot], journal: &Journal) -> Result<()> {
    if command.expires_at <= Utc::now() {
        bail!("command expired");
    }
    let root = roots
        .iter()
        .find(|root| root.id == command.root_id)
        .ok_or_else(|| anyhow::anyhow!("root disabled"))?;
    let relative = journal
        .path_for_file(command.root_id, &command.stable_file_id)?
        .ok_or_else(|| anyhow::anyhow!("file not found"))?;
    let path = contained_path(&root.path, Path::new(&relative))?;
    invoke_explorer(command.command_type, &path)
}

pub fn verify_envelope(
    envelope: &SignedCommandEnvelope,
    public_key_der_base64: &str,
) -> Result<DeviceCommand> {
    let public_key_der = base64::engine::general_purpose::STANDARD
        .decode(public_key_der_base64)
        .context("decode command public key")?;
    let public_key =
        VerifyingKey::from_public_key_der(&public_key_der).context("parse command public key")?;
    let signature_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&envelope.signature)
        .context("decode command signature")?;
    let signature = Signature::from_slice(&signature_bytes).context("parse command signature")?;
    public_key
        .verify(envelope.payload.as_bytes(), &signature)
        .context("command signature rejected")?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&envelope.payload)
        .context("decode command payload")?;
    serde_json::from_slice(&payload).context("parse signed command")
}

#[cfg(windows)]
fn invoke_explorer(command_type: CommandType, path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let status = match command_type {
        CommandType::RevealFile => Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .creation_flags(CREATE_NO_WINDOW)
            .status()?,
        CommandType::OpenFile => Command::new("explorer.exe")
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .status()?,
    };
    if !status.success() {
        bail!("Windows Explorer returned {status}");
    }
    Ok(())
}

#[cfg(not(windows))]
fn invoke_explorer(_command_type: CommandType, _path: &Path) -> Result<()> {
    bail!("reveal/open is only available on Windows")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_a_node_signed_command_fixture() {
        let envelope = SignedCommandEnvelope {
            payload: "eyJpZCI6IjAxOThmYmUzLTA4N2QtNzAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInR5cGUiOiJSRVZFQUxfRklMRSIsImV4cGlyZXNBdCI6IjIwOTktMDgtMjlUMTI6MDA6MDAuMDAwWiIsImZpbGVJZCI6IjAxOThmYmUzLTA4N2QtNzAwMC04MDAwLTAwMDAwMDAwMDAwMiIsInJvb3RJZCI6IjAxOThmYmUzLTA4N2QtNzAwMC04MDAwLTAwMDAwMDAwMDAwMyIsInN0YWJsZUZpbGVJZCI6InZvbHVtZTpmaWxlIn0".into(),
            signature: "SVv3K07zG85nWwrS95RUX5nBmMhn1ijKUeNyhIF3Bl_bq613E6psT-iZ6wrK0QxuE_gYY46eX3KGni3LyfT6BA".into(),
        };
        let command = verify_envelope(
            &envelope,
            "MCowBQYDK2VwAyEATeJ1vl15X2kBfkCoSesagdZaVWsgTh0o0/Jb69B3TDk=",
        )
        .unwrap();
        assert_eq!(command.command_type, CommandType::RevealFile);
        assert_eq!(command.stable_file_id, "volume:file");
    }
}
