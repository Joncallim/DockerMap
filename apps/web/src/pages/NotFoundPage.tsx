import StatePanel from "../components/StatePanel";

export default function NotFoundPage() {
  return <StatePanel title="Route not found" body="This page is outside the current DockerMap surface." tone="error" />;
}
