export default function KpiCard(props: { label: string; value: number; detail: string }) {
  return (
    <article className="kpi-card">
      <div className="panel-label">{props.label}</div>
      <strong>{props.value}</strong>
      <span>{props.detail}</span>
    </article>
  );
}
