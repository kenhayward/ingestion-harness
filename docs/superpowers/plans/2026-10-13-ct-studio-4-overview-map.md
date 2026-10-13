# Workbench Overview map (PR 4 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview tab's stage list with the process map of the handoff — phase panels, twelve boxes with status and two figures each, flow and side connectors, the Next banner — and, below 760 px, a stacked list of the same boxes; the overview API gains the per-box figures (W2 `metrics`).

**Architecture:** The API gathers plain numbers per project (`MetricFacts`) in `projectOverview`; a pure shared function `boxMetrics(facts)` turns them into exactly two `{ label, value, at }` rows per tab (an `at` timestamp is formatted as relative time by the web). `overviewItems` attaches them. The web adds `OverviewMap` (fixed 1020×640 canvas inside a horizontal scroll box, absolutely positioned panels and boxes over one connector SVG) and `OverviewStack` (the narrow-screen list), both fed by `ProjectOverview`, and `OverviewTab` shows the banner, the map/stack and the caption.

**Tech Stack:** TypeScript, Zod, Fastify/MemoryRepo tests, React 19, Vitest + Testing Library, CSS on `--ih-*` tokens.

**Spec:** `docs/design/workbench-redesign/WORKBENCH-HANDOFF.md` §3 (map geometry, boxes, connectors, metrics table, caption, mobile) and W2 (`metrics: exactly 2`). Screenshot: `docs/design/workbench-redesign/screenshots/{light,dark}/11-workbench-overview-map.png`.

## Global Constraints

- Map: fixed 1020×640 canvas centred in a scroll box (`overflow-x: auto`), backdrop `--ih-page-well` with a 20 px dot grid `radial-gradient(var(--ih-border-strong) 1px, transparent 1.2px)`.
- Phase panels (radius 14, `--ih-band` fill, `--ih-band-bd` border), label + range top-right: Prepare *stages 1–2* (x 8, y 8, 484×172) · Edit and test by hand *any time* (x 528, y 8, 484×172) · Draft with the model *stages 3–6* (x 8, y 208, 1004×172) · Verify and publish *stages 7–10* (x 8, y 408, 1004×172).
- Boxes 200×124, columns x = 20 + 260·c, rows y = 44 / 244 / 444. Row 0: 01 Samples, 02 Brief, Template, Test runs · Row 1: 03 Survey, 04 Outputs, 05 Sections, 06 Steps · Row 2: 07 References, 08 Evaluate, 09 Revise, 10 Publish vN.
- Each box is an `<a>` with `aria-label="<Title>: <status>. Open the <Tab> tab"`; header = 28 px icon tile (surface fill, status-tone icon and inset border) + title + status icon; status line = mono stage number + status text in tone; two key/value rows at the bottom. Fill by state via `stageStyle(state).fill`; border 1.5 px in the status tone (1 px `--ih-border` for accepted); pending dashed; shadow `0 1px 2px rgba(15,27,45,.08), 0 6px 16px rgba(15,27,45,.10)`; the Next box adds a 4 px `--ih-alert-bg` ring. Publish opens Evaluate.
- Connectors: one inline SVG under the boxes (`aria-hidden`); main flow 3 px `--ih-flow`, filled arrowheads (markerWidth 4.5); side routes 2.5 px dashed `7 5` `--ih-side`. Paths: Samples→Brief, Template→Test runs, Survey→Outputs→Sections→Steps, References→Evaluate→Revise as horizontal arrows; Brief→Survey `M380 168V206H190V242`; Steps→References `M900 368V404H190V442`; Evaluate→Publish `M380 568V606H900V570` (label "publish when the gate passes", flow colour); Template→Sections dashed `M640 168V242` ("hand edits change the draft"); Revise→Sections dashed `M640 444V370` ("revision changes the draft"). Edge labels 11 px italic 600 in the line colour on a `--ih-page-well` chip.
- Metrics (two per box, exactly as the handoff table): Samples: Dev · holdout | OCR pages · Brief: Answers | Updated · Template: Steps · sections | Hand edit · Test runs: Runs | Awaiting review · Survey: Questions | Fields · tables · Outputs: Fields · tables | Changes applied · Sections: Sections | Anchors found · Steps: Proposed changes | Model · References: Dev | Holdout · Evaluate: Dev score | Holdout score · Revise: Feedback items | Last revision · Publish: Needs holdout | Live version.
- Caption under the map: "Each panel groups the stages of one phase (its label sits top-right). Click any box to open its tab. Blue arrows are the order the stages run in; teal dashed arrows change the draft from outside the main flow. In the Draft phase the model proposes changes and you accept, edit or skip them."
- Below 760 px: the map is replaced by a vertical list of the same boxes in stage order (no connectors), grouped under the phase headings; nothing scrolls the page sideways at 390 px.
- Tests first; `npm run check` green; the route stays documented (schema change regenerates `docs/openapi.json`); commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never stage `config/llm-providers.yaml`.

## Review Focus

1. **Nothing to count yet** (new project: no draft proposal, no survey, no evaluation) — every figure reads "—" or 0, never `NaN`, `null` or "undefined" (Task 1 and 2 tests).
2. **Published type with no open draft** — Template figures come from the live version; Publish shows "Live version v3"; no crash on a missing draft (Task 2 test).
3. **A corrupt or missing drafting body in the store** (survey/outputs/sections/steps) — the figure is "—", the overview still answers 200 (Task 2 test).
4. **Keyboard and screen-reader use of the map** — every box is a focusable link with the full sentence as its name; the connector SVG is hidden (Task 3 test).
5. **Narrow screens** — the stack (not the map) is what assistive tech reads below 760 px; both are never announced together (CSS `display: none` on the hidden one; Task 3 test on structure).

