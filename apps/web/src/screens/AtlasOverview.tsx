import { useEffect, useMemo, useState } from "react";
import { useApp } from "../context";
import { layoutAtlas } from "../lib/atlas/layout";
import { canonicalSubjectOrder, selectedSubject } from "../lib/atlas/project";
import type { AtlasCamera, AtlasKey } from "../lib/atlas/types";
import AtlasOverviewTopology, { markerText, safeDisplay } from "../components/atlas/AtlasOverviewTopology";
import AtlasLocalContext from "../components/atlas/AtlasLocalContext";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

const DEFAULT_CAMERA: AtlasCamera = { x: 0, y: 0, zoom: 1 };

export default function AtlasOverview() {
  const { atlas, loading, error } = useApp();
  const [selectedKey, setSelectedKey] = useState<AtlasKey | null>(null);
  const [focusRecoveryToken, setFocusRecoveryToken] = useState(0);
  const camera = DEFAULT_CAMERA;
  const layout = useMemo(() => atlas ? layoutAtlas(atlas.model) : null, [atlas]);
  const selected = atlas ? selectedSubject(atlas.model, selectedKey) : null;

  // A selection is meaningful only for this exact coherent revision. Removed,
  // ambiguous, and non-routable subjects fail closed; focus recovers to the
  // stable directory rather than retaining an obsolete route-state key.
  useEffect(() => {
    if (!atlas || !selectedKey) return;
    if (selectedSubject(atlas.model, selectedKey)) return;
    setSelectedKey(null);
    setFocusRecoveryToken((token) => token + 1);
  }, [atlas, selectedKey]);

  if (loading && !atlas) return <Loading label="Preparing the Atlas overview…" />;
  if (error && !atlas) return <ErrorState title="Atlas unavailable" body={error} />;
  if (!atlas || !layout) return <EmptyState icon="map" title="Nothing to orient" body="Atlas appears only after DockerMap publishes one coherent runtime model." />;
  if (atlas.model.subjects.length === 0) return <div className="screen atlas-screen"><header className="screen-head"><div><div className="eyebrow">Parallel preview · read-only</div><h1 className="screen-title">Atlas Overview</h1><p className="screen-sub">Identity-first orientation from the current coherent model.</p></div></header><Panel title="No observed subjects" icon="map"><EmptyState icon="map" title="Nothing to orient" body="This coherent model contains no Atlas subjects. No topology has been invented." /></Panel></div>;

  const textSubjects = canonicalSubjectOrder(atlas.model);
  return <div className="screen atlas-screen">
    <header className="screen-head">
      <div>
        <div className="eyebrow">Parallel preview · read-only</div>
        <h1 className="screen-title">Atlas Overview</h1>
        <p className="screen-sub">Identity-first orientation from one coherent runtime publication. Lanes are alignment only; they do not imply ownership or containment.</p>
      </div>
      <p className="atlas-revision" role="status">{atlas.model.stats.subjects} bounded subjects · revision current</p>
    </header>
    <AtlasOverviewTopology model={atlas.model} layout={layout} camera={camera} selectedKey={selectedKey} onSelect={setSelectedKey} focusRecoveryToken={focusRecoveryToken} />
    <section className="atlas-text-alternative" aria-label="Atlas text alternative">
      <h2>Text alternative</h2>
      <p>Subjects are listed in the same canonical order as the directory. This overview does not draw relations or attachments by default.</p>
      <ol>
        {textSubjects.map((subject) => <li key={subject.key}>{markerText(subject)}</li>)}
        {atlas.model.aggregates.map((aggregate) => <li key={aggregate.key}>{aggregate.population.resolved} resolved context records; {aggregate.population.unresolved} unresolved; {aggregate.population.ambiguous} ambiguous; {aggregate.population.omitted} omitted.</li>)}
      </ol>
    </section>
    <aside className="atlas-inspector" aria-live="polite" aria-label="Atlas inspector">
      {!selected ? <><h2>Select a subject</h2><p>Use the directory to inspect a routable subject. Collision and uncertainty records remain visible but cannot be selected.</p></> : <><h2>{safeDisplay(selected.display)}</h2><p>{markerText(selected)}</p><p>Only identity, independent state, freshness, and supported attention are shown here. This overview does not infer a dependency, network, storage, host, or exposure fact.</p><AtlasLocalContext model={atlas.model} selectedKey={selected.key} /></>}
    </aside>
  </div>;
}
