use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};

use anyhow::{Context, Result};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

pub struct RootWatcher {
    _watcher: RecommendedWatcher,
    events: Receiver<notify::Result<Event>>,
}

impl RootWatcher {
    pub fn start(root: &Path) -> Result<Self> {
        let (sender, events) = channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .with_context(|| format!("watch {}", root.display()))?;
        Ok(Self {
            _watcher: watcher,
            events,
        })
    }

    pub fn drain_paths(&self) -> Vec<PathBuf> {
        self.events
            .try_iter()
            .filter_map(Result::ok)
            .flat_map(|event| event.paths)
            .collect()
    }
}
