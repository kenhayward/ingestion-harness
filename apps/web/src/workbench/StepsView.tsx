import { useId, type ReactNode } from 'react';
import { outputCoverage, type ModelChoice } from '@ih/shared';
import { choiceName } from '../jobs/derive.js';
import { TONE_COLOR } from '../ui/stageStyle.js';
import {
  coverageHeadline,
  outputsLine,
  repeatLine,
  retryWarning,
  sectionIds,
  stepCards,
  stepFigures,
  type StepCard,
  type StepMetric,
} from './steps.js';
import { STEP_KIND_TONE } from '../templates/editor-derive.js';
import { SectionChip } from './tags.js';

export function StepFigures({
  metric,
  here = false,
  onShowLog,
}: {
  metric: StepMetric | undefined;
  here?: boolean;
  /** Opens the step's model log (its retried runs' attempts) from the retry warning. */
  onShowLog?: () => void;
}) {
  const f = stepFigures(metric);
  if (!f) return <p className="muted step-none">No runs yet.</p>;
  const warning = retryWarning(metric, here);
  return (
    <>
      <dl className="step-figures">
        <div>
          <dt>Runs</dt>
          <dd>{f.runs}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd data-tone={f.failedWarn ? 'warn' : undefined}>{f.failed}</dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd data-tone={f.attemptsWarn ? 'warn' : undefined}>{f.attempts}</dd>
        </div>
        <div>
          <dt>Avg time</dt>
          <dd>{f.avgTime}</dd>
        </div>
      </dl>
      {warning && (
        <p className="step-warning">
          {warning}
          {onShowLog && (
            <>
              {' '}
              <button type="button" className="link" onClick={onShowLog}>
                See the model log
              </button>
            </>
          )}
        </p>
      )}
    </>
  );
}

function Step({
  card,
  sections,
  metric,
  justAdded,
  models,
  repeat,
  onShowLog,
}: {
  models: readonly ModelChoice[];
  card: StepCard;
  onShowLog?: (() => void) | undefined;
  /** "Once per appearance · batch from its key" for a step reading a repeating section. */
  repeat: string | null;
  sections: string[];
  metric: StepMetric | undefined;
  justAdded: boolean;
}) {
  return (
    <li
      className={justAdded ? 'step-card just-added' : 'step-card'}
      aria-label={`Step ${card.number}: ${card.id}`}
    >
      <div className="step-head">
        <span className="step-number" aria-hidden="true">
          {card.number}
        </span>
        <span className={`kind-tag ${STEP_KIND_TONE[card.kind]}`}>{card.kind}</span>
        <code className="step-id">{card.id}</code>
        {justAdded && <span className="kind-tag tone-ok">JUST ADDED</span>}
        {card.model && <span className="step-model muted">{choiceName(card.model, models)}</span>}
      </div>
      {card.kind !== 'CHECK' ? (
        <>
          <dl className="step-facts">
            {card.uses !== undefined && (
              <>
                <dt>Plugin</dt>
                <dd>
                  <code>{card.uses}</code>
                </dd>
              </>
            )}
            <dt>Fills</dt>
            <dd>
              {card.fills.map((f) => (
                <code key={f} className="fill-chip">
                  {f}
                </code>
              ))}
            </dd>
            <dt>Reads</dt>
            <dd>
              {card.kind === 'PLUGIN' && card.reads.length === 0 && (
                <span className="muted">earlier values only</span>
              )}
              {card.reads.map((s) => (
                <SectionChip key={s} id={s} index={sections.indexOf(s)} />
              ))}
              {card.chunkPages !== null && (
                <span className="muted">
                  {' '}
                  · {card.chunkPages} {card.chunkPages === 1 ? 'page' : 'pages'} per call
                </span>
              )}
              {repeat && <p className="muted step-repeat">{repeat}</p>}
            </dd>
          </dl>
          <StepFigures metric={metric} onShowLog={onShowLog} />
        </>
      ) : (
        <>
          {card.compares !== null && (
            <dl className="step-facts">
              <dt>Checks</dt>
              <dd>
                <code className="fill-chip">{card.compares}</code>
              </dd>
            </dl>
          )}
          <p className="muted">compares values; no model call</p>
        </>
      )}
    </li>
  );
}

