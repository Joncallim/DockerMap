import { unavailable } from "./evidence";

/**
 * DockerMap measures no per-container resource usage in any mode. Only
 * explicit demo mode may show visibly tagged samples; mock and live report
 * non-collection.
 */
const RESOURCE_STATS_DETAIL = "Resource collectors not wired — DockerMap does not measure container CPU, memory or network";

/** The single public claim object for per-service resource usage. */
export const RESOURCE_STATS_CLAIM = Object.freeze(unavailable(RESOURCE_STATS_DETAIL));