---

### Task 1: Shared metrics: schema, `MetricFacts`, `boxMetrics`

**Files:**
- Modify: `packages/shared/src/overview.ts`
- Test: `packages/shared/test/overview.test.ts` (append; update `ctx()` to pass facts)

**Interfaces:**
- Produces:
  - `OverviewMetricSchema = z.object({ label: z.string(), value: z.string(), at: z.string().nullable() })`; `type OverviewMetric`. `at`: an ISO time the web shows as relative time (then `value` is the fallback text, e.g. "—").
  - `OverviewItemSchema` gains `metrics: z.array(OverviewMetricSchema).max(2)`.
  - `interface MetricFacts` (below) and `EMPTY_FACTS: MetricFacts`.
  - `boxMetrics(facts: MetricFacts, inputs: OverviewInputs): Record<OverviewTab, OverviewMetric[]>` — two rows per tab.
  - `StatusContext` gains `facts: MetricFacts`; `overviewItems` sets `metrics` from `boxMetrics`.
  - Copy change: Samples status "Preparing N of M" becomes "N of M preparing".

```ts
/** Plain numbers the API gathers for the map's figures (null = not known yet). */
export interface MetricFacts {
  samples: { dev: number; holdout: number; ocrPages: number; pages: number };
  brief: { answers: number; updatedAt: string | null };
  template: { steps: number; sections: number; editedAt: string | null };
  runs: { total: number; awaitingReview: number };
  survey: { answered: number; questions: number; fields: number | null; tables: number | null };
  outputs: { fields: number; tables: number; applied: number | null; proposed: number | null };
  sections: { anchorsFound: number | null; devSamples: number };
  steps: { proposed: number | null; model: string | null };
  references: { devVerified: number; devTotal: number; holdoutVerified: number; holdoutTotal: number };
  evaluate: { dev: number | null; holdout: number | null };
  revise: { open: number; lastAt: string | null };
  publish: { live: number | null };
}
```

- [ ] **Step 1: Write the failing tests** — append to `packages/shared/test/overview.test.ts`; import `EMPTY_FACTS, boxMetrics, type MetricFacts`; change the file's `ctx()` helper to include `facts: EMPTY_FACTS` in its defaults; update the one samples row that expects `'Preparing 1 of 4'` to `'1 of 4 preparing'` (copy change by design).

```ts
const facts = (over: Partial<MetricFacts> = {}): MetricFacts => ({ ...EMPTY_FACTS, ...over });
const rows = (f: MetricFacts, tab: (typeof OVERVIEW_TABS)[number], i: OverviewInputs = inputs()) =>
  boxMetrics(f, i)[tab].map((m) => [m.label, m.value, m.at]);

describe('boxMetrics', () => {
  it('gives every tab exactly two rows', () => {
    const all = boxMetrics(EMPTY_FACTS, inputs());
    expect(Object.keys(all).sort()).toEqual([...OVERVIEW_TABS].sort());
    for (const tab of OVERVIEW_TABS) expect(all[tab]).toHaveLength(2);
  });

  it('shows dashes, never null or NaN, when nothing is known', () => {
    const text = JSON.stringify(boxMetrics(EMPTY_FACTS, inputs()));
    expect(text).not.toMatch(/null"|NaN|undefined/);
  });

  it.each([
    ['samples', facts({ samples: { dev: 6, holdout: 2, ocrPages: 3, pages: 41 } }), [['Dev · holdout', '6 · 2', null], ['OCR pages', '3 of 41', null]]],
    ['brief', facts({ brief: { answers: 5, updatedAt: '2026-10-11T10:00:00Z' } }), [['Answers', '5', null], ['Updated', '—', '2026-10-11T10:00:00Z']]],
    ['template', facts({ template: { steps: 4, sections: 5, editedAt: '2026-10-13T09:00:00Z' } }), [['Steps · sections', '4 · 5', null], ['Hand edit', '—', '2026-10-13T09:00:00Z']]],
    ['runs', facts({ runs: { total: 6, awaitingReview: 1 } }), [['Runs', '6', null], ['Awaiting review', '1', null]]],
    ['survey', facts({ survey: { answered: 3, questions: 4, fields: 9, tables: 1 } }), [['Questions', '3 of 4 answered', null], ['Fields · tables', '9 · 1', null]]],
    ['survey', EMPTY_FACTS, [['Questions', '—', null], ['Fields · tables', '—', null]]],
    ['outputs', facts({ outputs: { fields: 9, tables: 1, applied: 8, proposed: 9 } }), [['Fields · tables', '9 · 1', null], ['Changes applied', '8 of 9', null]]],
    ['sections', facts({ sections: { anchorsFound: 6, devSamples: 6 }, template: { steps: 4, sections: 5, editedAt: null } }), [['Sections', '5', null], ['Anchors found', '6 / 6 dev', null]]],
    ['steps', facts({ steps: { proposed: 4, model: 'qwen3.8-27b' } }), [['Proposed changes', '4', null], ['Model', 'qwen3.8-27b', null]]],
    ['references', facts({ references: { devVerified: 6, devTotal: 6, holdoutVerified: 2, holdoutTotal: 2 } }), [['Dev', '6 / 6', null], ['Holdout', '2 / 2', null]]],
    ['evaluate', facts({ evaluate: { dev: 0.91, holdout: 0.88 } }), [['Dev score', '91%', null], ['Holdout score', '88%', null]]],
    ['revise', facts({ revise: { open: 3, lastAt: '2026-10-13T10:00:00Z' } }), [['Feedback items', '3', null], ['Last revision', '—', '2026-10-13T10:00:00Z']]],
    ['publish', facts({ publish: { live: 3 } }), [['Needs holdout', '≥ 90%', null], ['Live version', 'v3', null]]],
    ['publish', EMPTY_FACTS, [['Needs holdout', '≥ 90%', null], ['Live version', '—', null]]],
  ] as const)('%s', (tab, f, expected) => {
    expect(rows(f, tab)).toEqual(expected);
  });

  it('puts the metrics on the overview items', () => {
    const items = overviewItems(ctx({ facts: facts({ runs: { total: 6, awaitingReview: 1 } }) }));
    expect(items.find((x) => x.stage === 'runs')!.metrics).toEqual([
      { label: 'Runs', value: '6', at: null },
      { label: 'Awaiting review', value: '1', at: null },
    ]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/overview.test.ts` → FAIL (`boxMetrics` not exported).

