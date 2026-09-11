import type { AtlasKey, AtlasModel } from "../../lib/atlas/types";
import { localAttachmentContext, type AtlasLocalAttachmentItem, type LocalAttachmentKind } from "../../lib/atlas/localContext";
import { presentationText } from "../../lib/atlas/presentation";

const KIND_COPY: Record<LocalAttachmentKind, string> = {
  network_membership: "Recorded network membership",
  storage_attachment: "Recorded storage attachment",
  port_publication: "Recorded port-publication context",
  daemon_state_context: "Recorded Docker daemon-state context"
};

function localMarker(item: AtlasLocalAttachmentItem): string {
  return presentationText(item.display, item);
}

/** Selected-only, non-causal attachment disclosure; it consumes AtlasModel alone. */
export default function AtlasLocalContext({ model, selectedKey }: { model: AtlasModel; selectedKey: AtlasKey | null }) {
  const context = localAttachmentContext(model, selectedKey);
  if (!context) return null;
  return <section className="atlas-local-context" aria-label="Selected recorded context">
    <h3>Recorded local context</h3>
    {context.items.length === 0 ? <p>No supported non-causal attachment is recorded for this subject.</p> : <ul>
      {context.items.map((item) => <li key={item.key}>
        <span className="atlas-local-kind">{KIND_COPY[item.kind]}</span>
        <span>{item.display}</span>
        <span className="atlas-local-marker">{localMarker(item)}</span>
      </li>)}</ul>}
    <p className="atlas-local-coverage">{context.population.resolved} recorded context item{context.population.resolved === 1 ? "" : "s"}; {context.population.unresolved} unresolved; {context.population.ambiguous} ambiguous; {context.population.omitted} omitted by bounded projection, model input, or local rail.</p>
    <p className="atlas-local-disclaimer">These are recorded non-causal contexts. They do not establish communication, data direction, host exposure, reachability, or ownership.</p>
  </section>;
}
