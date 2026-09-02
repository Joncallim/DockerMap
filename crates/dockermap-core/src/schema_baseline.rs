//! Deterministic JSON Schema artifacts for daemon-owned public responses.
//!
//! Rust serialization remains the authority. This module deliberately exports
//! only the daemon response roots that cross the browser/daemon boundary.

use crate::{
    ComposeEditPlan, ComposeGraph, ComposeScan, ContainerDetailResponse, ContainersResponse,
    DockerSnapshot, FindingsResponse, GraphResponse, HealthResponse, ImagesResponse, LogsResponse,
    NetworksResponse, RuntimeMap, VolumesResponse,
};
use schemars::{schema_for, Schema};
use serde_json::Value;

pub const DAEMON_SCHEMA_NAMES: [&str; 14] = [
    "DockerSnapshot",
    "GraphResponse",
    "RuntimeMap",
    "FindingsResponse",
    "ComposeScan",
    "ComposeGraph",
    "ComposeEditPlan",
    "LogsResponse",
    "HealthResponse",
    "ContainersResponse",
    "ContainerDetailResponse",
    "ImagesResponse",
    "NetworksResponse",
    "VolumesResponse",
];

/// Largest integer that JavaScript JSON consumers can represent exactly.
/// Rust still stores the source fields as `u64`; the public JSON Schema makes
/// the browser-compatible subset explicit instead of promising a precision
/// that standard `JSON.parse` cannot preserve.
pub const JSON_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

pub fn daemon_schemas() -> [Schema; 14] {
    [
        schema_for!(DockerSnapshot),
        schema_for!(GraphResponse),
        schema_for!(RuntimeMap),
        schema_for!(FindingsResponse),
        schema_for!(ComposeScan),
        schema_for!(ComposeGraph),
        schema_for!(ComposeEditPlan),
        schema_for!(LogsResponse),
        schema_for!(HealthResponse),
        schema_for!(ContainersResponse),
        schema_for!(ContainerDetailResponse),
        schema_for!(ImagesResponse),
        schema_for!(NetworksResponse),
        schema_for!(VolumesResponse),
    ]
}

/// Schema documents used for fixture validation. Serde response models remain
/// forward-compatible when deserializing, while fixtures reject typoed or
/// unreviewed response fields rather than silently redefining the contract.
/// This changes schema validation only, never daemon serialization behavior.
pub fn daemon_schema_documents() -> [Value; 14] {
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
                    Value::Number(serde_json::Number::from(JSON_SAFE_INTEGER_MAX)),
                );
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{daemon_schema_documents, DAEMON_SCHEMA_NAMES, JSON_SAFE_INTEGER_MAX};
    use serde_json::Value;

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
    fn public_integer_schema_bounds_reject_values_above_the_json_safe_range() {
        let snapshot_schema = DAEMON_SCHEMA_NAMES
            .iter()
            .zip(daemon_schema_documents())
            .find_map(|(name, schema)| (*name == "DockerSnapshot").then_some(schema))
            .expect("snapshot schema exists");
        let validator = jsonschema::validator_for(&snapshot_schema).expect("valid schema");
        let valid = serde_json::json!({
            "containers": [], "images": [], "networks": [], "volumes": [],
            "lastUpdated": JSON_SAFE_INTEGER_MAX,
            "modelRevision": "test-revision",
        });
        let above_json_safe = serde_json::from_str(
            r#"{"containers":[],"images":[],"networks":[],"volumes":[],"lastUpdated":9007199254740992}"#,
        )
        .expect("first unsafe JSON integer parses exactly");

        assert!(validator.is_valid(&valid));
        assert!(
            !validator.is_valid(&above_json_safe),
            "schema must reject integers that browser JSON consumers cannot represent exactly"
        );
    }

    #[test]
    fn model_revision_is_required_and_nonempty_in_every_model_envelope_schema() {
        for name in ["DockerSnapshot", "RuntimeMap", "HealthResponse"] {
            let schema = DAEMON_SCHEMA_NAMES
                .iter()
                .zip(daemon_schema_documents())
                .find_map(|(candidate, schema)| (*candidate == name).then_some(schema))
                .expect("model schema exists");
            let revision = schema
                .pointer("/properties/modelRevision")
                .expect("model revision property exists");
            assert_eq!(
                revision.get("minLength").and_then(|value| value.as_u64()),
                Some(1)
            );
            assert!(schema
                .get("required")
                .and_then(|value| value.as_array())
                .is_some_and(|required| required.iter().any(|field| field == "modelRevision")));
        }
    }

    #[test]
    fn runtime_provider_states_schema_is_exactly_the_fixed_static_slot_count() {
        let schema = DAEMON_SCHEMA_NAMES
            .iter()
            .zip(daemon_schema_documents())
            .find_map(|(name, schema)| (*name == "RuntimeMap").then_some(schema))
            .expect("runtime map schema exists");
        let states = schema
            .pointer("/properties/providerStates")
            .expect("provider state property exists");
        assert_eq!(
            states.get("minItems").and_then(|value| value.as_u64()),
            Some(6)
        );
        assert_eq!(
            states.get("maxItems").and_then(|value| value.as_u64()),
            Some(6)
        );
    }

    #[test]
    fn provider_freshness_schema_is_bounded_nullable_and_closed() {
        let schema = DAEMON_SCHEMA_NAMES
            .iter()
            .zip(daemon_schema_documents())
            .find_map(|(name, schema)| (*name == "RuntimeMap").then_some(schema))
            .expect("runtime map schema exists");
        let state = schema
            .pointer("/$defs/ProviderState")
            .expect("provider state definition exists");
        let required = state
            .get("required")
            .and_then(|value| value.as_array())
            .expect("provider freshness fields are always present, even when null");
        for field in ["lastAttemptMs", "lastSuccessMs", "lastDurationMs"] {
            let property = state
                .pointer(&format!("/properties/{field}"))
                .expect("freshness timestamp property exists");
            assert_eq!(
                property.get("maximum").and_then(|value| value.as_u64()),
                Some(JSON_SAFE_INTEGER_MAX),
                "{field} must remain lossless through browser JSON"
            );
            assert!(property
                .get("type")
                .and_then(|types| types.as_array())
                .is_some_and(|types| types.contains(&Value::String("null".into()))));
            assert!(required.iter().any(|candidate| candidate == field));
        }
        assert_eq!(
            state
                .pointer("/properties/dataRevision/minLength")
                .and_then(|value| value.as_u64()),
            Some(1)
        );
        assert!(required.iter().any(|candidate| candidate == "dataRevision"));
        assert!(required.iter().any(|candidate| candidate == "statusReason"));
        assert_eq!(
            state
                .pointer("/properties/consecutiveFailureCount/maximum")
                .and_then(|value| value.as_u64()),
            Some(u32::MAX as u64),
            "failure counts must not promise values beyond the Rust u32 wire type"
        );
        let reasons = schema
            .pointer("/$defs/ProviderStatusReason/enum")
            .and_then(|value| value.as_array())
            .expect("nullable closed status reason enum exists");
        assert_eq!(reasons.len(), 6);
        assert!(reasons.iter().all(|reason| reason.is_string()));
    }
}
