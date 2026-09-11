import { useEffect, useMemo, useRef } from "react";
import { useApp } from "../context";
import { useAtlasState } from "../hooks/useAtlasState";
import { initialAtlasCamera, layoutAtlas } from "../lib/atlas/layout";
import { canonicalSubjectOrder } from "../lib/atlas/project";
import { ATLAS_LENSES, atlasLensView } from "../lib/atlas/lens";
import type { AtlasCamera } from "../lib/atlas/types";
import AtlasOverviewTopology, { markerText, safeDisplay } from "../components/atlas/AtlasOverviewTopology";
import AtlasLocalContext from "../components/atlas/AtlasLocalContext";
import { EmptyState, ErrorState, Loading, Panel } from "../components/primitives";

export default function AtlasOverview() {
  const { atlas, loading, error } = useApp();
  const atlasState = useAtlasState(atlas?.model ?? null, atlas?.sourceRevision ?? null);
  const expandedContentRef = useRef<HTMLParagraphElement | null>(null);
  // This ref establishes the single deterministic entry framing. It is not
  // derived from Atlas data, so a coherent revision cannot refit/recenter it.
  const cameraRef = useRef<AtlasCamera | null>(null);
  if (!cameraRef.current) cameraRef.current = initialAtlasCamera();
  const camera = cameraRef.current;
  const layout = useMemo(() => atlas ? layoutAtlas(atlas.model) : null, [atlas]);
  const lensView = useMemo(() => atlas && layout ? atlasLensView(atlas.model, layout, atlasState.lens, atlasState.selectedKey) : null, [atlas, atlasState.lens, atlasState.selectedKey, layout]);
  const expandedAggregate = atlasState.expandedKey && atlas ? atlas.model.aggregates.find((entry) => entry.key === atlasState.expandedKey) ?? null : null;
  const expandedGroup = atlasState.expandedKey && atlas ? atlas.model.groups.find((entry) => entry.key === atlasState.expandedKey) ?? null : null;
  useEffect(() => {
    if (atlasState.focusTarget === "aggregate" || atlasState.focusTarget === "group") expandedContentRef.current?.focus();
  }, [atlasState.expandedKey, atlasState.focusTarget]);

  if (loading && !atlas) return <Loading label="Preparing the Atlas overview…" />;
  if (error && !atlas) return <ErrorState title="Atlas unavailable" body={error} />;
  if (!atlas || !layout || !lensView) return <EmptyState icon="map" title="Nothing to orient" body="Atlas appears only after DockerMap publishes one coherent runtime model." />;
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
    {atlasState.selectionStatus && <p className="atlas-route-status" role="status">Selected subject is unavailable in this coherent revision.</p>}
    <section className="atlas-lens-controls" aria-label="Atlas lens">
      <h2>Lens</h2>
      <div role="group" aria-label="Atlas lens choices">
        {ATLAS_LENSES.map((lens) => <button key={lens} type="button" aria-pressed={atlasState.lens === lens} onClick={() => atlasState.setLens(lens)}>{lens === "overview" ? "Overview" : lens[0]!.toUpperCase() + lens.slice(1)}</button>)}
      </div>
      <p>{lensView.description}</p>
    </section>
    <AtlasOverviewTopology model={atlas.model} layout={layout} camera={camera} selectedKey={atlasState.selectedKey} onSelect={atlasState.select} focusSubject={atlasState.focusTarget === "subject"} focusRecoveryToken={atlasState.focusRecoveryToken} lensView={lensView} />
    {(atlas.model.aggregates.length > 0 || atlas.model.groups.length > 0) && <section className="atlas-context-expansions" aria-label="Atlas context summaries">
      <h2>Context summaries</h2>
      <p>These bounded summaries are recorded context coverage, not inferred topology or causality.</p>
      <ul>
        {atlas.model.aggregates.map((aggregate, index) => <li key={aggregate.key}><button type="button" aria-label={`Recorded context coverage ${index + 1} of ${atlas.model.aggregates.length}`} aria-expanded={atlasState.expandedKey === aggregate.key} onClick={() => atlasState.expand(atlasState.expandedKey === aggregate.key ? null : aggregate.key)}>Expand recorded context coverage {index + 1} of {atlas.model.aggregates.length}</button></li>)}
        {atlas.model.groups.map((group, index) => <li key={group.key}><button type="button" aria-label={`Published group coverage ${index + 1} of ${atlas.model.groups.length}`} aria-expanded={atlasState.expandedKey === group.key} onClick={() => atlasState.expand(atlasState.expandedKey === group.key ? null : group.key)}>Expand published group coverage {index + 1} of {atlas.model.groups.length}</button></li>)}
      </ul>
      {expandedAggregate && <p ref={expandedContentRef} tabIndex={-1} data-atlas-expanded="aggregate">{expandedAggregate.population.resolved} resolved context records; {expandedAggregate.population.unresolved} unresolved; {expandedAggregate.population.ambiguous} ambiguous; {expandedAggregate.population.omitted} omitted.</p>}
      {expandedGroup && <p ref={expandedContentRef} tabIndex={-1} data-atlas-expanded="group">{expandedGroup.memberKeys.length} published group members. Group coverage does not imply containment.</p>}
    </section>}
    <section className="atlas-text-alternative" aria-label="Atlas text alternative">
      <h2>Text alternative</h2>
      <p>Subjects are listed in the same canonical order as the directory. {lensView.description}</p>
      <ol>
        {textSubjects.map((subject) => <li key={subject.key}>{markerText(subject)}</li>)}
        {atlas.model.aggregates.map((aggregate) => <li key={aggregate.key}>{aggregate.population.resolved} resolved context records; {aggregate.population.unresolved} unresolved; {aggregate.population.ambiguous} ambiguous; {aggregate.population.omitted} omitted.</li>)}
      </ol>
      {lensView.routes.routes.length > 0 && <p>{lensView.routes.routes.length} recorded connector{lensView.routes.routes.length === 1 ? "" : "s"} shown in the visual orientation surface.</p>}
    </section>
    <aside className="atlas-inspector" aria-live="polite" aria-label="Atlas inspector">
      {!atlasState.selected ? <><h2>Select a subject</h2><p>Use the directory to inspect a routable subject. Collision and uncertainty records remain visible but cannot be selected.</p></> : <><h2>{safeDisplay(atlasState.selected.display)}</h2><p>{markerText(atlasState.selected)}</p><p>{lensView.description}</p><AtlasLocalContext model={atlas.model} selectedKey={atlasState.selected.key} /></>}
    </aside>
  </div>;
}
