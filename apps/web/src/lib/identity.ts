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
