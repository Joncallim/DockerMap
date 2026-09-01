//! Public, provider-neutral DockerMap domain models.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Container,
    Network,
    Volume,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    ConnectedTo,
    Mounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub relationship: RelationshipKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct GraphResponse {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ContainerRecord {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub role: String,
    pub networks: Vec<String>,
    pub ports: Vec<String>,
    pub mounts: Vec<ContainerMount>,
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
}

// These route response types deliberately keep the current JSON wire shapes.
// They give the browser/daemon boundary named roots for generated schemas
// without making a list or a detail response an anonymous JSON value.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ContainersResponse {
    pub containers: Vec<ContainerRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(transparent)]
pub struct ContainerDetailResponse(pub ContainerRecord);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ContainerMount {
    pub id: String,
    pub kind: ComposeMountKind,
    pub source: Option<String>,
    pub target: String,
    #[serde(rename = "readOnly")]
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ImageRecord {
    pub image: String,
    pub containers: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ImagesResponse {
    pub images: Vec<ImageRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct NetworkRecord {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub internal: bool,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct NetworksResponse {
    pub networks: Vec<NetworkRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct VolumeRecord {
    pub id: String,
    pub name: String,
    #[serde(rename = "attachedTo")]
    pub attached_to: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct VolumesResponse {
    pub volumes: Vec<VolumeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
pub struct DockerSnapshot {
    pub containers: Vec<ContainerRecord>,
    pub images: Vec<ImageRecord>,
    pub networks: Vec<NetworkRecord>,
    pub volumes: Vec<VolumeRecord>,
    #[serde(rename = "lastUpdated")]
    pub last_updated: u64,
    /// Opaque daemon-publication revision. This is a process-instance scoped,
    /// monotonic cache revision, not a timestamp and not a content hash.
    #[serde(rename = "modelRevision")]
    #[schemars(length(min = 1))]
    pub model_revision: String,
    /// ACTUAL source of these bytes: "docker" (live daemon collection) or
    /// "mock" (daemon mock fallback). Stamped by the daemon route layer from
    /// the cache's runtime mode so every model-bearing response attests its
    /// real source (#85 A3). Optional so existing constructors compile
    /// untouched; serialized only when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeMode {
    Docker,
    Mock,
}

/// Fixed, schema-backed host-provider slots. This is not a plugin or policy
/// interface: the daemon owns the complete finite list.
#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSlot {
    NetworkInfrastructure,
    HostScoped,
    PythonProcesses,
    NativeProcesses,
    ProjectNpm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStateKind {
    Fresh,
    Stale,
    Collecting,
    Unavailable,
    TimedOut,
    Disabled,
}

/// A deliberately small, non-diagnostic explanation for a provider slot that
/// is not currently serving fresh observations.  This is a closed enum rather
/// than provider supplied text: command lines, paths, error output and other
/// host details must never cross the runtime-map boundary through this field.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatusReason {
    Initial,
    Refreshing,
    CollectionFailed,
    CollectionTimedOut,
    SourceReset,
    Disabled,
}

/// Schema-only representation for a required JSON field whose value may be a
/// closed status reason or null. The wire type remains `Option` below.
#[derive(JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)]
enum ProviderStatusReasonOrNull {
    Reason(ProviderStatusReason),
    Null(()),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ProviderState {
    pub slot: ProviderSlot,
    pub state: ProviderStateKind,
    /// Wall-clock collection timestamps are nullable because a slot can have
    /// no attempt yet (or its source was reset).  The upper bound preserves
    /// lossless JSON transport through JavaScript's numeric representation.
    #[serde(rename = "lastAttemptMs")]
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    #[schemars(required, extend("type" = ["integer", "null"]))]
    pub last_attempt_ms: Option<u64>,
    #[serde(rename = "lastSuccessMs")]
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    #[schemars(required, extend("type" = ["integer", "null"]))]
    pub last_success_ms: Option<u64>,
    /// Duration of the last successful collection. Failed and timed-out
    /// passes deliberately retain this last known-good evidence.
    #[serde(rename = "lastDurationMs")]
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    #[schemars(required, extend("type" = ["integer", "null"]))]
    pub last_duration_ms: Option<u64>,
    #[serde(rename = "consecutiveFailureCount")]
    #[schemars(range(max = 4_294_967_295u64))]
    pub consecutive_failure_count: u32,
    /// Opaque, per-slot data identity. It is absent before a successful pass
    /// and after a source reset, and otherwise advances only for sanitized
    /// observable slot-data changes.
    #[serde(rename = "dataRevision")]
    #[schemars(length(min = 1))]
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub data_revision: Option<String>,
    /// Null for fresh and initial-unavailable slots. Non-null values are the
    /// closed, safe transitional/exceptional reasons above, never raw errors.
    #[serde(rename = "statusReason")]
    #[schemars(required, with = "ProviderStatusReasonOrNull")]
    pub status_reason: Option<ProviderStatusReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthState {
    Ok,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct HealthResponse {
    pub status: HealthState,
    pub mode: RuntimeMode,
    #[serde(rename = "dockerReachable")]
    pub docker_reachable: bool,
    #[serde(rename = "lastUpdated")]
    pub last_updated: u64,
    #[serde(rename = "snapshotVersion")]
    pub snapshot_version: String,
    #[serde(rename = "modelRevision")]
    #[schemars(length(min = 1))]
    pub model_revision: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: u64,
    pub container: String,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
pub struct LogsResponse {
    pub service: Option<String>,
    pub entries: Vec<LogEntry>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<String>,
    /// ACTUAL source of these bytes: "docker" or "mock" (#85 A3 / #87 E1).
    /// Stamped by the daemon route layer from the cache's runtime mode so
    /// fabricated mock log lines can never be shown as live host activity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComposeMountKind {
    Bind,
    NamedVolume,
    AnonymousVolume,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeFileOrigin {
    pub file: String,
    pub service: Option<String>,
    pub field: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeDiagnostic {
    pub id: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub origin: ComposeFileOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeMount {
    pub id: String,
    pub service: String,
    pub kind: ComposeMountKind,
    pub source: Option<String>,
    #[serde(rename = "resolvedSource")]
    pub resolved_source: Option<String>,
    pub target: String,
    #[serde(rename = "readOnly")]
    pub read_only: bool,
    pub origin: ComposeFileOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeService {
    pub name: String,
    pub image: Option<String>,
    pub environment: BTreeMap<String, String>,
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeScan {
    pub files: Vec<String>,
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    pub services: Vec<ComposeService>,
    pub mounts: Vec<ComposeMount>,
    pub correlations: Vec<MountCorrelation>,
    pub diagnostics: Vec<ComposeDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MountCorrelationStatus {
    Matched,
    Missing,
    Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct MountCorrelation {
    pub id: String,
    pub service: String,
    pub container: Option<String>,
    #[serde(rename = "composeMountId")]
    pub compose_mount_id: Option<String>,
    pub kind: ComposeMountKind,
    pub target: String,
    #[serde(rename = "declaredSource")]
    pub declared_source: Option<String>,
    #[serde(rename = "runtimeSource")]
    pub runtime_source: Option<String>,
    pub status: MountCorrelationStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComposeNodeKind {
    Service,
    HostPath,
    ContainerPath,
    NamedVolume,
    AnonymousVolume,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComposeRelationshipKind {
    DeclaresMount,
    MountedAt,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeGraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ComposeNodeKind,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeGraphEdge {
    pub source: String,
    pub target: String,
    pub relationship: ComposeRelationshipKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeGraph {
    pub nodes: Vec<ComposeGraphNode>,
    pub edges: Vec<ComposeGraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct ComposeEditPlan {
    pub file: String,
    pub service: String,
    #[serde(rename = "mountId")]
    pub mount_id: String,
    #[serde(rename = "originalSource")]
    pub original_source: Option<String>,
    #[serde(rename = "originalTarget")]
    pub original_target: String,
    #[serde(rename = "newSource")]
    pub new_source: Option<String>,
    #[serde(rename = "newTarget")]
    pub new_target: Option<String>,
    #[serde(rename = "unifiedDiff")]
    pub unified_diff: String,
    pub diagnostics: Vec<ComposeDiagnostic>,
    #[serde(rename = "willWrite")]
    pub will_write: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceEntityKind {
    Service,
    NodeApplication,
    PythonApplication,
    AiAgent,
    Session,
    Host,
    Storage,
    ExternalApi,
    DnsProvider,
    ReverseProxy,
    PackageDependency,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProviderKind {
    Docker,
    Compose,
    Host,
    Systemd,
    ScheduledJob,
    Npm,
    Pm2,
    Tmux,
    Tailscale,
    Headscale,
    Cloudflare,
    Caddy,
    ReverseProxy,
    LocalDns,
    DnsProvider,
    ExternalApi,
    Process,
    Python,
    Network,
    Kubernetes,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeNodeKind {
    Container,
    DockerNetwork,
    DockerVolume,
    Host,
    Service,
    SystemdService,
    ScheduledJob,
    Pm2App,
    TmuxSession,
    TailnetNode,
    ReverseProxy,
    LocalDnsResolver,
    DnsProvider,
    NodeApplication,
    PythonApplication,
    AiAgent,
    Package,
    Storage,
    ExternalApi,
    PackageDependency,
    Database,
    Worker,
    Process,
    NetworkListener,
    OrchestratorWorkload,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeRelationshipKind {
    ConnectedTo,
    DependsOn,
    RequiredBy,
    Requires,
    Wants,
    After,
    Before,
    PartOf,
    BindsTo,
    ConflictsWith,
    Mounts,
    Manages,
    Exposes,
    RunsOn,
    Uses,
    Calls,
    ResolvesVia,
    ProxiesTo,
    Contains,
    Owns,
    RelatedTo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeNodeLayer {
    Edge,
    Host,
    Service,
    Container,
    Process,
    Session,
    Package,
    Network,
    Storage,
    Advisory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeHealthState {
    Healthy,
    Degraded,
    Unhealthy,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOwnershipKind {
    Person,
    Team,
    System,
    Automation,
    Vendor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLocationKind {
    Host,
    Container,
    Path,
    Cluster,
    Region,
    Workspace,
    Tailnet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeServiceStatus {
    Running,
    Starting,
    Stopping,
    Stopped,
    Degraded,
    Failed,
    Unknown,
}

impl RuntimeServiceStatus {
    /// Normalize a provider-reported status string into the contract enum.
    /// Docker status text is free-form ("Up 3 hours", "Exited (0) ..."), so
    /// anything unrecognized maps to `Unknown` instead of failing to
    /// serialize.
    pub fn from_status_text(value: &str) -> Self {
        let lower = value.to_ascii_lowercase();
        if lower.starts_with("up") || lower == "running" {
            RuntimeServiceStatus::Running
        } else if lower == "starting" || lower == "created" || lower == "restarting" {
            RuntimeServiceStatus::Starting
        } else if lower == "stopping" {
            RuntimeServiceStatus::Stopping
        } else if lower == "stopped"
            || lower == "exited"
            || lower.starts_with("exited")
            || lower == "dead"
            || lower == "paused"
            || lower == "removing"
        {
            RuntimeServiceStatus::Stopped
        } else if lower == "degraded" {
            RuntimeServiceStatus::Degraded
        } else if lower == "failed" || lower == "error" {
            RuntimeServiceStatus::Failed
        } else {
            RuntimeServiceStatus::Unknown
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePackageManager {
    Npm,
    Pnpm,
    Yarn,
    Pip,
    Apt,
    Apk,
    Brew,
    Cargo,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeAdvisorySeverity {
    Low,
    Moderate,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeHealth {
    pub state: RuntimeHealthState,
    #[serde(rename = "checkedAt", skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeLogRef {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<RuntimeLogLevel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeEventRef {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeOwnership {
    pub kind: RuntimeOwnershipKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeLocation {
    pub kind: RuntimeLocationKind,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeServiceEntity {
    pub name: String,
    pub status: RuntimeServiceStatus,
    pub dependencies: Vec<String>,
    pub dependents: Vec<String>,
    /// Reserved — not emitted by current collectors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<RuntimeHealth>,
    /// Reserved — not emitted by current collectors.
    pub logs: Vec<RuntimeLogRef>,
    /// Reserved — not emitted by current collectors.
    pub events: Vec<RuntimeEventRef>,
    /// Reserved — not emitted by current collectors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<RuntimeOwnership>,
    /// Reserved — not emitted by current collectors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<RuntimeLocation>,
}

impl RuntimeServiceEntity {
    /// Minimal entity carrying only what the daemon collectors know directly:
    /// the service name and its reported status. Remaining fields stay empty
    /// so consumers can rely on the full contract shape.
    pub fn minimal(name: String, status: RuntimeServiceStatus) -> Self {
        Self {
            name,
            status,
            dependencies: Vec::new(),
            dependents: Vec::new(),
            health: None,
            logs: Vec::new(),
            events: Vec::new(),
            owner: None,
            location: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimePackageAdvisory {
    pub id: String,
    pub source: String,
    pub title: String,
    pub severity: RuntimeAdvisorySeverity,
    #[serde(rename = "fixedVersion", skip_serializing_if = "Option::is_none")]
    pub fixed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(rename = "publishedAt", skip_serializing_if = "Option::is_none")]
    pub published_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimePackageUpdate {
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    #[serde(rename = "latestVersion", skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub available: bool,
    pub advisories: Vec<RuntimePackageAdvisory>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimePackageEntity {
    pub name: String,
    pub manager: RuntimePackageManager,
    pub version: String,
    pub dependencies: Vec<String>,
    pub dependents: Vec<String>,
    /// Reserved — not emitted by current collectors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<RuntimePackageUpdate>,
    /// Reserved — not emitted by current collectors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<RuntimeOwnership>,
    /// Reserved — not emitted by current collectors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<RuntimeLocation>,
}

impl RuntimePackageEntity {
    /// Minimal entity for a package dependency node: name, version and the
    /// package manager that declared it.
    pub fn minimal(name: String, version: String) -> Self {
        Self {
            name,
            manager: RuntimePackageManager::Npm,
            version,
            dependencies: Vec::new(),
            dependents: Vec::new(),
            update: None,
            owner: None,
            location: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct RuntimeMapNode {
    pub id: String,
    pub provider: RuntimeProviderKind,
    #[serde(rename = "type")]
    pub kind: RuntimeNodeKind,
    pub label: String,
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<RuntimeNodeLayer>,
    pub metadata: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<RuntimeServiceEntity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<RuntimePackageEntity>,
}

/// Evidence provider for the version-one Docker-only evidence shape. New
/// providers require a new versioned evidence representation; they cannot be
/// passed off as v1 through the broad runtime-provider enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEvidenceProvider {
    Docker,
}

/// Version-one evidence is a direct Docker observation. Derived and inferred
/// claims need a later, deliberately versioned evidence contract rather than
/// a permissive enum value in this first slice.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEvidenceAssertionKind {
    Observed,
}

/// Safe, provider-specific fact families supported by the first provenance
/// slice.  New sources require an explicit enum addition rather than an
/// arbitrary source string or metadata map.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEvidenceKind {
    DockerNetworkMembership,
    DockerVolumeMount,
    DockerPortPublication,
}

/// A compact, versioned reference to the bounded fact supporting a runtime
/// relationship.  It intentionally contains no raw command output, config
/// fragment, path, process arguments, or generic metadata bag.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct RuntimeEvidenceRef {
    /// Version of this closed evidence representation, not a provider API
    /// version.  It lets future additions remain explicit and reviewable.
    #[schemars(range(min = 1, max = 1))]
    pub version: u8,
    #[schemars(length(min = 1, max = 259))]
    pub id: String,
    pub provider: RuntimeEvidenceProvider,
    pub kind: RuntimeEvidenceKind,
    #[serde(rename = "assertionKind")]
    pub assertion_kind: RuntimeEvidenceAssertionKind,
    /// A bounded, curated explanation; it is never copied from a raw source.
    #[schemars(length(min = 1, max = 259))]
    pub summary: String,
    /// The already-public runtime entity whose Docker fact was observed.
    #[serde(rename = "subjectRef")]
    pub subject_ref: String,
    #[serde(rename = "collectedAt")]
    #[schemars(range(max = 9_007_199_254_740_991u64))]
    pub collected_at: u64,
    /// Opaque Docker observation token, not a cache-publication revision or
    /// source dump.
    #[serde(rename = "providerRevision")]
    #[schemars(length(min = 1, max = 259))]
    pub provider_revision: String,
    /// The Docker snapshot is observed as a single current publication. Host
    /// provider freshness remains represented by `providerStates` (#66).
    pub freshness: RuntimeEvidenceFreshness,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEvidenceFreshness {
    Fresh,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct RuntimeMapEdge {
    pub source: String,
    pub target: String,
    pub relationship: RuntimeRelationshipKind,
    pub metadata: BTreeMap<String, String>,
    /// Empty for relationship families that have not yet been migrated to the
    /// evidence model. It remains present on the wire so API/UI consumers have
    /// one stable, bounded relationship shape while the migration continues.
    #[serde(rename = "evidenceRefs")]
    #[schemars(required, length(max = 8))]
    pub evidence_refs: Vec<RuntimeEvidenceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct RuntimeMapDiagnostic {
    pub provider: RuntimeProviderKind,
    pub severity: DiagnosticSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
pub struct RuntimeMap {
    pub nodes: Vec<RuntimeMapNode>,
    pub edges: Vec<RuntimeMapEdge>,
    pub diagnostics: Vec<RuntimeMapDiagnostic>,
    #[serde(rename = "lastUpdated")]
    pub last_updated: u64,
    #[serde(rename = "modelRevision")]
    #[schemars(length(min = 1))]
    pub model_revision: String,
    #[serde(rename = "providerStates")]
    #[schemars(length(min = 5, max = 5))]
    pub provider_states: Vec<ProviderState>,
    /// ACTUAL source of these bytes: "docker" or "mock" (#85 A3). Stamped by
    /// the daemon route layer from the cache's runtime mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeMode>,
}