/** Handoff §6: coverage strip, then the pipeline beside the proposal card. */
export function StepsView({
  projectId,
  draftVersion,
  definition,
  after,
  metrics,
  justAdded,
  card,
  models,
  onShowStepLog,
}: {
  models: readonly ModelChoice[];
  projectId: string;
  /** Opens a step's model log from its retry warning. */
  onShowStepLog?: (stepId: string) => void;
  draftVersion: number;
  definition: Record<string, unknown>;
  /** The draft with the selected changes applied, while a proposal is open. */
  after: Record<string, unknown> | null;
  metrics: StepMetric[] | null;
  justAdded: ReadonlySet<string>;
  card: ReactNode;
}) {
  const coverageId = useId();
  const pipelineId = useId();
  const coverage = outputCoverage(definition);
  const headline = coverageHeadline(coverage, after ? outputCoverage(after) : null);
  const cards = stepCards(definition);
  const numberOf = new Map(cards.map((c) => [c.id, c.number]));
  const sections = sectionIds(definition);
  const byStep = new Map((metrics ?? []).map((m) => [m.stepId, m]));
  return (
    <>
      <section className="card coverage" data-tone={headline.tone} aria-labelledby={coverageId}>
        <div className="coverage-head">
          <h3 id={coverageId}>Which step fills each output</h3>
          <p style={{ color: TONE_COLOR[headline.tone] }}>{headline.text}</p>
        </div>
        <ul className="coverage-chips">
          {coverage.outputs.map((o, i) => {
            const steps = o.steps.map((s) => numberOf.get(s) ?? '?');
            return (
              <li
                key={`${o.kind}-${o.id}-${i}`}
                className="coverage-chip"
                data-tone={o.steps.length === 1 ? undefined : 'warn'}
              >
                <code>{o.id}</code>
                {o.steps.length === 0 ? (
                  <span className="coverage-badge" aria-hidden="true">
                    !
                  </span>
                ) : (
                  steps.map((n, j) => (
                    <span key={j} className="coverage-badge" aria-hidden="true">
                      {n}
                    </span>
                  ))
                )}
                <span className="visually-hidden">
                  {o.steps.length === 0 ? ': not filled by any step' : `: step ${steps.join(', ')}`}
                </span>
              </li>
            );
          })}
        </ul>
        {coverage.uncovered.length > 0 && (
          <p className="muted">
            Propose again, or{' '}
            <a href={`#/workbench/${projectId}/template`}>add a step by hand on the Recipe tab</a>.
          </p>
        )}
      </section>
      <div className="steps-layout">
        <section className="card pipeline" aria-labelledby={pipelineId}>
          <div className="pipeline-head">
            <h3 id={pipelineId}>Pipeline in draft v{draftVersion}</h3>
            <span className="muted">
              Per-step figures from every run of this type (cached runs left out)
            </span>
            <a href={`#/workbench/${projectId}/template`}>Edit steps on the Recipe tab</a>
          </div>
          <p className="pipeline-end">
            Prepared text, split into {sections.length}{' '}
            {sections.length === 1 ? 'section' : 'sections'}
          </p>
          <ol className="pipeline-steps">
            {cards.map((c) => (
              <Step
                key={c.id}
                onShowLog={onShowStepLog ? () => onShowStepLog(c.id) : undefined}
                card={c}
                sections={sections}
                metric={byStep.get(c.id)}
                justAdded={justAdded.has(c.id)}
                models={models}
                repeat={repeatLine(definition, c.id)}
              />
            ))}
          </ol>
          <p className="pipeline-end">{outputsLine(definition)}</p>
        </section>
        {card}
      </div>
    </>
  );
}
