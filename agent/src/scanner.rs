use std::fs;
use std::path::{Component, Path};
use std::time::SystemTime;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

use crate::models::{FileEvent, Operation};

const EXCLUDED_DIRECTORY_NAMES: &[&str] = &[
    "$recycle.bin",
    "system volume information",
    "windows",
    "appdata",
    "node_modules",
    ".git",
];

pub fn scan_root(root_id: Uuid, root: &Path) -> impl Iterator<Item = Result<FileEvent>> + '_ {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_excluded(entry, root))
        .filter_map(move |entry| match entry {
            Ok(entry) if entry.file_type().is_file() => {
                Some(metadata_event(root_id, root, entry.path()))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error.into())),
        })
}

pub fn metadata_event(root_id: Uuid, root: &Path, path: &Path) -> Result<FileEvent> {
    let canonical_root =
        fs::canonicalize(root).with_context(|| format!("canonicalize root {}", root.display()))?;
    let canonical_path =
        fs::canonicalize(path).with_context(|| format!("canonicalize file {}", path.display()))?;
    let relative = canonical_path
        .strip_prefix(&canonical_root)
        .with_context(|| format!("{} escaped indexed root", path.display()))?;
    let metadata = fs::metadata(&canonical_path)?;
    let modified: DateTime<Utc> = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH).into();
    let stable_file_id = stable_file_id(&canonical_path, &metadata);
    Ok(FileEvent {
        event_id: Uuid::new_v4(),
        sequence: 0,
        operation: Operation::Upsert,
        root_id,
        stable_file_id,
        name: canonical_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        relative_path: relative.to_string_lossy().replace('\\', "/"),
        extension: canonical_path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase(),
        size_bytes: metadata.len(),
        modified_at: modified,
    })
}

pub fn contained_path(root: &Path, relative_path: &Path) -> Result<std::path::PathBuf> {
    if relative_path.is_absolute()
        || relative_path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        anyhow::bail!("relative path contains traversal or an absolute prefix");
    }
    let canonical_root = fs::canonicalize(root)?;
    let candidate = fs::canonicalize(canonical_root.join(relative_path))?;
    if !candidate.starts_with(&canonical_root) {
        anyhow::bail!("resolved path escaped indexed root");
    }
    Ok(candidate)
}

fn is_excluded(entry: &DirEntry, root: &Path) -> bool {
    if entry.path() == root || !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_string_lossy().to_lowercase();
    name.starts_with('.') || EXCLUDED_DIRECTORY_NAMES.contains(&name.as_str())
}

#[cfg(unix)]
fn stable_file_id(_path: &Path, metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", metadata.dev(), metadata.ino())
}

#[cfg(windows)]
fn stable_file_id(path: &Path, _metadata: &fs::Metadata) -> String {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return path.to_string_lossy().into_owned(),
    };
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    if succeeded == 0 {
        return path.to_string_lossy().into_owned();
    }

    let file_index = ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64;
    format!("{}:{}", information.dwVolumeSerialNumber, file_index)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn scanner_skips_hidden_and_system_style_directories() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("report.pdf"), "metadata-only").unwrap();
        fs::create_dir(directory.path().join(".git")).unwrap();
        fs::write(directory.path().join(".git/config"), "secret").unwrap();

        let entries: Vec<_> = scan_root(Uuid::new_v4(), directory.path()).collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].as_ref().unwrap().name, "report.pdf");
    }

    #[test]
    fn containment_rejects_parent_traversal() {
        let directory = tempdir().unwrap();
        assert!(contained_path(directory.path(), Path::new("../outside.txt")).is_err());
    }
}
