pub mod discovery;
pub mod parser;
pub mod resolver;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Discriminated union for all mount declaration types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ComposeMountDeclaration {
    Bind(BindMount),
    Volume(NamedVolume),
    Anonymous(AnonymousVolume),
    Tmpfs(TmpfsMount),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindMount {
    /// Raw value from YAML (may be relative or contain `${VAR}`).
    pub source: String,
    /// Absolute path after resolution; `None` if resolution failed.
    pub resolved_source: Option<String>,
    pub target: String,
    pub read_only: bool,
    /// Path to the compose file that declared this mount.
    pub source_file: String,
    pub source_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedVolume {
    pub volume_name: String,
    pub target: String,
    pub read_only: bool,
    pub source_file: String,
    pub source_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnonymousVolume {
    pub target: String,
    pub source_file: String,
    pub source_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmpfsMount {
    pub target: String,
    pub source_file: String,
    pub source_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeService {
    pub name: String,
    pub image: Option<String>,
    /// Build context path (string or `build.context`).
    pub build: Option<String>,
    pub mounts: Vec<ComposeMountDeclaration>,
    pub depends_on: Vec<String>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeFile {
    /// Absolute path to the compose file.
    pub path: String,
    /// Directory containing the compose file (used as base for relative paths).
    pub project_dir: String,
    pub services: Vec<ComposeService>,
    /// Top-level named volume declarations.
    pub named_volumes: Vec<String>,
    pub diagnostics: Vec<ComposeDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeDiagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<usize>,
}
