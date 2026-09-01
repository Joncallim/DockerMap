//! Deterministic JSON Schema artifacts for daemon-owned public responses.
//!
//! Rust serialization remains the authority. This module deliberately exports
//! only the seven daemon response roots that cross the browser/daemon boundary.

use crate::{
    ComposeEditPlan, ComposeGraph, ComposeScan, DockerSnapshot, HealthResponse, LogsResponse,
    RuntimeMap,
};
use schemars::{schema_for, Schema};
use serde_json::Value;

pub const DAEMON_SCHEMA_NAMES: [&str; 7] = [
    "docker-snapshot",
    "runtime-map",
    "compose-scan",
    "compose-graph",
    "compose-edit-plan",
    "logs-response",
    "health-response",
];

pub fn daemon_schemas() -> [Schema; 7] {
    [
        schema_for!(DockerSnapshot),
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
pub fn daemon_schema_documents() -> [Value; 7] {
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
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::daemon_schema_documents;

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
}
