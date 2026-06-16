export default function EmptyPanel(props: { title: string; body: string }) {
  return (
    <div className="empty-panel">
      <strong>{props.title}</strong>
      <span>{props.body}</span>
    </div>
  );
}
