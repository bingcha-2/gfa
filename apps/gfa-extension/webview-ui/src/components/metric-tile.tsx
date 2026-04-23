import React from "react";

type MetricTileProps = { title: string; value: string; description: string };

export function MetricTile({ title, value, description }: MetricTileProps) {
  return (
    <article className="metric-tile">
      <p className="metric-label">{title}</p>
      <h3 className="metric-value">{value}</h3>
      <p className="metric-text">{description}</p>
    </article>
  );
}
