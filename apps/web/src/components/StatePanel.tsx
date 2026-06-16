export default function StatePanel(props: { title: string; body: string; tone?: "error" }) {
  return (
    <section className={`state-panel ${props.tone === "error" ? "state-error" : ""}`}>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
    </section>
  );
}
