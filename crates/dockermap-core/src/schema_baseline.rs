//! Deterministic JSON Schema artifacts for daemon-owned public responses.
//!
//! Rust serialization remains the authority. This module deliberately exports
//! only the seven daemon response roots that cross the browser/daemon boundary.

use crate::{
    ComposeEditPlan, ComposeGraph, ComposeScan, DockerSnapshot, GraphResponse, HealthResponse,
    LogsResponse, RuntimeMap,
};
use schemars::{schema_for, Schema};
use serde_json::Value;

pub const DAEMON_SCHEMA_NAMES: [&str; 8] = [
    "docker-snapshot",
    "graph-response",
    "runtime-map",
    "compose-scan",
    "compose-graph",
    "compose-edit-plan",
    "logs-response",
    "health-response",
];

pub fn daemon_schemas() -> [Schema; 8] {
    [
        schema_for!(DockerSnapshot),
        schema_for!(GraphResponse),
        schema_for!(RuntimeMap),
        schema_for!(ComposeScan),
        schema_for!(ComposeGraph),
        schema_for!(ComposeEditPlan),
        schema_for!(LogsResponse),
        schema_for!(HealthResponse),
    ]
}

/// Schema documents used for fixture validation. Serde response models remain
/// forward-compatible when deserializing, while fixtures reject typoed or
/// unreviewed response fields rather than silently redefining the contract.
/// This changes schema validation only, never daemon serialization behavior.
pub fn daemon_schema_documents() -> [Value; 8] {
    daemon_schemas().map(|schema| {
        let mut document = serde_json::to_value(schema).expect("schemars schema serializes");
        deny_unknown_object_properties(&mut document);
        document
    })
}

fn deny_unknown_object_properties(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(deny_unknown_object_properties),
        Value::Object(object) => {
            for child in object.values_mut() {
                deny_unknown_object_properties(child);
            }
            if object.contains_key("properties") && !object.contains_key("additionalProperties") {
                object.insert("additionalProperties".into(), Value::Bool(false));
            }
            if object.get("format").and_then(Value::as_str) == Some("uint64") {
                object.insert(
                    "maximum".into(),
                    Value::Number(serde_json::Number::from(u64::MAX)),
                );
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{daemon_schema_documents, DAEMON_SCHEMA_NAMES};

    #[test]
    fn public_schema_generation_is_deterministic() {
        let first =
            serde_json::to_vec_pretty(&daemon_schema_documents()).expect("schemas serialize");
        let second =
            serde_json::to_vec_pretty(&daemon_schema_documents()).expect("schemas serialize");
        assert_eq!(
            first, second,
            "schema output must not depend on generation order"
        );
    }

    #[test]
    fn uint64_schema_bounds_reject_values_above_the_rust_range() {
        let snapshot_schema = DAEMON_SCHEMA_NAMES
            .iter()
            .zip(daemon_schema_documents())
            .find_map(|(name, schema)| (*name == "docker-snapshot").then_some(schema))
            .expect("snapshot schema exists");
        let validator = jsonschema::validator_for(&snapshot_schema).expect("valid schema");
        let valid = serde_json::json!({
            "containers": [], "images": [], "networks": [], "volumes": [],
            "lastUpdated": u64::MAX,
        });
        let above_u64 = serde_json::from_str(
            r#"{"containers":[],"images":[],"networks":[],"volumes":[],"lastUpdated":18446744073709551616}"#,
        )
        .expect("out-of-range JSON number parses without lossy conversion");

        assert!(validator.is_valid(&valid));
        assert!(
            !validator.is_valid(&above_u64),
            "schema must enforce the Rust u64 maximum, not only label the format"
        );
    }
}