- [ ] **Step 3: Implement** in `packages/shared/src/overview.ts`:

```ts
export const OverviewMetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  /** An ISO time the web shows as relative time; `value` is then the fallback text. */
  at: z.string().nullable(),
});
export type OverviewMetric = z.infer<typeof OverviewMetricSchema>;
```

Add `metrics: z.array(OverviewMetricSchema).max(2),` to `OverviewItemSchema` (with a comment: "Two figures for the Overview map box (handoff §3)"). Add the `MetricFacts` interface above and:

```ts
export const EMPTY_FACTS: MetricFacts = {
  samples: { dev: 0, holdout: 0, ocrPages: 0, pages: 0 },
  brief: { answers: 0, updatedAt: null },
  template: { steps: 0, sections: 0, editedAt: null },
  runs: { total: 0, awaitingReview: 0 },
  survey: { answered: 0, questions: 0, fields: null, tables: null },
  outputs: { fields: 0, tables: 0, applied: null, proposed: null },
  sections: { anchorsFound: null, devSamples: 0 },
  steps: { proposed: null, model: null },
  references: { devVerified: 0, devTotal: 0, holdoutVerified: 0, holdoutTotal: 0 },
  evaluate: { dev: null, holdout: null },
  revise: { open: 0, lastAt: null },
  publish: { live: null },
};

const DASH = '—';
const m = (label: string, value: string, at: string | null = null): OverviewMetric => ({ label, value, at });
const n = (x: number | null) => (x === null ? DASH : String(x));
const pair = (a: number | null, b: number | null) => (a === null || b === null ? DASH : `${a} · ${b}`);
const score = (x: number | null) => (x === null ? DASH : percent(x));

/** The two figures of each Overview map box (handoff §3 metrics table). */
export function boxMetrics(f: MetricFacts, inputs: OverviewInputs): Record<OverviewTab, OverviewMetric[]> {
  const { survey, outputs } = f;
  return {
    samples: [
      m('Dev · holdout', `${f.samples.dev} · ${f.samples.holdout}`),
      m('OCR pages', f.samples.pages > 0 ? `${f.samples.ocrPages} of ${f.samples.pages}` : DASH),
    ],
    brief: [m('Answers', String(f.brief.answers)), m('Updated', DASH, f.brief.updatedAt)],
    template: [m('Steps · sections', `${f.template.steps} · ${f.template.sections}`), m('Hand edit', DASH, f.template.editedAt)],
    runs: [m('Runs', String(f.runs.total)), m('Awaiting review', String(f.runs.awaitingReview))],
    survey: [
      m('Questions', survey.questions > 0 ? `${survey.answered} of ${survey.questions} answered` : DASH),
      m('Fields · tables', pair(survey.fields, survey.tables)),
    ],
    outputs: [
      m('Fields · tables', `${outputs.fields} · ${outputs.tables}`),
      m('Changes applied', outputs.applied === null || outputs.proposed === null ? DASH : `${outputs.applied} of ${outputs.proposed}`),
    ],
    sections: [
      m('Sections', String(f.template.sections)),
      m('Anchors found', f.sections.anchorsFound === null ? DASH : `${f.sections.anchorsFound} / ${f.sections.devSamples} dev`),
    ],
    steps: [m('Proposed changes', n(f.steps.proposed)), m('Model', f.steps.model ?? DASH)],
    references: [
      m('Dev', `${f.references.devVerified} / ${f.references.devTotal}`),
      m('Holdout', `${f.references.holdoutVerified} / ${f.references.holdoutTotal}`),
    ],
    evaluate: [m('Dev score', score(f.evaluate.dev)), m('Holdout score', score(f.evaluate.holdout))],
    revise: [m('Feedback items', String(f.revise.open)), m('Last revision', DASH, f.revise.lastAt)],
    publish: [
      m('Needs holdout', `≥ ${percent(inputs.gate.threshold)}`),
      m('Live version', f.publish.live === null ? DASH : `v${f.publish.live}`),
    ],
  };
}
```

(`percent` is the one imported from `./evaluation.js`; `percent(0.9)` gives `'90%'`.) In `StatusContext` add `facts: MetricFacts;`; in `overviewItems` compute `const metrics = boxMetrics(ctx.facts, ctx.inputs);` and add `metrics: metrics[stage]` to every item (the 10 stages, template and runs). Change the samples status text to `` `${preparing} of ${total} preparing` ``.

