//! Deterministic JSON Schema artifacts for daemon-owned public responses.
//!
//! Rust serialization remains the authority. This module deliberately exports
//! only the daemon response roots that cross the browser/daemon boundary.

use crate::{
    ComposeEditPlan, ComposeGraph, ComposeScan, ContainerDetailResponse, ContainersResponse,
    DockerSnapshot, FindingsResponse, GraphResponse, HealthResponse, ImagesResponse, LogsResponse,
    NetworksResponse, ObservedChangeHistoryResponse, ObservedDockerEventHistoryResponse,
    ObservedResourceTelemetryResponse, RuntimeMap, VolumesResponse,
};
use schemars::{schema_for, Schema};
use serde_json::Value;

pub const DAEMON_SCHEMA_NAMES: [&str; 17] = [
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
    "ObservedChangeHistoryResponse",
    "ObservedDockerEventHistoryResponse",
    "ObservedResourceTelemetryResponse",
];

/// Largest integer that JavaScript JSON consumers can represent exactly.
/// Rust still stores the source fields as `u64`; the public JSON Schema makes
/// the browser-compatible subset explicit instead of promising a precision
/// that standard `JSON.parse` cannot preserve.
pub const JSON_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

pub fn daemon_schemas() -> [Schema; 17] {
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
        schema_for!(ObservedChangeHistoryResponse),
        schema_for!(ObservedDockerEventHistoryResponse),
        schema_for!(ObservedResourceTelemetryResponse),
    ]
}

