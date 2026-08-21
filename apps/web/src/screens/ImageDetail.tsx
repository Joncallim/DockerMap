import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, KeyValue, Loading, Panel, StateDot, Tag } from "../components/primitives";
import { IdentityRef } from "../components/identity";
import { UNAVAILABLE_CONTAINER } from "../lib/identity";

export default function ImageDetail() {
  const { image = "" } = useParams();
  const { model, loading, error } = useApp();
  const [showInternals, setShowInternals] = useState(false);
  const record = useMemo(() => model?.imageByRef.get(image) ?? null, [model, image]);
  if (loading && !model) return <Loading label={`Loading ${image}…`} />;
  if (error && !model) return <ErrorState title="Image unavailable" body={error} />;
  if (!model || !record) return <EmptyState icon="image" title="Image not found" body={`No image reference "${image}" is in the current snapshot.`} action={<Link className="primary-link" to="/images">Back to Images</Link>} />;
  const consumers = record.containers.map((container) => ({ container, service: container ? model.byName.get(container) : undefined }));
  const states = new Set(consumers.flatMap(({ service }) => service ? [service.state] : []));
  const internalsId = "image-internals";
  return <div className="screen">
    <header className="screen-head detail-head"><div className="detail-id"><span className="detail-kind"><Icon name="image" size={18} /></span><div><div className="eyebrow">Docker image</div><h1 className="screen-title mono">{record.image}</h1></div><Tag tone="muted">{record.status}</Tag></div><Link className="ghost-link" to="/images">Back to Images</Link></header>
    <div className="impact-band wide"><Count value={record.containers.length} label="consumers" /><Count value={consumers.filter(({ service }) => service).length} label="resolved consumers" /><Count value={consumers.filter(({ service }) => !service).length} label="unresolved consumers" /><Count value={states.size} label="service states" /></div>
    <div className="grid-2"><Panel title="Overview" icon="image"><KeyValue label="Image reference" value={record.image} mono /><KeyValue label="Raw aggregate status" value={record.status} mono /><KeyValue label="Consumers" value={record.containers.length} /></Panel><Panel title="Connected containers" icon="service">{consumers.length === 0 ? <p className="muted-line">No consumers in the current snapshot.</p> : <ul className="svc-list">{consumers.map(({ container, service }, index) => <li className="svc-row" key={`${container}-${index}`}><StateDot state={service?.state ?? "unknown"} /><IdentityRef name={container} fallback={UNAVAILABLE_CONTAINER} to={service ? `/services/${encodeURIComponent(service.name)}` : undefined} className="svc-name" />{service && <Tag tone="muted">{service.state}</Tag>}</li>)}</ul>}</Panel></div>
    <Panel title="Image configuration" icon="layers" hint="Shown on request" actions={<button type="button" className="ghost-link" aria-expanded={showInternals} aria-controls={internalsId} onClick={() => setShowInternals((value) => !value)}>{showInternals ? "Hide" : "Show"} <Icon name={showInternals ? "up" : "down"} size={13} /></button>}>{showInternals ? <div id={internalsId}><KeyValue label="Exact image reference" value={record.image} mono /><KeyValue label="Raw aggregate status" value={record.status} mono /></div> : <p className="muted-line">Exact image references and raw status are hidden until you ask for them.</p>}</Panel>
  </div>;
}
function Count({ value, label }: { value: string | number; label: string }) { return <div className="impact-cell"><strong>{value}</strong><span>{label}</span></div>; }