- [ ] **Step 4: Run** the shared tests → PASS; `npm run typecheck` (the API's `projectOverview` now fails to compile without `facts` — pass `facts: EMPTY_FACTS` there for now with a `// Task 2 gathers the real facts` comment, and add `metrics` to the web fixture `projectOverview()` items as `[]` so typecheck passes; update the API overview test's exact-object expectations for items to include `metrics` via `expect.objectContaining` **only where the item is compared whole**, and the `'Preparing 1 of 1'` texts to `'1 of 1 preparing'`). `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/overview.ts packages/shared/test/overview.test.ts apps/api/src/routes/workbench-overview.ts apps/api/test/workbench-overview.test.ts apps/web/test/fake-api.ts
git commit -m "Workbench overview: two figures per map box (W2 metrics)"
```

---

### Task 2: Gather the facts in the overview API

**Files:**
- Modify: `apps/api/src/routes/workbench-overview.ts`
- Modify: `apps/api/src/routes/workbench.ts` only to export existing helpers you need (e.g. `acceptedSurvey`, `referenceRows`, `readJsonSafe`, `parseBody`) — no behaviour changes
- Regenerate: `docs/openapi.json` (`npm run openapi`)
- Test: `apps/api/test/workbench-overview.test.ts`

**Interfaces:**
- Consumes: Task 1 `MetricFacts`, `EMPTY_FACTS`.
- Produces: `projectOverview` returns real `metrics` for every item.

**How each fact is computed** (use the data the route already loads where possible; one store read per drafting body at most; a missing or unparsable body leaves that fact at its `EMPTY_FACTS` value — never throw):

