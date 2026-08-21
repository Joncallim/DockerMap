import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApp } from "../context";
import Icon from "../components/Icon";
import { EmptyState, ErrorState, KeyValue, Loading, Panel, StateDot, Tag } from "../components/primitives";
import { IdentityRef } from "../components/identity";
import { UNAVAILABLE_CONTAINER } from "../lib/identity";

export default function NetworkDetail({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const { name = "" } = useParams();
  const { model, loading, error } = useApp();
  const [showInternals, setShowInternals] = useState(defaultOpen);
  const network = useMemo(() => model?.networkByName.get(name) ?? null, [model, name]);

  if (loading && !model) return <Loading label={`Loading ${name}…`} />;
  if (error && !model) return <ErrorState title="Network unavailable" body={error} />;
  if (!model || !network) return <EmptyState icon="network" title="Network not found" body={`No network named "${name}" is in the current snapshot.`} action={<Link className="primary-link" to="/networking">Back to Networking</Link>} />;

  const resolved = network.members.filter((member) => member !== "" && model.byName.has(member)).length;
  const internalsId = "network-internals";
  return <div className="screen">
    <header className="screen-head detail-head"><div className="detail-id"><span className="detail-kind"><Icon name="network" size={18} /></span><div><div className="eyebrow">Docker network</div><h1 className="screen-title">{network.name}</h1></div><Tag tone="muted">{network.driver}</Tag><Tag tone={network.internal ? "warn" : "accent"}>{network.internal ? "internal" : "externally reachable"}</Tag></div><Link className="ghost-link" to="/networking">Back to Networking</Link></header>
    <div className="impact-band wide"><Count value={network.members.length} label="members" /><Count value={resolved} label="resolved members" /><Count value={network.members.length - resolved} label="unresolved members" /><Count value={network.internal ? "Yes" : "No"} label="internal" /></div>
    <div className="grid-2"><Panel title="Overview" icon="network"><KeyValue label="Name" value={network.name} mono /><KeyValue label="Driver" value={network.driver} /><KeyValue label="Internal" value={network.internal ? "Yes" : "No"} /><KeyValue label="Connected containers" value={network.members.length} /></Panel><Panel title="Connected containers" icon="service"><Members members={network.members} /></Panel></div>
    <Panel title="Network internals" icon="layers" hint="Shown on request" actions={<button type="button" className="ghost-link" aria-expanded={showInternals} aria-controls={internalsId} onClick={() => setShowInternals((value) => !value)}>{showInternals ? "Hide" : "Show"} <Icon name={showInternals ? "up" : "down"} size={13} /></button>}><div id={internalsId}>{showInternals ? <KeyValue label="Network ID" value={network.id} mono /> : <p className="muted-line">Network IDs are hidden until you ask for them.</p>}</div></Panel>
  </div>;
}
function Count({ value, label }: { value: string | number; label: string }) { return <div className="impact-cell"><strong>{value}</strong><span>{label}</span></div>; }
function Members({ members }: { members: string[] }) { const { model } = useApp(); if (members.length === 0) return <p className="muted-line">No connected containers in the current snapshot.</p>; return <ul className="svc-list">{members.map((member, index) => { const service = member ? model!.byName.get(member) : undefined; return <li className="svc-row" key={`${member}-${index}`}><StateDot state={service?.state ?? "unknown"} /><IdentityRef name={member} fallback={UNAVAILABLE_CONTAINER} to={service ? `/services/${encodeURIComponent(service.name)}` : undefined} className="svc-name" /></li>; })}</ul>; }
