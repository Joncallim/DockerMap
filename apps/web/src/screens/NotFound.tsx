import { Link } from "react-router-dom";
import Icon from "../components/Icon";

export default function NotFound() {
  return (
    <div className="screen">
      <section className="empty">
        <span className="empty-icon"><Icon name="search" size={22} /></span>
        <h1>Nothing here</h1>
        <p>That view does not exist.</p>
        <Link className="primary-link" to="/">Back to Command Center</Link>
      </section>
    </div>
  );
}