| Fact | Source |
| --- | --- |
| `samples.dev/holdout` | sample records by `role` |
| `samples.ocrPages/pages` | the ready samples' triage (`sampleViews` → `view.triage`: `ocrPages.length`, `pageCount`), summed. Switch the overview's sample source from `sampleStates` back to one `sampleViews` call (it also gives the states) — one call per overview. |
| `brief.answers` | `view.brief.body.answers` with a non-blank `answer` |
| `brief.updatedAt` | `view.brief.createdAt` (a brief version's time) or null |
| `template.steps/sections` | the open draft's definition (else the latest published): `steps` array length, `document.sections` length (0 when absent) — read via `templates.get(id, draft ?? published)` |
| `template.editedAt` | that template record's last-updated timestamp field (see `TemplateRecordSchema` in `apps/api/src/templates/repo.ts`; use `updatedAt` if present, else `createdAt`) |
| `runs.total/awaitingReview` | the same `runs` counts already computed |
| `survey.answered/questions` | `view.brief.body.answers`: answered = non-blank answers, questions = all answers |
| `survey.fields/tables` | the accepted survey body (`acceptedSurvey(app, id)`): `candidates` by `kind`; null when none |
| `outputs.fields/tables` | the draft definition's outputs: count of fields and of tables (see `packages/shared/src/template.ts` for where outputs live) |
| `outputs.applied/proposed` | the newest decided `outputs` proposal: `acceptedChanges.length` (all changes when decision is `accepted` and `acceptedChanges` is null) of its body's `changes.length` (body via `readJsonSafe(app, draftingKey(id, p.id))` + `parseBody`) |
| `sections.anchorsFound` | the newest `sections` proposal body's `anchorCheck.samples` without `error` and with no `missingRequired` (null when no body/anchorCheck) |
| `sections.devSamples` | ready dev samples |
| `steps.proposed` | the newest `steps` proposal body's `changes.length` (null when none) |
| `steps.model` | that proposal's model: the draft job's resolved model (`ProposalView.model` is derived the same way in `proposalView`) — strip the provider prefix (`local/qwen3.8-27b-mtp` → `qwen3.8-27b-mtp`) |
| `references.*` | `referenceRows(app, id, 'dev')` and `('holdout')`: verified = rows with a non-null, non-outdated reference (`reference !== null && reference.outdated.length === 0`), total = rows |
| `evaluate.dev` | the newest complete dev iteration of the open draft with `model === null`: its cached `scores` summary score if present (`IterationRecord.scores`), else null — do not run `iterationView` for this |
| `evaluate.holdout` | `gate.score` |
| `revise.open` | open feedback count (already computed) |
| `revise.lastAt` | the newest revise proposal's `createdAt` (any time), or null |
| `publish.live` | `view.published` |

- [ ] **Step 1: Write the failing tests** in `apps/api/test/workbench-overview.test.ts`:

```ts
  it('gives dashes and zeros for a new project', async () => {
    const p = await project();
    const o = await p.overview();
    const metrics = Object.fromEntries(o.stages.map((s) => [s.stage, s.metrics]));
    expect(metrics.samples).toEqual([
      { label: 'Dev · holdout', value: '0 · 0', at: null },
      { label: 'OCR pages', value: '—', at: null },
    ]);
    expect(metrics.survey).toEqual([
      { label: 'Questions', value: '—', at: null },
      { label: 'Fields · tables', value: '—', at: null },
    ]);
    expect(metrics.publish).toEqual([
      { label: 'Needs holdout', value: '≥ 90%', at: null },
      { label: 'Live version', value: '—', at: null },
    ]);
    for (const s of o.stages) expect(s.metrics).toHaveLength(2);
  });

  it('counts samples, OCR pages and the brief', async () => {
    const p = await project();
    await p.addSample(1, true); // triage: pageCount 1, ocrPages []
    await p.app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: { purpose: 'Letters', answers: [{ question: 'Who signs?', answer: 'The clerk' }, { question: 'Dates?', answer: '' }] },
    });
    const o = await p.overview();
    const of = (stage: string) => o.stages.find((s) => s.stage === stage)!.metrics;
    expect(of('samples')).toEqual([
      { label: 'Dev · holdout', value: '1 · 0', at: null },
      { label: 'OCR pages', value: '0 of 1', at: null },
    ]);
    expect(of('brief')[0]).toEqual({ label: 'Answers', value: '1', at: null });
    expect(of('brief')[1]!.at).toEqual(expect.any(String));
    expect(of('survey')[0]).toEqual({ label: 'Questions', value: '1 of 2 answered', at: null });
  });

  it('reads the template figures from the open draft', async () => {
    const p = await project();
    const o = await p.overview();
    const template = o.stages.find((s) => s.stage === 'template')!.metrics;
    expect(template[0]!.label).toBe('Steps · sections');
    expect(template[0]!.value).toMatch(/^\d+ · \d+$/);
  });

  it('survives a corrupt drafting body', async () => {
    const p = await project();
    // Seed an accepted outputs proposal whose body in the store is not JSON (copy the seeding
    // helper from workbench-revise.test.ts / workbench-drafting.test.ts), then:
    // await p.store.put('runs', draftingKey('letter', proposal.id), Buffer.from('{not json'), 'application/json');
    const res = await p.app.inject('/api/workbench/projects/letter/overview');
    expect(res.statusCode).toBe(200);
    const outputs = res.json<ProjectOverview>().stages.find((s) => s.stage === 'outputs')!.metrics;
    expect(outputs[1]).toEqual({ label: 'Changes applied', value: '—', at: null });
  });
```

Make the corrupt-body test concrete (seed a real decided outputs proposal + its draft job, then overwrite its body with invalid JSON), and add one positive drafting test: a ready `steps` proposal whose stored body has 4 changes and whose draft job model is `local/qwen3.8-27b-mtp` → Steps metrics `[['Proposed changes','4'],['Model','qwen3.8-27b-mtp']]` (seed the body in the shape `DraftResultSchema` expects — copy from `apps/api/test/workbench-drafting.test.ts`). Fix the `'1 of 2 answered'` brief payload to the brief route's real body shape if it differs.

- [ ] **Step 2: Run** `npx vitest run --project api apps/api/test/workbench-overview.test.ts` → FAIL (metrics are the Task 1 placeholders).

- [ ] **Step 3: Implement** `gatherFacts(app, ctx): Promise<MetricFacts>` in `workbench-overview.ts` per the table, called from `projectOverview` with what it already loaded (pass `samples`, `proposals`, `draftJobs`, `iterations`, `gate`, `view`, `runs`, `feedback` in); read drafting bodies with `Promise.all` and guard each read (`try/catch` → empty). Update the triage-read spy test from Task 2 of PR 3: the overview now reads each ready sample's triage once more (sampleViews) — assert the new exact count and explain it in the test comment (PR 6 reduces it). Run `npm run openapi`.

- [ ] **Step 4: Run** `npx vitest run --project api` → PASS; `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench-overview.ts apps/api/src/routes/workbench.ts apps/api/test/workbench-overview.test.ts docs/openapi.json
git commit -m "Workbench API: the overview counts what each map box shows"
```

---

### Task 3: `OverviewMap`, `OverviewStack`, `OverviewTab`

**Files:**
- Create: `apps/web/src/workbench/OverviewMap.tsx` (exports `OverviewMap`, `OverviewStack`, `MAP_BOXES`)
- Modify: `apps/web/src/workbench/OverviewTab.tsx` (banner + map + stack + caption; drop the plain list)
- Modify: `apps/web/src/styles/stages.css`
- Modify: `apps/web/test/fake-api.ts` (fixture items get two plausible metrics each)
- Test: `apps/web/test/OverviewMap.test.tsx` (create), `apps/web/test/OverviewTab.test.tsx` (update)

**Interfaces:**
- Consumes: `ProjectOverview`, `OverviewItem`, `OVERVIEW_TAB_LABEL`, `OverviewTab` type (`@ih/shared`); `stageStyle`, `TONE_COLOR`, `StageStatusIcon` (`ui/`); `TAB_ICON` (`workbench/ProjectRail.tsx`); `Icon`; `relativeTime(iso, now)` (`apps/web/src/jobs/derive.ts`).
- Produces: `OverviewMap({ projectId, overview, now })`, `OverviewStack({ projectId, overview, now })`, `MAP_BOXES: { tab: OverviewTab; number: string | null; col: 0|1|2|3; row: 0|1|2 }[]`.

Box details:
- Title: `OVERVIEW_TAB_LABEL[tab]`, except Publish → `Publish v${draft}` when there is an open draft.
- Number: `01`…`10` for the ten stages (OVERVIEW_STAGES order), none for Template and Test runs.
- Link target: the tab (Publish → `evaluate`). `aria-label` = `` `${title}: ${status}. Open the ${tabLabel} tab` `` where tabLabel is the target tab's label.
- Metric value: when `at` is set, `relativeTime(at, now)`; else `value`.
- `is-next` class when `overview.next?.stage === tab`.
- Inline style `background: stageStyle(state).fill`, `border-color: TONE_COLOR[tone]` (accepted: `var(--ih-border)`), `data-state`.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/OverviewMap.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAP_BOXES, OverviewMap, OverviewStack } from '../src/workbench/OverviewMap.js';
import { projectOverview, projectView } from './fake-api.js';

const now = Date.parse('2026-10-13T12:00:00Z');
const overview = projectOverview({
  project: projectView({ draft: 4, published: 3 }),
  next: { stage: 'sections', title: 'Next: refresh Sections', reason: 'x' },
  stages: projectOverview().stages.map((s) =>
    s.stage === 'sections'
      ? { ...s, state: 'stale' as const, status: 'Stale — Outputs changed after it was accepted', metrics: [{ label: 'Sections', value: '5', at: null }, { label: 'Anchors found', value: '6 / 6 dev', at: null }] }
      : s.stage === 'brief'
        ? { ...s, state: 'accepted' as const, status: 'Saved v3', metrics: [{ label: 'Answers', value: '5', at: null }, { label: 'Updated', value: '—', at: '2026-10-11T12:00:00Z' }] }
        : s,
  ),
});

