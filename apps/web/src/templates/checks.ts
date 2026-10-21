import { OVERVIEW_TAB_LABEL, outputCoverage, type OverviewItem } from '@ih/shared';

/** The embedded editor's sub-tabs (handoff §10; Quality is the Templates page's only). */
export type SubTab = 'general' | 'sections' | 'outputs' | 'pipeline' | 'mapping' | 'yaml';

export const SUB_TAB_LABEL: Record<SubTab, string> = {
  general: 'General',
  sections: 'Sections',
  outputs: 'Outputs',
  pipeline: 'Pipeline',
  mapping: 'Mapping',
  yaml: 'YAML',
};

export interface TemplateCheck {
  tone: 'ok' | 'warn' | 'alert' | 'danger';
  text: string;
  /** Where it is fixed: a project tab, or one of the editor's sub-tabs. */
  link: { label: string; hash: string } | { label: string; subTab: SubTab } | null;
  /** The sub-tabs that get a warn dot for it. */
  subTabs: SubTab[];
}

/** The coverage issues, which the Checks panel words itself (with a link to the Pipeline tab). */
const COVERAGE = /is (not filled by any step|filled by more than one step)$/;

/** The sub-tab where a validation issue (as `validateDefinition` words it) is fixed. */
export function issueSubTab(issue: string): SubTab {
  if (/^document\.sections/.test(issue)) return 'sections';
  if (/^semantics\b/.test(issue)) return 'mapping';
  if (/^(outputs|duplicate output id|output id ")/.test(issue)) return 'outputs';
  if (/^(pipeline|step "|check "|duplicate step id)/.test(issue)) return 'pipeline';
  return 'general';
}

/** A server issue in the editor's wording: `path: message`, or the message alone. */
export const issueText = (i: { path: string; message: string }) =>
  i.path ? `${i.path}: ${i.message}` : i.message;

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Repeating sections that three or more table steps (extract or plugin) read. */
export function sharedRepeatSteps(
  definition: Record<string, unknown>,
): { section: string; steps: string[] }[] {
  const repeating = asList(asRecord(definition.document).sections)
    .map(asRecord)
    .filter((s) => s.repeat === true && typeof s.id === 'string')
    .map((s) => s.id as string);
  const steps = asList(definition.pipeline)
    .map(asRecord)
    .filter(
      (s) =>
        (s.type === 'extract' || s.type === 'plugin') &&
        typeof s.table === 'string' &&
        typeof s.id === 'string',
    );
  return repeating
    .map((section) => ({
      section,
      steps: steps.filter((s) => asList(s.sections).includes(section)).map((s) => s.id as string),
    }))
    .filter((g) => g.steps.length >= 3);
}

/** Groups of three or more tables with the same column ids in the same order. */
export function sameShapeTables(definition: Record<string, unknown>): string[][] {
  const groups = new Map<string, string[]>();
  for (const t of asList(asRecord(definition.outputs).tables).map(asRecord)) {
    if (typeof t.id !== 'string') continue;
    const cols = asList(t.columns)
      .map((c) => asRecord(c).id)
      .filter((id): id is string => typeof id === 'string');
    if (cols.length === 0) continue;
    const key = JSON.stringify(cols);
    groups.set(key, [...(groups.get(key) ?? []), t.id]);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length >= 3).map(([, ids]) => ids);
}

/**
 * The Template tab's Checks (handoff §10): outputs no step fills (or several fill), validation
 * issues, or that all is valid; then stale stages. Every item links to where it is fixed.
 */
export function templateChecks(input: {
  projectId: string;
  definition: Record<string, unknown>;
  /** Live issues of the definition being edited. */
  issues: readonly string[];
  /** The saved version's issues (they add the model checks); empty while edits are pending. */
  serverIssues: readonly string[];
  /** The saved version's warnings (unmapped outputs): shown, never blocking. */
  serverWarnings?: readonly string[];
  stages: readonly OverviewItem[] | null;
}): TemplateCheck[] {
  const tab = (t: string) => `#/workbench/${input.projectId}/${t}`;
  const coverage = outputCoverage(input.definition);
  const checks: TemplateCheck[] = [
    ...coverage.uncovered.map((id): TemplateCheck => ({
      tone: 'warn',
      text: `${id} is not filled by any step.`,
      link: { label: 'Add it to a step in Pipeline', hash: tab('steps') },
      subTabs: ['outputs', 'pipeline'],
    })),
    ...coverage.multiple.map((id): TemplateCheck => ({
      tone: 'warn',
      text: `${id} is filled by more than one step.`,
      link: { label: 'Review in Pipeline', hash: tab('steps') },
      subTabs: ['pipeline'],
    })),
  ];
  for (const g of sharedRepeatSteps(input.definition)) {
    checks.push({
      tone: 'warn',
      text: `${g.steps.length} steps read the repeating section ${g.section}: each runs once per occurrence, so a step meant for one block reads them all. Give each kind of block its own repeating section.`,
      link: { label: 'Open Sections', subTab: 'sections' },
      subTabs: ['sections', 'pipeline'],
    });
  }
  const tableShapes = new Map(
    asList(asRecord(input.definition.outputs).tables).map((t) => [asRecord(t).id, asRecord(t)]),
  );
  for (const ids of sameShapeTables(input.definition)) {
    const first = asList(tableShapes.get(ids[0])?.columns).map((c) => asRecord(c).id)[0];
    checks.push({
      tone: 'warn',
      text: `${ids.length} tables have the same columns (${first}, \u2026): one table with columns telling them apart (study, batch) is usually better.`,
      link: { label: 'Open Outputs', subTab: 'outputs' },
      subTabs: ['outputs'],
    });
  }
  const issues = [...new Set([...input.issues, ...input.serverIssues])].filter(
    (i) => !COVERAGE.test(i),
  );
  for (const issue of issues) {
    const sub = issueSubTab(issue);
    checks.push({
      tone: 'danger',
      text: issue,
      link: { label: `Open ${SUB_TAB_LABEL[sub]}`, subTab: sub },
      subTabs: [sub],
    });
  }
  for (const warning of input.serverWarnings ?? []) {
    const sub = issueSubTab(warning);
    checks.push({
      tone: 'warn',
      text: warning,
      link: { label: `Open ${SUB_TAB_LABEL[sub]}`, subTab: sub },
      subTabs: [sub],
    });
  }
  if (checks.length === 0) {
    checks.push({
      tone: 'ok',
      text: 'Sections, outputs and steps are valid.',
      link: null,
      subTabs: [],
    });
  }
  for (const item of input.stages ?? []) {
    if (item.state !== 'stale') continue;
    const target = item.stage === 'publish' ? 'evaluate' : item.stage;
    checks.push({
      tone: 'alert',
      text: `${OVERVIEW_TAB_LABEL[item.stage]}: ${item.status}`,
      link: { label: `Review in ${OVERVIEW_TAB_LABEL[target]}`, hash: tab(target) },
      subTabs: [],
    });
  }
  return checks;
}

/** The sub-tabs to mark with a warn dot. */
export function attentionTabs(checks: readonly TemplateCheck[]): Set<SubTab> {
  return new Set(checks.flatMap((c) => c.subTabs));
}
