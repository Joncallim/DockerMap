import { Link } from "react-router-dom";
import { EmptyState } from "../components/primitives";

export default function NotFound() {
  return (
    <div className="screen">
      <EmptyState
        icon="search"
        title="Nothing here"
        body="That view does not exist."
        action={
          <Link className="primary-link" to="/">
            Back to Command Center
          </Link>
        }
      />
    </div>
  );
}
