import { Link } from "react-router-dom";
import { StateView } from "../components/ui";

export default function NotFoundPage() {
  return (
    <div className="notfound">
      <StateView kind="error" title="Route not found" body="This page is outside the current DockerMap surface." icon="orbit" />
      <Link className="btn btn-ghost" to="/">
        Back to dashboard
      </Link>
    </div>
  );
}