describe('OverviewMap', () => {
  it('lays out twelve boxes on the handoff grid', () => {
    expect(MAP_BOXES.map((b) => [b.tab, b.col, b.row])).toEqual([
      ['samples', 0, 0], ['brief', 1, 0], ['template', 2, 0], ['runs', 3, 0],
      ['survey', 0, 1], ['outputs', 1, 1], ['sections', 2, 1], ['steps', 3, 1],
      ['references', 0, 2], ['evaluate', 1, 2], ['revise', 2, 2], ['publish', 3, 2],
    ]);
  });

  it('makes every box a link that says its status and where it goes', () => {
    render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    const map = screen.getByRole('region', { name: 'Process map' });
    expect(within(map).getAllByRole('link')).toHaveLength(12);
    const sections = within(map).getByRole('link', { name: 'Sections: Stale — Outputs changed after it was accepted. Open the Sections tab' });
    expect(sections).toHaveAttribute('href', '#/workbench/letter/sections');
    expect(sections).toHaveClass('is-next');
    expect(sections).toHaveTextContent('05');
    expect(sections).toHaveTextContent('Anchors found');
    expect(sections).toHaveTextContent('6 / 6 dev');
    const publish = within(map).getByRole('link', { name: /^Publish v4: / });
    expect(publish).toHaveAttribute('href', '#/workbench/letter/evaluate');
    expect(publish.getAttribute('aria-label')).toMatch(/Open the Evaluate tab$/);
  });

  it('shows times as relative time', () => {
    render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    expect(screen.getByRole('link', { name: /^Brief: / })).toHaveTextContent('2 days ago');
  });

  it('groups the boxes in four labelled phase panels and hides the connectors', () => {
    const { container } = render(<OverviewMap projectId="letter" overview={overview} now={now} />);
    for (const name of ['Prepare', 'Edit and test by hand', 'Draft with the model', 'Verify and publish']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(container.querySelector('svg.map-connectors')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('publish when the gate passes')).toBeInTheDocument();
    expect(screen.getByText('hand edits change the draft')).toBeInTheDocument();
    expect(screen.getByText('revision changes the draft')).toBeInTheDocument();
  });
});

describe('OverviewStack', () => {
  it('lists the same twelve boxes in stage order under phase headings', () => {
    render(<OverviewStack projectId="letter" overview={overview} now={now} />);
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Prepare',
      'Draft with the model',
      'Verify and publish',
      'Edit and test by hand',
    ]);
    const names = screen.getAllByRole('link').map((a) => a.getAttribute('aria-label')!.split(':')[0]);
    expect(names).toEqual(['Samples', 'Brief', 'Survey', 'Outputs', 'Sections', 'Steps', 'References', 'Evaluate', 'Revise', 'Publish v4', 'Template', 'Test runs']);
  });
});
```

Relative-time text depends on the existing `relativeTime` in `apps/web/src/jobs/derive.ts` — check what it returns for 48 h and adjust the expected string to it (not the other way round).

Update `apps/web/test/OverviewTab.test.tsx`: the list test becomes "shows the map, the narrow-screen stack and the caption" — region "Process map" present, the stack present (`getByRole('list', { name: 'Stages' })` → switch the stack's container to a labelled `<div aria-label="Stages">` with `role="group"` if you prefer; keep one stable query), and the caption text present. Keep the banner tests.

- [ ] **Step 2: Run** `npx vitest run apps/web/test/OverviewMap.test.tsx apps/web/test/OverviewTab.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`OverviewMap.tsx`:

