// Headless driver for the golden-diff parity harness. Runs the same
// analyze -> pack -> commit pipeline as the app, printing the result as JSON.
//
//   parity plan <profile-id> <max-mb>
//   parity merge <profile-id> <max-mb>
//   parity update <merged-profile-id> <max-mb>
//   parity resolve <profile-id> <max-mb>   (max-mb ignored; read-only)
//
// Honors $HOME/%APPDATA% like the app does, so the harness can point it at a
// sandbox. Not shipped to users; built only as a dev binary.

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
            eprintln!("usage: parity <plan|merge> <profile-id> <max-mb>");
            std::process::exit(2);
        }
    };

    let run = || -> Result<serde_json::Value, String> {
        let mut s = load_state()?;
        if cmd == "resolve" {
            return Ok(json!({
                "source": merged_source(&s, pid),
                "dest": merged_dest(&s, pid),
            }));
        }
        if cmd == "update" {
            let source = merged_source(&s, pid)
                .ok_or_else(|| format!("{pid} is not a merged profile (no source found)"))?;
            let ctx = analyze(&s, Some(&source))?;
            let index = index_sources(&ctx.sources)?;
            let packs = build_packs(&ctx.sources, &index, max_mb * 1024 * 1024);
            let res = commit(
                &mut s,
                &ctx,
                &packs,
                Target::Existing { profile_id: pid.to_string() },
                |_| {},
            )?;
            return Ok(json!({
                "dest": res.dest.display().to_string(),
                "destName": res.dest_name,
                "source": source,
                "names": res.names,
                "sizes": res.sizes,
                "badCrc": res.bad_crc,
            }));
        }
        let ctx = analyze(&s, Some(pid))?;
        let index = index_sources(&ctx.sources)?;
        let packs = build_packs(&ctx.sources, &index, max_mb * 1024 * 1024);
        if cmd == "plan" {
            return Ok(json!({
                "sourceName": ctx.source_name,
                "destName": ctx.dest_name,
                "modCount": ctx.mod_count,
                "vpkCount": ctx.sources.len(),
                "totalBytes": ctx.total_bytes,
                "packs": packs.iter().map(|p| json!({
                    "mods": p.len(),
                    "bytes": p.iter().map(|x| x.size).sum::<u64>(),
                    "from": p[0].pak,
                    "to": p[p.len() - 1].pak,
                })).collect::<Vec<_>>(),
            }));
        }
        let res = commit(&mut s, &ctx, &packs, Target::New, |_| {})?;
        Ok(json!({
            "dest": res.dest.display().to_string(),
            "destName": res.dest_name,
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
