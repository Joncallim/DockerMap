export default function InfoCard(props: { title: string; value: string }) {
  return (
    <article className="panel-card compact">
      <div className="panel-label">{props.title}</div>
      <strong>{props.value}</strong>
    </article>
  );
}