```tsx
import {
  OVERVIEW_STAGES,
  OVERVIEW_TAB_LABEL,
  type OverviewItem,
  type OverviewTab,
  type ProjectOverview,
} from '@ih/shared';
import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';
import { PhasePanel } from '../ui/PhasePanel.js';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR } from '../ui/stageStyle.js';
import { TAB_ICON } from './ProjectRail.js';

export const MAP_BOXES: { tab: OverviewTab; number: string | null; col: 0 | 1 | 2 | 3; row: 0 | 1 | 2 }[] = [
  { tab: 'samples', col: 0, row: 0 },
  { tab: 'brief', col: 1, row: 0 },
  { tab: 'template', col: 2, row: 0 },
  { tab: 'runs', col: 3, row: 0 },
  { tab: 'survey', col: 0, row: 1 },
  { tab: 'outputs', col: 1, row: 1 },
  { tab: 'sections', col: 2, row: 1 },
  { tab: 'steps', col: 3, row: 1 },
  { tab: 'references', col: 0, row: 2 },
  { tab: 'evaluate', col: 1, row: 2 },
  { tab: 'revise', col: 2, row: 2 },
  { tab: 'publish', col: 3, row: 2 },
].map((b) => {
  const i = (OVERVIEW_STAGES as readonly string[]).indexOf(b.tab);
  return { ...b, number: i >= 0 ? String(i + 1).padStart(2, '0') : null } as {
    tab: OverviewTab;
    number: string | null;
    col: 0 | 1 | 2 | 3;
    row: 0 | 1 | 2;
  };
});

const PANELS = [
  { title: 'Prepare', range: 'stages 1–2', x: 8, y: 8, w: 484 },
  { title: 'Edit and test by hand', range: 'any time', x: 528, y: 8, w: 484 },
  { title: 'Draft with the model', range: 'stages 3–6', x: 8, y: 208, w: 1004 },
  { title: 'Verify and publish', range: 'stages 7–10', x: 8, y: 408, w: 1004 },
];

const FLOW = [
  'M220 106H278', // Samples → Brief
  'M740 106H798', // Template → Test runs
  'M220 306H278', // Survey → Outputs
  'M480 306H538', // Outputs → Sections
  'M740 306H798', // Sections → Steps
  'M220 506H278', // References → Evaluate
  'M480 506H538', // Evaluate → Revise
  'M380 168V206H190V242', // Brief → Survey
  'M900 368V404H190V442', // Steps → References
  'M380 568V606H900V570', // Evaluate → Publish
];
const SIDE = ['M640 168V242', 'M640 444V370']; // Template → Sections, Revise → Sections

const target = (tab: OverviewTab) => (tab === 'publish' ? 'evaluate' : tab);

function title(tab: OverviewTab, overview: ProjectOverview) {
  return tab === 'publish' && overview.project.draft !== null
    ? `Publish v${overview.project.draft}`
    : OVERVIEW_TAB_LABEL[tab];
}

function Box({ item, number, projectId, overview, now, style }: {
  item: OverviewItem;
  number: string | null;
  projectId: string;
  overview: ProjectOverview;
  now: number;
  style?: React.CSSProperties;
}) {
  const s = stageStyle(item.state);
  const tone = TONE_COLOR[s.tone];
  const name = title(item.stage, overview);
  const next = overview.next?.stage === item.stage;
  return (
    <a
      className={next ? 'map-box is-next' : 'map-box'}
      data-state={item.state}
      href={`#/workbench/${projectId}/${target(item.stage)}`}
      aria-label={`${name}: ${item.status}. Open the ${OVERVIEW_TAB_LABEL[target(item.stage)]} tab`}
      style={{ ...style, background: s.fill, borderColor: item.state === 'accepted' ? 'var(--ih-border)' : tone }}
    >
      <span className="map-box-head">
        <span className="map-box-tile" style={{ color: tone, boxShadow: `inset 0 0 0 1px ${tone}` }}>
          <Icon name={TAB_ICON[item.stage]} size={16} />
        </span>
        <span className="map-box-title">{name}</span>
        <StageStatusIcon state={item.state} decorative />
      </span>
      <span className="map-box-status" style={{ color: tone }}>
        {number && <span className="map-box-number">{number}</span>}
        {item.status}
      </span>
      <span className="map-box-metrics">
        {item.metrics.map((metric) => (
          <span key={metric.label} className="map-box-metric">
            <span>{metric.label}</span>
            <span>{metric.at ? relativeTime(metric.at, now) : metric.value}</span>
          </span>
        ))}
      </span>
    </a>
  );
}

/** The Overview process map (handoff §3): a fixed 1020×640 canvas in a scroll box. */
export function OverviewMap({ projectId, overview, now }: { projectId: string; overview: ProjectOverview; now: number }) {
  const item = (tab: OverviewTab) => overview.stages.find((s) => s.stage === tab)!;
  return (
    <section className="map-scroll" aria-label="Process map">
      <div className="map-canvas">
        {PANELS.map((p) => (
          <PhasePanel key={p.title} title={p.title} range={p.range} className="map-panel">
            <span className="visually-hidden">{p.title}</span>
          </PhasePanel>
        ))}
        <svg className="map-connectors" width="1020" height="640" viewBox="0 0 1020 640" aria-hidden="true" focusable="false">
          <defs>
            <marker id="map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" style={{ fill: 'var(--ih-flow)' }} />
            </marker>
            <marker id="map-arrow-side" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" style={{ fill: 'var(--ih-side)' }} />
            </marker>
          </defs>
          {FLOW.map((d) => (
            <path key={d} d={d} fill="none" strokeWidth={3} markerEnd="url(#map-arrow)" style={{ stroke: 'var(--ih-flow)' }} />
          ))}
          {SIDE.map((d) => (
            <path key={d} d={d} fill="none" strokeWidth={2.5} strokeDasharray="7 5" markerEnd="url(#map-arrow-side)" style={{ stroke: 'var(--ih-side)' }} />
          ))}
        </svg>
        <span className="map-edge flow" style={{ left: 640, top: 606 }}>publish when the gate passes</span>
        <span className="map-edge side" style={{ left: 648, top: 205 }}>hand edits change the draft</span>
        <span className="map-edge side" style={{ left: 648, top: 407 }}>revision changes the draft</span>
        {MAP_BOXES.map((b) => (
          <Box
            key={b.tab}
            item={item(b.tab)}
            number={b.number}
            projectId={projectId}
            overview={overview}
            now={now}
            style={{ left: 20 + 260 * b.col, top: [44, 244, 444][b.row] }}
          />
        ))}
      </div>
    </section>
  );
}

const STACK_GROUPS: { title: string; tabs: OverviewTab[] }[] = [
  { title: 'Prepare', tabs: ['samples', 'brief'] },
  { title: 'Draft with the model', tabs: ['survey', 'outputs', 'sections', 'steps'] },
  { title: 'Verify and publish', tabs: ['references', 'evaluate', 'revise', 'publish'] },
  { title: 'Edit and test by hand', tabs: ['template', 'runs'] },
];

