pub mod merge;
pub mod state;
pub mod vpk;

use merge::{analyze, build_packs, commit, index_sources, merged_dest, merged_source, Target};
use serde_json::{json, Value};
use state::{load_state, StateDoc};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// One merge at a time; the UI disables itself, this is the backstop.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Where a merge of `profile_id` lands: (source profile, existing merged
/// profile to overwrite, if any). Selecting a merged profile updates it from
/// its source; selecting a source that already has a merged profile
/// overwrites that one; otherwise a fresh profile is created.
fn resolve(s: &StateDoc, profile_id: &str) -> (String, Option<String>) {
    if let Some(src) = merged_source(s, profile_id) {
        (src, Some(profile_id.to_string()))
    } else if let Some(dst) = merged_dest(s, profile_id) {
        (profile_id.to_string(), Some(dst))
    } else {
        (profile_id.to_string(), None)
    }
}

#[tauri::command]
fn profiles() -> Result<Value, String> {
    merge::list_profiles()
}

#[tauri::command]
fn plan(profile_id: String, max_mb: u64) -> Result<Value, String> {
    let s = load_state()?;
    let (source_pid, dest_pid) = resolve(&s, &profile_id);
    let ctx = analyze(&s, Some(&source_pid))?;
    let index = index_sources(&ctx.sources)?;
    let packs = build_packs(&ctx.sources, &index, max_mb * 1024 * 1024);

    let dest_name = match &dest_pid {
        Some(pid) => {
            s.state()["profiles"][pid]["name"].as_str().unwrap_or(&ctx.dest_name).to_string()
        }
        None => ctx.dest_name.clone(),
    };
    Ok(json!({
        "sourceName": ctx.source_name,
        "destName": dest_name,
        "isUpdate": profile_id != source_pid,
        "willOverwrite": dest_pid.is_some() && profile_id == source_pid,
        "sourceDir": ctx.source_dir.display().to_string(),
        "modCount": ctx.mod_count,
        "vpkCount": ctx.sources.len(),
        "totalBytes": ctx.total_bytes,
        "packs": packs.iter().map(|p| json!({
            "mods": p.len(),
            "bytes": p.iter().map(|x| x.size).sum::<u64>(),
        })).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
async fn merge_profile(
    app: tauri::AppHandle,
    profile_id: String,
    max_mb: u64,
) -> Result<Value, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A merge is already running.".into());
    }
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let mut s = load_state()?;
        let (source_pid, dest_pid) = resolve(&s, &profile_id);
        let target = match &dest_pid {
            Some(pid) => Target::Existing { profile_id: pid.clone() },
            None => Target::New,
        };
        let ctx = analyze(&s, Some(&source_pid))?;
        let index = index_sources(&ctx.sources)?;
        let packs = build_packs(&ctx.sources, &index, max_mb * 1024 * 1024);

        let mut last_emit = std::time::Instant::now();
        let res = commit(&mut s, &ctx, &packs, &index, target, |p| {
            // Progress fires per copied file; cap the event rate for the UI.
            if last_emit.elapsed().as_millis() >= 50 || p["written"] == p["total"] {
                last_emit = std::time::Instant::now();
                let _ = app.emit("merge-progress", &p);
            }
        })?;

        Ok::<Value, String>(json!({
            "destName": res.dest_name,
            "sourceName": ctx.source_name,
            "dest": res.dest.display().to_string(),
            "packs": res.names.len(),
            "bytes": res.sizes.iter().sum::<u64>(),
            "badCrc": res.bad_crc,
            "backup": res.backup.display().to_string(),
            "updated": dest_pid.is_some(),
        }))
    });
    let result = match handle.await {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    };
    RUNNING.store(false, Ordering::SeqCst);
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![profiles, plan, merge_profile])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
