/**
 * Capture's Stage-5 control entrypoint (#335).
 *
 * This deliberately owns no protocol of its own. It gives capture its
 * connection-before-trigger lifecycle while delegating arm/mark/trigger/ack to
 * the same controller client exercised by the phase-control gate.
 */
import { armStageFivePublication } from "./stageFivePublicationControl.mjs";

export function armCaptureStageFivePublication(input) {
 return armStageFivePublication(input);
}
