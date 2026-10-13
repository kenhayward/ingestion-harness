import type { ReactNode } from 'react';

/** A phase group on the Overview map (handoff §3): label and stage range sit top-right. */
export function PhasePanel({
  title,
  range,
  className,
  children,
}: {
  title: string;
  range: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `phase-panel ${className}` : 'phase-panel'} aria-label={title}>
      <header className="phase-panel-head">
        <span className="phase-panel-title">{title}</span>
        <span className="phase-panel-range">{range}</span>
      </header>
      {children}
    </section>
  );
}
