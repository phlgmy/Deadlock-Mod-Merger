// Deadlock Mod Manager's state.json: a tauri-plugin-store file whose
// "local-config" key holds a JSON *string* containing {version, state}, so it
// is parsed twice and must be written back the same way or DMM will not read
// it. serde_json is built with preserve_order + arbitrary_precision so
// untouched parts of the document round-trip byte-for-byte.

use serde_json::Value;
use std::path::PathBuf;

const APP_ID: &str = "dev.stormix.deadlock-mod-manager";

pub type Result<T> = std::result::Result<T, String>;

pub struct StateDoc {
    pub path: PathBuf,
    raw: Value,
    was_string: bool,
    wrapper: Value,
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        // Linux: flatpak first (the usual case), then a native install
        paths.push(home.join(".var/app").join(APP_ID).join("data").join(APP_ID).join("state.json"));
        paths.push(home.join(".local/share").join(APP_ID).join("state.json"));
        paths.push(home.join(".config").join(APP_ID).join("state.json"));
        // macOS
        paths.push(home.join("Library/Application Support").join(APP_ID).join("state.json"));
    }
    // Windows: Tauri has used both of these depending on version
    for key in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                paths.push(PathBuf::from(v).join(APP_ID).join("state.json"));
            }
        }
    }
    paths
}

pub fn load_state() -> Result<StateDoc> {
    let found = candidate_paths().into_iter().find(|p| p.exists()).ok_or_else(|| {
        let looked: Vec<String> =
            candidate_paths().iter().map(|p| p.display().to_string()).collect();
        format!(
            "Could not find Deadlock Mod Manager's state.json. Looked in:\n  {}",
            looked.join("\n  ")
        )
    })?;

    let text = std::fs::read_to_string(&found).map_err(|e| format!("{}: {e}", found.display()))?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", found.display()))?;
    let lc = raw
        .get("local-config")
        .ok_or_else(|| format!("{}: no local-config key", found.display()))?;
    let (wrapper, was_string) = match lc {
        Value::String(s) => (
            serde_json::from_str(s).map_err(|e| format!("{}: local-config: {e}", found.display()))?,
            true,
        ),
        other => (other.clone(), false),
    };
    Ok(StateDoc { path: found, raw, was_string, wrapper })
}

impl StateDoc {
    pub fn state(&self) -> &Value {
        &self.wrapper["state"]
    }

    pub fn state_mut(&mut self) -> &mut Value {
        &mut self.wrapper["state"]
    }

    /// Copy state.json beside itself before the first write of a run.
    pub fn backup(&self) -> Result<PathBuf> {
        let ts = chrono::Utc::now()
            .format("%Y-%m-%dT%H-%M-%S-%3fZ")
            .to_string();
        let backup = PathBuf::from(format!("{}.bak-{ts}", self.path.display()));
        std::fs::copy(&self.path, &backup).map_err(|e| format!("{}: {e}", backup.display()))?;
        Ok(backup)
    }

    pub fn save(&mut self) -> Result<()> {
        let lc = if self.was_string {
            Value::String(
                serde_json::to_string(&self.wrapper).map_err(|e| e.to_string())?,
            )
        } else {
            self.wrapper.clone()
        };
        self.raw["local-config"] = lc;
        let text = serde_json::to_string(&self.raw).map_err(|e| e.to_string())?;
        let tmp = PathBuf::from(format!("{}.tmp", self.path.display()));
        std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
        Ok(())
    }
}
