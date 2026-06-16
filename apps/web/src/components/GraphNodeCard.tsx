import { Link } from "react-router-dom";
import type { GraphResponse } from "@dockermap/contracts";

export default function GraphNodeCard(props: { node: GraphResponse["nodes"][number] }) {
  const destination =
    props.node.type === "container"
      ? `/containers/${props.node.label}`
      : props.node.type === "network"
        ? `/networks?network=${props.node.id}`
        : `/volumes?volume=${props.node.id}`;

  return (
    <Link className={`graph-node ${props.node.type}`} to={destination}>
      <span>{props.node.type}</span>
      <strong>{props.node.label}</strong>
    </Link>
  );
}
