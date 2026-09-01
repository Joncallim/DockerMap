//! Generate/check committed JSON Schema for daemon-owned public responses.

use dockermap_core::schema_baseline::{daemon_schema_documents, DAEMON_SCHEMA_NAMES};
use std::{env, fs, path::PathBuf, process::ExitCode};

fn output_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("packages/contracts/generated/rust")
}

fn render() -> Result<Vec<(String, String)>, String> {
    DAEMON_SCHEMA_NAMES
        .into_iter()
        .zip(daemon_schema_documents())
        .map(|(name, schema)| {
            let content = serde_json::to_string_pretty(&schema)
                .map_err(|error| format!("failed to serialize {name} schema: {error}"))?;
            Ok((format!("{name}.schema.json"), format!("{content}\n")))
        })
        .collect()
}

fn main() -> ExitCode {
    let check = matches!(env::args().nth(1).as_deref(), Some("--check"));
    if !check && env::args().nth(1).is_some() {
        eprintln!("usage: generate-contract-schemas [--check]");
        return ExitCode::FAILURE;
    }

    let output_dir = output_dir();
    let rendered = match render() {
        Ok(rendered) => rendered,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };

    if check {
        let mut stale = false;
        let second_render = match render() {
            Ok(rendered) => rendered,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        };
        if rendered != second_render {
            stale = true;
            eprintln!("non-deterministic generated schema output");
        }
        let expected_names = DAEMON_SCHEMA_NAMES
            .iter()
            .map(|name| format!("{name}.schema.json"))
            .collect::<std::collections::BTreeSet<_>>();
        match fs::read_dir(&output_dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !expected_names.contains(&name) {
                        stale = true;
                        eprintln!("unexpected generated schema: {}", entry.path().display());
                    }
                }
            }
            Err(_) => {
                stale = true;
                eprintln!(
                    "missing generated schema directory: {}",
                    output_dir.display()
                );
            }
        }
        for (name, expected) in rendered {
            let path = output_dir.join(&name);
            match fs::read_to_string(&path) {
                Ok(actual) if actual == expected => {}
                Ok(_) => {
                    stale = true;
                    eprintln!("stale generated schema: {}", path.display());
                }
                Err(_) => {
                    stale = true;
                    eprintln!("missing generated schema: {}", path.display());
                }
            }
        }
        return if stale {
            ExitCode::FAILURE
        } else {
            ExitCode::SUCCESS
        };
    }

    if let Err(error) = fs::create_dir_all(&output_dir) {
        eprintln!("failed to create {}: {error}", output_dir.display());
        return ExitCode::FAILURE;
    }
    for (name, content) in rendered {
        let path = output_dir.join(name);
        if let Err(error) = fs::write(&path, content) {
            eprintln!("failed to write {}: {error}", path.display());
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}
