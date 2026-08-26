# Service Map usability remediation (#83)

Status: implementation architecture. This is a web/model presentation slice; it does not expand DockerMap collection or imply new topology evidence.

## Observed problem

On Hearth, DockerMap sees 44 containers, 16 networks, and 4 volumes, but only four containers expose Compose `depends_on` labels (four declared links). The existing force graph renders all services and their labels in one 240×240 canvas, and draws coloured shared-network tracks on declared-dependency arrows. This produces a dense cluster while implying a network communication path that DockerMap has not observed. Input container order is also not canonicalised in the web model, so layout can move across equivalent refreshes.

## Product decision

Keep a graph, but make it **progressively disclosed evidence**, not the default service directory.

1. The default canvas contains only services that participate in a collision-safe, resolved Compose start-order declaration. This is the topology DockerMap actually knows.
2. The inspector supplies an always-visible service directory and coverage explanation: every observed service remains reachable, while the number with no recorded start-order relationship is explicit.
3. Selecting a service focuses the graph on that service plus its recorded direct/transitive start-order context. An isolated service remains useful: its inspector explicitly says DockerMap has no recorded start-order relationship.
4. Shared Docker networks and named volumes are context in the inspector only. They are not drawn as tracks on a service relationship because shared membership/mounting does not prove traffic, data direction, or causal dependency.
5. Compose `depends_on` is labelled as a recorded **start-order declaration**, never an observed runtime dependency. Its transitive display is clearly labelled as a derived start-order reachability count, not a failure prediction.
6. Equivalent snapshots are canonicalised by a complete container presentation key before service construction and layout. Relationship records are deterministically ordered.

## Scope

- `apps/web/src/lib/model.ts`: canonicalise service input; only evidence-backed start-order links belong to the Service Map semantic graph.
- `apps/web/src/components/ServiceMap.tsx`: remove misleading network tracks; make relationship text and empty-state truthful; retain keyboard/read-only behavior.
- `apps/web/src/screens/Map.tsx`: add coverage, service directory, selected context and storage/network evidence copy.
- `apps/web/src/styles.css` and focused model/screen regressions.

No daemon/API/contract collection changes. The existing Runtime Map remains the place that exposes raw Docker network/volume/listener topology.

## Rejected alternatives

- **Full graph plus a better force layout:** labels and edge crossings cannot explain a host for which most services have no declared relationship.
- **Network clusters or edges:** a shared Docker network proves membership/capability, not communication or service dependency; assigning multi-network services to one cluster would add an arbitrary interpretation.
- **Volume-as-directional data edges:** mounting the same volume does not establish direction, health, or a consumer/provider relationship.
- **Removing the graph entirely:** a small, selected evidence graph remains the clearest way to inspect declared start order and derived reachability.

## Verification criteria

- A 30+ service high-density fixture renders only the recorded relationship context by default, while the directory retains all filtered services.
- Equivalent reordered container snapshots produce equal service ordering, relationships, and map markup.
- No network-overlay control/edge or `via network`/failure-causality copy remains.
- Empty Attention results explain the empty result visibly and through an accessible status.
- Selection exposes declared start order, reverse declarations, derived reachability, observed ports/networks/named volumes, and explicitly reports no-record cases.
- Collision/empty identity behavior remains visible and non-routable.

## Arrested lessons

- **DM-01:** Web-only read-only presentation; no provider command, collection, secret, or write-mode change.
- **DM-05 / G-19 / G-21:** All services—including empty/collided identities—stay visible in directory evidence with occurrence-qualified keys; only unique identities are selectable/routable.
- **DM-06:** Start-order, shared membership, and derived reachability labels state exactly what the snapshot proves. No health, communication, or failure causality is invented.
- **DM-07 / DM-08:** Trace the `buildModel` relationship and layout consumers, then test ordering and every changed semantic copy path after remediation.
- **DM-09:** Selection is revalidated whenever current filtering/model data no longer exposes it; no stale focus or selection persists.
- **DM-02:** Browser coverage must use explicit waits rather than `networkidle`, and new controls require unique accessible labels.
