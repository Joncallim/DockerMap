import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApp } from "../context";
import type { Service } from "../lib/model";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, KeyValue, Loading, Panel, StateDot, Tag } from "../components/primitives";
import { IdentityRef } from "../components/identity";
import { UNAVAILABLE_CONTAINER, UNAVAILABLE_MOUNT_TARGET, UNAVAILABLE_VOLUME_ID } from "../lib/identity";

export default function VolumeDetail({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const { name = "" } = useParams();
  const { model, loading, error } = useApp();
  const [showInternals, setShowInternals] = useState(defaultOpen);
  const volume = useMemo(() => model?.volumeByName.get(name) ?? null, [model, name]);
  if (loading && !model) return <Loading label={`Loading ${name}…`} />;
  if (error && !model) return <ErrorState title="Volume unavailable" body={error} />;
  if (!model || !volume) return <EmptyState icon="storage" title="Volume not found" body={`No volume named "${name}" is in the current snapshot.`} action={<Link className="primary-link" to="/storage">Back to Storage</Link>} />;
  // Each attachedTo entry keeps its occurrence index so duplicate consumers
  // correlate to THEIR OWN matching mounts — counts stay equal to rendered rows.
  const consumers = volume.attachedTo.map((member, occurrence) => ({ member, occurrence, service: member ? model.byName.get(member) : undefined }));
  const mounts = consumers.flatMap(({ member, occurrence, service }) => service ? service.mounts.filter((mount) => mount.kind === "named_volume" && mount.source !== "" && mount.source !== null && (mount.source === volume.name || (volume.id !== "" && mount.source === volume.id))).map((mount) => ({ member, occurrence, service, mount })) : []);
  const readOnly = mounts.filter(({ mount }) => mount.readOnly).length;
  const internalsId = "volume-internals";
  return <div className="screen">
    <header className="screen-head detail-head"><div className="detail-id"><span className="detail-kind"><Icon name="storage" size={18} /></span><div><div className="eyebrow">Docker volume</div><h1 className="screen-title">{volume.name}</h1></div><Tag tone={volume.attachedTo.length ? "accent" : "muted"}>{volume.attachedTo.length ? "in use" : "idle"}</Tag></div><Link className="ghost-link" to="/storage">Back to Storage</Link></header>
    <div className="impact-band wide"><Count value={volume.attachedTo.length} label="consumers" /><Count value={consumers.filter(({ service }) => service).length} label="resolved consumers" /><Count value={readOnly} label="read-only mounts" /><Count value={mounts.length - readOnly} label="read-write mounts" /></div>
    <div className="grid-2"><Panel title="Overview" icon="storage"><KeyValue label="Name" value={volume.name} mono /><KeyValue label="Consumers" value={volume.attachedTo.length} /><KeyValue label="Use state" value={volume.attachedTo.length ? "In use" : "Idle"} /></Panel><Panel title="Connected containers" icon="service"><ConsumerList consumers={consumers} /></Panel></div>
    <Panel title="Mount configuration" icon="storage">{consumers.length === 0 ? <p className="muted-line">No connected containers in the current snapshot.</p> : <ul className="mount-list">{consumers.map(({ member, service }, index) => { const consumerMounts = mounts.filter((item) => item.member === member && item.occurrence === index); return consumerMounts.length ? consumerMounts.map(({ mount }, mountIndex) => <li key={`${member}-${index}-${mount.id}-${mountIndex}`} className="mount-row">{service && <Link className="svc-name" to={`/services/${encodeURIComponent(service.name)}`}>{member}</Link>}<code>{mount.target === "" ? UNAVAILABLE_MOUNT_TARGET : mount.target}</code><Tag tone={mount.readOnly ? "warn" : "accent"}>{mount.readOnly ? "read-only" : "read-write"}</Tag></li>) : <li key={`${member}-${index}`} className="mount-row"><IdentityRef name={member} fallback={UNAVAILABLE_CONTAINER} to={service ? `/services/${encodeURIComponent(service.name)}` : undefined} className="svc-name" /><span className="muted-line">Mount details unavailable in this snapshot</span></li>; })}</ul>}</Panel>
    <Panel title="Volume internals" icon="layers" hint="Shown on request" actions={<button type="button" className="ghost-link" aria-label={showInternals ? "Hide volume internals" : "Show volume internals"} aria-expanded={showInternals} aria-controls={internalsId} onClick={() => setShowInternals((value) => !value)}>{showInternals ? "Hide" : "Show"} <Icon name={showInternals ? "up" : "down"} size={13} /></button>}><div id={internalsId}>{showInternals ? <KeyValue label="Volume ID" value={volume.id === "" ? UNAVAILABLE_VOLUME_ID : volume.id} mono /> : <p className="muted-line">Volume IDs are hidden until you ask for them.</p>}</div></Panel>
  </div>;
}
function Count({ value, label }: { value: string | number; label: string }) { return <div className="impact-cell"><strong>{value}</strong><span>{label}</span></div>; }
function ConsumerList({ consumers }: { consumers: { member: string; occurrence: number; service: Service | undefined }[] }) { if (consumers.length === 0) return <p className="muted-line">No connected containers in the current snapshot.</p>; return <ul className="svc-list">{consumers.map(({ member, service }, index) => <li className="svc-row" key={`${member}-${index}`}><StateDot state={service?.state ?? "unknown"} /><IdentityRef name={member} fallback={UNAVAILABLE_CONTAINER} to={service ? `/services/${encodeURIComponent(service.name)}` : undefined} className="svc-name" /></li>)}</ul>; }