/// Schema documents used for fixture validation. Serde response models remain
/// forward-compatible when deserializing, while fixtures reject typoed or
/// unreviewed response fields rather than silently redefining the contract.
/// This changes schema validation only, never daemon serialization behavior.
pub fn daemon_schema_documents() -> [Value; 17] {
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
    use crate::{ObservedChangeHistoryResponse, ObservedDockerEventHistoryResponse};
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
    fn schema_root_inventory_includes_each_declared_response_once() {
        assert_eq!(DAEMON_SCHEMA_NAMES.len(), 17);
        assert_eq!(daemon_schema_documents().len(), DAEMON_SCHEMA_NAMES.len());
        let unique = DAEMON_SCHEMA_NAMES
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), DAEMON_SCHEMA_NAMES.len());
        assert!(unique.contains(&"ObservedChangeHistoryResponse"));
        assert!(unique.contains(&"ObservedDockerEventHistoryResponse"));
        assert!(unique.contains(&"ObservedResourceTelemetryResponse"));
    }

    #[test]
    fn observed_history_statuses_are_required_nullable_and_closed() {
        let schema = DAEMON_SCHEMA_NAMES
            .iter()
            .zip(daemon_schema_documents())
            .find_map(|(name, schema)| (*name == "ObservedChangeHistoryResponse").then_some(schema))
            .expect("history schema exists");
        let validator = jsonschema::validator_for(&schema).expect("valid schema");
        let event = serde_json::json!({
            "id": "history-1", "kind": "container_appeared", "observedAtMs": 1,
            "containerId": "docker_container_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "previousStatus": null, "currentStatus": "running"
        });
        let response = serde_json::json!({
            "source": "docker", "baselineEstablished": true,
            "currentModelRevision": "publication-r1", "observedRevision": "observation-r1",
            "events": [event]
        });
        assert!(validator.is_valid(&response));
        assert!(serde_json::from_value::<ObservedChangeHistoryResponse>(response.clone()).is_ok());

        for invalid_container_id in [
            "docker_container_/srv/private/name",
            "docker_container_0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
            "docker_container_0123456789abcdef",
            "docker_container_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-extra",
        ] {
            let mut invalid = response.clone();
            invalid["events"][0]["containerId"] = serde_json::json!(invalid_container_id);
            assert!(!validator.is_valid(&invalid), "{invalid_container_id}");
            assert!(
                serde_json::from_value::<ObservedChangeHistoryResponse>(invalid).is_err(),
                "{invalid_container_id}"
            );
        }

        let mut unknown_status = response.clone();
        unknown_status["events"][0]["currentStatus"] = serde_json::json!("raw Docker status");
        assert!(!validator.is_valid(&unknown_status));

        let mut missing_status = response;
        missing_status["events"][0]
            .as_object_mut()
            .expect("event object")
            .remove("previousStatus");
        assert!(!validator.is_valid(&missing_status));
    }

    #[test]
    fn observed_docker_event_history_is_bounded_closed_and_digest_only() {
        let schema = DAEMON_SCHEMA_NAMES
            .iter()
            .zip(daemon_schema_documents())
            .find_map(|(name, schema)| {
                (*name == "ObservedDockerEventHistoryResponse").then_some(schema)
            })
            .expect("Docker event history schema exists");
        let validator = jsonschema::validator_for(&schema).expect("valid schema");
        let event = serde_json::json!({
            "id": "docker_event_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "kind": "container_restarted",
            "evidenceSource": "docker_event_stream",
            "observedAtMs": 1,
            "sourceOccurredAtMs": 1,
            "containerId": "docker_container_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "anchorModelRevision": "publication-r1",
            "anchorObservationRevision": "observation-r1"
        });
        let response = serde_json::json!({
            "source": "docker",
            "collectionState": "collecting",
            "currentModelRevision": "publication-r1",
            "currentObservationRevision": "observation-r1",
            "events": [event]
        });
        assert!(validator.is_valid(&response));
        assert!(
            serde_json::from_value::<ObservedDockerEventHistoryResponse>(response.clone()).is_ok()
        );

        let mut raw_identity = response.clone();
        raw_identity["events"][0]["id"] = serde_json::json!("docker_event_/private/name");
        assert!(!validator.is_valid(&raw_identity));
        assert!(
            serde_json::from_value::<ObservedDockerEventHistoryResponse>(raw_identity).is_err()
        );

        let mut unknown_kind = response.clone();
        unknown_kind["events"][0]["kind"] = serde_json::json!("private_action");
        assert!(!validator.is_valid(&unknown_kind));

        let unavailable = serde_json::json!({
            "source": "mock",
            "collectionState": "unavailable",
            "currentModelRevision": null,
            "currentObservationRevision": null,
            "events": []
        });
        assert!(validator.is_valid(&unavailable));
        assert!(serde_json::from_value::<ObservedDockerEventHistoryResponse>(unavailable).is_ok());

        let mut mock_connecting = response.clone();
        mock_connecting["source"] = serde_json::json!("mock");
        mock_connecting["collectionState"] = serde_json::json!("connecting");
        assert!(
            validator.is_valid(&mock_connecting),
            "portable schema metadata cannot express the response state machine"
        );
        assert!(
            serde_json::from_value::<ObservedDockerEventHistoryResponse>(mock_connecting).is_err(),
            "serde must reject a mock response that claims an active collector"
        );

        let mut unavailable_with_evidence = response.clone();
        unavailable_with_evidence["collectionState"] = serde_json::json!("unavailable");
        assert!(validator.is_valid(&unavailable_with_evidence));
        assert!(
            serde_json::from_value::<ObservedDockerEventHistoryResponse>(unavailable_with_evidence)
                .is_err(),
            "unavailable Docker must not retain references or events"
        );

        let mut collecting_without_refs = response.clone();
        collecting_without_refs["currentModelRevision"] = serde_json::Value::Null;
        collecting_without_refs["currentObservationRevision"] = serde_json::Value::Null;
        assert!(validator.is_valid(&collecting_without_refs));
        assert!(
            serde_json::from_value::<ObservedDockerEventHistoryResponse>(collecting_without_refs)
                .is_err(),
            "an active Docker collector must have current anchor revisions"
        );

        let event = response["events"][0].clone();
        let mut over_bound = response;
        over_bound["events"] = serde_json::Value::Array(std::iter::repeat_n(event, 65).collect());
        assert!(!validator.is_valid(&over_bound));
        assert!(serde_json::from_value::<ObservedDockerEventHistoryResponse>(over_bound).is_err());
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
