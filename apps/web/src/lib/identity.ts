/**
 * Plain-text fallbacks for schema-valid but empty identity strings.
 *
 * The snapshot contract permits empty strings for unrecorded/unknown names,
 * IDs, and mount targets; detail and inventory rows keep that relationship
 * evidence VISIBLE by rendering an explicit "Unavailable …" label instead of
 * a blank value (the Networking/Storage/Images inventory-row convention).
 * Empty identities stay non-routable: the exact-map/non-empty gates in the
 * screens remain the only link-emission authority.
 */
export const UNAVAILABLE_CONTAINER = "Unavailable container name";
export const UNAVAILABLE_NETWORK = "Unavailable network name";
export const UNAVAILABLE_VOLUME = "Unavailable volume name";
export const UNAVAILABLE_IMAGE = "Unavailable image reference";
export const UNAVAILABLE_CONTAINER_ID = "Unavailable container ID";
export const UNAVAILABLE_NETWORK_ID = "Unavailable network ID";
export const UNAVAILABLE_VOLUME_ID = "Unavailable volume ID";
export const UNAVAILABLE_MOUNT_TARGET = "Unavailable mount target";
export const UNAVAILABLE_IMAGE_STATUS = "Unavailable image status";
export const UNAVAILABLE_NETWORK_DRIVER = "Unavailable network driver";
export const UNAVAILABLE_SERVICE = "Unavailable service name";
export const UNAVAILABLE_SERVICE_ID = "Unavailable service ID";
export const UNAVAILABLE_SERVICE_ROLE = "Unavailable service role";
export const UNAVAILABLE_SERVICE_STATUS = "Unavailable service status";
export const UNAVAILABLE_PORT = "Unavailable port";
export const UNAVAILABLE_RUNTIME_NODE = "Unavailable runtime node";
export const UNAVAILABLE_RUNTIME_ID = "Unavailable runtime ID";
export const UNAVAILABLE_COMPOSE_SERVICE = "Unavailable Compose service";
export const UNAVAILABLE_COMPOSE_SOURCE = "Unavailable Compose source";
export const UNAVAILABLE_COMPOSE_TARGET = "Unavailable Compose target";
export const UNAVAILABLE_LOG_SOURCE = "Unavailable log source";
export const UNAVAILABLE_USER = "Unavailable user identity";
export const UNAVAILABLE_DIAGNOSTIC_SOURCE = "Unavailable diagnostic source";
export const UNAVAILABLE_DIAGNOSTIC_FILE = "Unavailable diagnostic file";
export const UNAVAILABLE_DIAGNOSTIC_MESSAGE = "Unavailable diagnostic message";

/** Preserve null as an intentionally anonymous value while making "" visible. */
export function identityText(value: string | null | undefined, unavailable: string, anonymous = "anonymous"): string {
  if (value === "") return unavailable;
  if (value === null || value === undefined) return anonymous;
  return value;
}

/**
 * Collision wording for redacted identity collisions. Distinct records can
 * sanitize to the SAME published identity string (e.g. two networks both
 * named "[redacted]"); such identities are non-routable because no single
 * record can be selected without pointing at the wrong one.
 */
export const COLLISION_TAG = "identity collision";
export const COLLISION_HINT = "Multiple records share this identity after redaction — detail routing is unavailable.";
