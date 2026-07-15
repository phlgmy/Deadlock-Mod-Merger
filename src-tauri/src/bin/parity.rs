// Headless driver for scripts/verify.mjs: runs the same analyze -> pack ->
// commit pipeline as the app and prints JSON. Honors $HOME/%APPDATA%, so the
// harness can point it at a sandbox. Not shipped to users.
//
//   parity plan <profile-id> <max-mb>
//   parity merge <profile-id> <max-mb>
//   parity update <merged-profile-id> <max-mb>
//   parity resolve <profile-id> <max-mb>   (max-mb ignored; read-only)
//   parity list <vpk-path> 0               (dump a VPK's directory)

use deadlock_mod_merger::merge::{
    analyze, build_packs, commit, index_sources, merged_dest, merged_source, Target,
};
use deadlock_mod_merger::state::load_state;
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (cmd, pid, max_mb) = match &args[..] {
        [_, c, p, m] => (c.as_str(), p.as_str(), m.parse::<u64>().unwrap_or(500)),
        _ => {
            eprintln!("usage: parity <plan|merge|update|resolve|list> <arg> <max-mb>");
            std::process::exit(2);
        }
    };

    let run = || -> Result<serde_json::Value, String> {
        if cmd == "list" {
            let entries = deadlock_mod_merger::vpk::read_dir(std::path::Path::new(pid))?;
            return Ok(json!(entries
                .iter()
                .map(|e| json!({ "path": e.path, "crc": e.crc, "size": e.size }))
                .collect::<Vec<_>>()));
        }
        let mut s = load_state()?;
        if cmd == "resolve" {
            return Ok(json!({
                "source": merged_source(&s, pid),
                "dest": merged_dest(&s, pid),
            }));
        }

        let (source_pid, target) = if cmd == "update" {
            let source = merged_source(&s, pid)
                .ok_or_else(|| format!("{pid} is not a merged profile (no source found)"))?;
            (source, Target::Existing { profile_id: pid.to_string() })
        } else {
            (pid.to_string(), Target::New)
        };

        let ctx = analyze(&s, Some(&source_pid))?;
        let index = index_sources(&ctx.sources)?;
        let packs = build_packs(&ctx.sources, &index, max_mb * 1024 * 1024);
        if cmd == "plan" {
            return Ok(json!({
                "sourceName": ctx.source_name,
                "destName": ctx.dest_name,
                "modCount": ctx.mod_count,
                "vpkCount": ctx.sources.len(),
                "totalBytes": ctx.total_bytes,
                "sources": ctx.sources.iter().map(|s| s.path.display().to_string()).collect::<Vec<_>>(),
                "packs": packs.iter().map(|p| json!({
                    "mods": p.len(),
                    "bytes": p.iter().map(|x| x.size).sum::<u64>(),
                    "paks": p.iter().map(|x| x.pak).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            }));
        }
        let res = commit(&mut s, &ctx, &packs, &index, target, |_| {})?;
        Ok(json!({
            "dest": res.dest.display().to_string(),
            "destName": res.dest_name,
            "source": source_pid,
            "names": res.names,
            "sizes": res.sizes,
            "badCrc": res.bad_crc,
        }))
    };

    match run() {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
