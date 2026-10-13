import type { CSSProperties, ReactNode } from 'react';

/** A phase group on the Overview map (handoff §3): label and stage range sit top-right. */
export function PhasePanel({
  title,
  range,
  className,
  style,
  children,
}: {
  title: string;
  range: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <section
      className={className ? `phase-panel ${className}` : 'phase-panel'}
      aria-label={title}
      style={style}
    >
      <header className="phase-panel-head">
        <span className="phase-panel-title">{title}</span>
        <span className="phase-panel-range">{range}</span>
      </header>
      {children}
    </section>
  );
}