/** The map's boxes as a list, for narrow screens (handoff §3 mobile). */
export function OverviewStack({ projectId, overview, now }: { projectId: string; overview: ProjectOverview; now: number }) {
  const number = (tab: OverviewTab) => MAP_BOXES.find((b) => b.tab === tab)!.number;
  return (
    <div className="map-stack" role="group" aria-label="Stages">
      {STACK_GROUPS.map((g) => (
        <section key={g.title} className="map-stack-group">
          <h3>{g.title}</h3>
          {g.tabs.map((tab) => (
            <Box key={tab} item={overview.stages.find((s) => s.stage === tab)!} number={number(tab)} projectId={projectId} overview={overview} now={now} />
          ))}
        </section>
      ))}
    </div>
  );
}
```

(The panel titles render through `PhasePanel`; drop the `visually-hidden` child if `PhasePanel` already exposes the title. `React.CSSProperties` → import `type CSSProperties` from 'react'. Positioning the panels: pass `style` through `PhasePanel` — add an optional `style` prop to `PhasePanel` if it lacks one — with `left/top/width/height: 172`.)

`OverviewTab.tsx`: keep the banner; replace the list with:

```tsx
      <OverviewMap projectId={projectId} overview={overview} now={now} />
      <OverviewStack projectId={projectId} overview={overview} now={now} />
      <p className="map-caption muted">
        Each panel groups the stages of one phase (its label sits top-right). Click any box to open its tab.
        Blue arrows are the order the stages run in; teal dashed arrows change the draft from outside the main
        flow. In the Draft phase the model proposes changes and you accept, edit or skip them.
      </p>
```

with `now` = an optional prop defaulting to `Date.now()` (tests pass a fixed value). The banner's icon tile: show `StageStatusIcon` for the banner stage's state (decorative) in a 32 px tile at the start of the banner.

`stages.css` (append):

```css
.map-scroll {
  overflow-x: auto;
  border-radius: var(--ih-radius-lg);
  background-color: var(--ih-page-well);
  background-image: radial-gradient(var(--ih-border-strong) 1px, transparent 1.2px);
  background-size: 20px 20px;
}
.map-canvas {
  position: relative;
  width: 1020px;
  height: 640px;
  margin: 0 auto;
}
.map-panel {
  position: absolute;
  height: 172px;
}
.map-connectors {
  position: absolute;
  inset: 0;
}
.map-edge {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 1px 6px;
  border-radius: var(--ih-radius-sm);
  background: var(--ih-page-well);
  font-size: var(--ih-text-xs);
  font-style: italic;
  font-weight: 600;
  white-space: nowrap;
}
.map-edge.side {
  transform: translate(0, -50%);
  color: var(--ih-side);
}
.map-edge.flow {
  color: var(--ih-flow);
}
.map-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1.5px solid;
  border-radius: var(--ih-radius-md);
  color: var(--ih-text);
  text-decoration: none;
  box-shadow: 0 1px 2px rgba(15, 27, 45, 0.08), 0 6px 16px rgba(15, 27, 45, 0.1);
}
.map-canvas .map-box {
  position: absolute;
  width: 200px;
  height: 124px;
}
.map-box[data-state='accepted'] {
  border-width: 1px;
}
.map-box[data-state='pending'] {
  border-style: dashed;
}
.map-box.is-next {
  box-shadow: 0 0 0 4px var(--ih-alert-bg), 0 6px 16px rgba(15, 27, 45, 0.1);
}
.map-box-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.map-box-tile {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--ih-radius-sm);
  background: var(--ih-surface);
  flex: none;
}
.map-box-title {
  flex: 1;
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.map-box-status {
  font-size: var(--ih-text-sm);
  font-weight: 600;
}
.map-box-number {
  margin-right: 6px;
  font-family: var(--ih-font-mono);
  font-weight: 400;
}
.map-box-metrics {
  display: grid;
  gap: 2px;
  margin-top: auto;
  font-size: var(--ih-text-xs);
}
.map-box-metric {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.map-box-metric span:first-child {
  color: var(--ih-muted);
}
.map-stack {
  display: none;
}
.map-caption {
  margin-top: 12px;
  font-size: var(--ih-text-sm);
}
@media (max-width: 760px) {
  .map-scroll {
    display: none;
  }
  .map-stack {
    display: grid;
    gap: 16px;
  }
  .map-stack-group {
    display: grid;
    gap: 8px;
  }
  .map-stack-group h3 {
    margin: 0;
    font-size: var(--ih-text-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ih-muted);
  }
}
```

Remove the now-unused `.overview-list` rules and the `stage-icon-slot` placeholder (only if nothing else uses them).

`fake-api.ts`: give each `projectOverview()` item two metrics, e.g. `[{ label: 'Figure', value: '—', at: null }, { label: 'Other', value: '—', at: null }]`, so fixtures match the schema shape.

- [ ] **Step 4: Run** `npx vitest run --project web` → PASS; `npm run typecheck && npm run lint`; `npx prettier --check apps/web`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/OverviewMap.tsx apps/web/src/workbench/OverviewTab.tsx apps/web/src/ui/PhasePanel.tsx apps/web/src/styles/stages.css apps/web/test/fake-api.ts apps/web/test/OverviewMap.test.tsx apps/web/test/OverviewTab.test.tsx
git commit -m "Workbench web: the Overview process map, with a stacked list on narrow screens"
```

---

### Task 4: Docs

**Files:** `CLAUDE.md` (the Workbench "Project page" sentence), `docs/design/workbench.md` ("Project page (redesign)" section)

- [ ] **Step 1:** In both, state: the overview's items carry two `metrics` per tab (`boxMetrics` over `MetricFacts` gathered in `projectOverview`; an `at` time renders as relative time), and the Overview tab is the process map (`OverviewMap`, fixed 1020×640 canvas; `OverviewStack` below 760 px).
- [ ] **Step 2:** `npm run check` and `npm run format:check` → green.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/design/workbench.md
git commit -m "Docs: the Overview map and its figures"
```
