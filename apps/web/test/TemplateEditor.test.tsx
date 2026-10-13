import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateRecordView } from '../src/api/client.js';
import { TemplateEditor } from '../src/templates/TemplateEditor.js';
import { fakeApi, job, projectView, publication } from './fake-api.js';
import { validDefinition } from './template-fixture.js';
import { setYaml } from './yaml-editor.js';

const skeleton = {
  id: 'letter',
  version: 1,
  name: 'Letter',
  document: { ocr: 'auto', sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [], tables: [] },
  pipeline: [],
  review: { required: 'on_warnings' },
};

const view = (
  definition: Record<string, unknown>,
  status: 'draft' | 'published' = 'draft',
): TemplateRecordView => ({
  record: {
    id: String(definition.id),
    version: Number(definition.version),
    status,
    definition,
    createdAt: '',
    updatedAt: '',
    publishedAt: null,
  },
  issues: [],
});

function setup(record: TemplateRecordView, overrides = {}, embedded?: { onChanged: () => void }) {
  const onNavigate = vi.fn();
  const api = fakeApi({
    getTemplate: vi.fn(async () => record),
    saveTemplate: vi.fn(async (_id: string, _v: number, definition: Record<string, unknown>) =>
      view(definition),
    ),
    ...overrides,
  });
  render(
    <TemplateEditor
      api={api}
      templateId={record.record.id}
      version={record.record.version}
      onNavigate={onNavigate}
      embedded={embedded}
    />,
  );
  return { api, onNavigate };
}

const tab = (name: RegExp) => screen.findByRole('tab', { name });

const listItem = (published: number | null, draft: number | null) => ({
  id: 'letter',
  name: 'Letter',
  description: null,
  published,
  draft,
  versions: [],
  summary: {
    sections: 1,
    fields: 0,
    tables: 0,
    references: 0,
    draftIssues: null,
    lastRegression: null,
    regressionRunning: false,
  },
});

describe('TemplateEditor header', () => {
  it('names the draft and where it came from', async () => {
    setup(view({ ...validDefinition(), version: 2 }), {
      listTemplates: vi.fn(async () => [listItem(1, 2)]),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Letter' })).toBeInTheDocument();
    expect(screen.getByText('Draft v2')).toBeInTheDocument();
    expect(await screen.findByText('from published v1 · letter')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Document types/ })).toHaveAttribute(
      'href',
      '#/templates',
    );
  });

  it('has no "from published" line for a never-published draft', async () => {
    setup(view({ ...validDefinition(), version: 1 }), {
      listTemplates: vi.fn(async () => [listItem(null, 1)]),
    });
    await screen.findByRole('heading', { level: 1, name: 'Letter' });
    expect(screen.queryByText(/from published/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Publish v1/ })).toBeEnabled();
  });

  it('flags unsaved changes and explains why Publish is disabled', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.type(await screen.findByLabelText('Name'), '!');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: /^Publish v1/ });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute('title', 'Save the draft before publishing');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
  });

  it('explains validation issues as the publish blocker', async () => {
    setup(view(skeleton));
    const publish = await screen.findByRole('button', { name: /^Publish v1/ });
    expect(publish.getAttribute('title')).toMatch(/^Fix \d+ validation issues?$/);
    expect(screen.getByText(publish.getAttribute('title')!)).toBeInTheDocument();
  });

  it('deletes a draft only after confirming, from the More actions menu', async () => {
    const { api, onNavigate } = setup(view({ ...validDefinition(), version: 2 }));
    const more = await screen.findByRole('button', { name: 'More actions' });
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    expect(screen.getByText('Delete draft v2? This cannot be undone.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(api.deleteDraft).not.toHaveBeenCalled();
    expect(more).toHaveFocus();
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete draft v2' }));
    expect(api.deleteDraft).toHaveBeenCalledWith('letter', 2);
    expect(onNavigate).toHaveBeenCalledWith('#/templates');
  });

  it('offers only a new draft and export on a published version', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'));
    expect(await screen.findByRole('button', { name: 'New draft from v1' })).toBeInTheDocument();
    expect(screen.getByText('Published v1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export YAML' })).toHaveAttribute(
      'href',
      '/api/templates/letter/versions/1/export',
    );
    expect(screen.queryByRole('button', { name: /^Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });
});

describe('TemplateEditor', () => {
  it('shows live validation issues for an incomplete draft', async () => {
    setup(view(skeleton));
    const issues = await screen.findByRole('list', { name: 'Validation issues' });
    expect(issues).toHaveTextContent('pipeline');
    expect(screen.getByRole('button', { name: /^Publish v1/ })).toBeDisabled();
  });

  it('builds a template: field, then a step that fills it, then saves', async () => {
    const { api } = setup(view(skeleton));
    await userEvent.click(await tab(/Outputs/));
    await userEvent.click(screen.getByRole('button', { name: 'Add field' }));
    await userEvent.type(screen.getByLabelText('Field 1 id'), 'sender');
    await userEvent.selectOptions(screen.getByLabelText('Field 1 type'), 'text');

    await userEvent.click(await tab(/Pipeline/));
    await userEvent.click(screen.getByRole('button', { name: 'Add extract step' }));
    const step = screen.getByRole('group', { name: 'Step 1' });
    await userEvent.type(within(step).getByLabelText('Step id'), 'head');
    await userEvent.click(within(step).getByRole('checkbox', { name: 'sender' }));
    await userEvent.click(within(step).getByRole('checkbox', { name: 'all' }));
    await userEvent.type(
      within(step).getByLabelText('Instructions'),
      'The sender is in the letterhead.',
    );

    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Validation issues' })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const saved = vi.mocked(api.saveTemplate).mock.calls[0]!;
    expect(saved[0]).toBe('letter');
    expect(saved[2]).toMatchObject({
      outputs: { fields: [{ id: 'sender', type: 'text' }] },
      pipeline: [
        {
          type: 'extract',
          id: 'head',
          fields: ['sender'],
          sections: ['all'],
          instructions: 'The sender is in the letterhead.',
        },
      ],
    });
  });

  it('publishes only a saved, valid draft', async () => {
    const definition = { ...validDefinition(), version: 1 };
    const { api } = setup(view(definition), {
      publishTemplate: vi.fn(async () => view(definition, 'published')),
    });
    const publish = await screen.findByRole('button', { name: /^Publish v1/ });
    expect(publish).toBeEnabled();

    await userEvent.type(screen.getByLabelText('Name'), ' (edited)');
    expect(publish).toBeDisabled(); // unsaved changes
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(publish).toBeEnabled());
    await userEvent.click(publish);
    expect(api.publishTemplate).toHaveBeenCalledWith('letter', 1);
  });

  it('shows published versions read-only and starts new drafts from them', async () => {
    const { api, onNavigate } = setup(view({ ...validDefinition(), version: 1 }, 'published'), {
      newDraft: vi.fn(async () => view({ ...validDefinition(), version: 2 })),
    });
    expect(await screen.findByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New draft from v1' }));
    expect(api.newDraft).toHaveBeenCalledWith('letter', 1);
    expect(onNavigate).toHaveBeenCalledWith('#/templates/letter/2');
  });

  describe('embedded in the workbench', () => {
    it('hides the single-sample test run (the Runs tab replaces it)', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await screen.findByRole('button', { name: /^Publish v1/ });
      expect(
        screen.queryByRole('complementary', { name: 'Test this draft' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Sample document')).not.toBeInTheDocument();
    });

    it('publishes through the Workbench, without references or evaluation, and reports it', async () => {
      const definition = { ...validDefinition(), version: 1 };
      const onChanged = vi.fn();
      const getTemplate = vi
        .fn()
        .mockResolvedValueOnce(view(definition))
        .mockResolvedValue(view(definition, 'published'));
      const { onNavigate, api } = setup(
        view(definition),
        {
          getTemplate,
          publish: vi.fn(async () => ({ publication: publication(), project: projectView() })),
        },
        { onChanged },
      );
      await userEvent.click(await screen.findByRole('button', { name: /^Publish v1/ }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(api.publish).toHaveBeenCalledWith('letter');
      expect(api.publishTemplate).not.toHaveBeenCalled();
      expect(await screen.findByText('Published v1.')).toBeInTheDocument();
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('reports a new draft instead of navigating', async () => {
      const onChanged = vi.fn();
      const { onNavigate } = setup(
        view({ ...validDefinition(), version: 1 }, 'published'),
        { newDraft: vi.fn(async () => view({ ...validDefinition(), version: 2 })) },
        { onChanged },
      );
      await userEvent.click(await screen.findByRole('button', { name: 'New draft from v1' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('reports a deleted draft instead of navigating', async () => {
      const onChanged = vi.fn();
      const { onNavigate, api } = setup(
        view({ ...validDefinition(), version: 1 }),
        {},
        { onChanged },
      );
      await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete draft v1' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(api.deleteDraft).toHaveBeenCalledWith('letter', 1);
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  it('sets step context from earlier steps', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Pipeline/));
    // validDefinition: step 1 fills "sender"; step 2 fills table "lines" -> step 2 can use step 1
    await userEvent.click(screen.getByRole('button', { name: /^2 EXTRACT rows/ }));
    const rows = screen.getByRole('group', { name: 'Step 2' });
    await userEvent.type(within(rows).getByLabelText('Context'), 'from_letterhead = sender');
    await userEvent.click(screen.getByRole('button', { name: /^1 EXTRACT head/ }));
    const head = screen.getByRole('group', { name: 'Step 1' });
    expect(within(head).getByLabelText('Context')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const saved = vi.mocked(api.saveTemplate).mock.calls[0]![2] as { pipeline: object[] };
    expect(saved.pipeline[1]).toMatchObject({ context: { from_letterhead: 'sender' } });
  });

  it('edits as YAML', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/YAML/));
    const editor = screen.getByRole('textbox', { name: 'Template YAML' });
    expect(editor).toHaveTextContent('name: Letter');
    setYaml('Template YAML', 'id: letter\nversion: 1\nname: Memo');
    await userEvent.click(screen.getByRole('button', { name: 'Apply YAML' }));
    await userEvent.click(await tab(/General/));
    expect(screen.getByLabelText('Name')).toHaveValue('Memo');
  });

  it('shows a published version as read-only YAML', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'));
    await userEvent.click(await tab(/YAML/));
    expect(screen.getByRole('textbox', { name: 'Template YAML' })).toHaveAttribute(
      'aria-readonly',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Apply YAML' })).toBeDisabled();
  });

  it('compares the version with another one', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 2 }), {
      listTemplates: vi.fn(async () => [
        {
          id: 'letter',
          name: 'Letter',
          description: null,
          published: 1,
          draft: 2,
          versions: [
            { version: 1, status: 'published' as const, updatedAt: '' },
            { version: 2, status: 'draft' as const, updatedAt: '' },
          ],
        },
      ]),
      diffVersions: vi.fn(async () => ({
        from: 1,
        to: 2,
        changes: [
          { kind: 'changed', path: 'pipeline[head].instructions', before: 'one', after: 'two' },
        ],
      })),
    });
    await userEvent.click(await tab(/Quality/));
    await userEvent.selectOptions(await screen.findByLabelText('Compare with'), '1');
    expect(api.diffVersions).toHaveBeenCalledWith('letter', 1, 2);
    expect(await screen.findByText('pipeline[head].instructions')).toBeInTheDocument();
  });

  it('runs the regression suite and shows scores per reference', async () => {
    const report = {
      items: [
        {
          reference: { id: 'r1', name: 'acme' },
          job: { id: 'j1', status: 'succeeded', error: null },
          comparison: {
            score: 0.5,
            fields: [{ id: 'sender', expected: 'ACME', actual: 'Acme Corp', match: false }],
            tables: [
              {
                id: 'lines',
                expected: 2,
                actual: 1,
                matched: 1,
                missing: [{ item: 'nuts' }],
                extra: [],
              },
            ],
          },
        },
      ],
      summary: { references: 1, completed: 1, averageScore: 0.5 },
    };
    const { api } = setup(view({ ...validDefinition(), version: 2 }), {
      listReferences: vi.fn(async () => [
        {
          id: 'r1',
          templateId: 'letter',
          name: 'acme',
          documentId: 'd',
          sourceJobId: 'j',
          expected: { fields: {}, tables: {} },
          createdAt: '',
        },
      ]),
      getRegression: vi.fn(async () => report),
      runRegression: vi.fn(async () => ({ jobs: [] })),
    });
    await userEvent.click(await tab(/Quality/));
    await userEvent.click(await screen.findByRole('button', { name: 'Run regression on v2…' }));
    // Regression measures the template: the dialog shows its own models, fixed.
    const dialog = screen.getByRole('dialog', { name: 'Run regression on v2' });
    expect(dialog).toHaveTextContent("The template's own models");
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run regression' }));
    expect(api.runRegression).toHaveBeenCalledWith('letter', 2);
    const row = await screen.findByRole('row', { name: /acme/ });
    expect(row).toHaveTextContent('50%');
    expect(row).toHaveTextContent('sender');
    expect(row).toHaveTextContent('lines: 1 missing');
    expect(screen.getByText(/Average score 50%/)).toBeInTheDocument();
  });

  it('lists the references of the version it shows', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 2 }));
    await userEvent.click(await tab(/Quality/));
    await waitFor(() => expect(api.listReferences).toHaveBeenCalledWith('letter', 2));
  });

  it('shows operational metrics for the document type', async () => {
    setup(view({ ...validDefinition(), version: 3 }), {
      getMetrics: vi.fn(async () => ({
        templateId: 'letter',
        versions: [
          {
            version: 3,
            jobs: 3,
            testJobs: 1,
            byStatus: { succeeded: 2, awaiting_review: 1 },
            reviewed: 2,
            reviewRate: 2 / 3,
            editsPerReviewed: 1.5,
            avgProcessingSeconds: 540,
          },
        ],
        steps: [
          {
            stepId: 'test_results',
            runs: 2,
            reruns: 0,
            failures: 0,
            avgAttempts: 15,
            avgOutputTokens: 58500,
            avgSeconds: 225,
          },
        ],
        topEdited: [{ target: 'batches.batch_number', edits: 2 }],
      })),
    });
    await userEvent.click(await tab(/Quality/));
    const versions = await screen.findByRole('table', { name: 'metrics by version' });
    expect(within(versions).getByRole('row', { name: /^v3/ })).toHaveTextContent('67%');
    expect(within(versions).getByRole('row', { name: /^v3/ })).toHaveTextContent('9.0 min');
    const steps = screen.getByRole('table', { name: 'metrics by step' });
    expect(within(steps).getByRole('row', { name: /test_results/ })).toHaveTextContent('58,500');
    expect(screen.getByText(/Most corrected by reviewers/)).toHaveTextContent(
      'batches.batch_number (2 edits)',
    );
  });

  it('lays out sections one per row under column headings', async () => {
    const { api } = setup(view(skeleton));
    await userEvent.click(await tab(/Sections/));
    const grid = screen.getByRole('table', { name: 'Sections' });
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['#', 'Section ID', 'Anchor', 'Required', '']);
    const row = within(grid).getAllByRole('row')[1]!;
    expect(within(row).getByLabelText('Section 1 id')).toHaveValue('all');
    await userEvent.clear(within(row).getByLabelText('Section 1 anchor'));
    await userEvent.type(within(row).getByLabelText('Section 1 anchor'), '^Intro');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![2]).toMatchObject({
      document: { sections: [{ id: 'all', anchor: '^Intro' }] },
    });
  });

  it('lays out fields one per row under column headings', async () => {
    setup(view(skeleton));
    await userEvent.click(await tab(/Outputs/));
    await userEvent.click(screen.getByRole('button', { name: 'Add field' }));
    const grid = screen.getByRole('table', { name: 'Fields' });
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['#', 'Field ID', 'Name', 'Type', 'Enum values', 'Description', '']);
    expect(within(grid).getByLabelText('Field 1 id')).toBeInTheDocument();
  });

  it('test-runs a draft on a sample document', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    const rail = await screen.findByRole('complementary', { name: 'Test this draft' });
    expect(within(rail).getByRole('button', { name: 'Run test' })).toBeDisabled();
    const file = new File(['%PDF-1.7'], 'sample.pdf', { type: 'application/pdf' });
    await userEvent.upload(within(rail).getByLabelText('Sample document'), file);
    await userEvent.click(within(rail).getByRole('button', { name: 'Run test on sample.pdf…' }));
    const dialog = screen.getByRole('dialog', { name: 'Test v1 on sample.pdf' });
    await within(dialog).findByRole('option', { name: 'New for testing only' });
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Model' }),
      'New for testing only',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run test' }));
    expect(api.testRun).toHaveBeenCalledWith(file, 'letter', 1, 'test');
    expect(await within(rail).findByRole('status')).toHaveTextContent('Test run queued');
  });

  it('test-runs a draft on a Word document', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    const rail = await screen.findByRole('complementary', { name: 'Test this draft' });
    const file = new File(['PK'], 'sample.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await userEvent.upload(within(rail).getByLabelText('Sample document'), file);
    await userEvent.click(within(rail).getByRole('button', { name: 'Run test on sample.docx…' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Run test' }),
    );
    expect(api.testRun).toHaveBeenCalledWith(file, 'letter', 1, null);
  });

  it('does not take a non-PDF as the sample', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    const rail = await screen.findByRole('complementary', { name: 'Test this draft' });
    fireEvent.change(within(rail).getByLabelText('Sample document'), {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    expect(within(rail).getByRole('button', { name: 'Run test' })).toBeDisabled();
    expect(within(rail).getByText('Choose a PDF or Word document')).toBeInTheDocument();
  });

  it('lists recent test runs of this document type', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({
      getTemplate: vi.fn(async () => view({ ...validDefinition(), version: 1 })),
    });
    render(
      <TemplateEditor
        api={api}
        templateId="letter"
        version={1}
        onNavigate={onNavigate}
        jobs={[
          job({
            id: 't1',
            filename: 'a.pdf',
            specId: 'letter',
            test: true,
            status: 'awaiting_review',
          }),
          job({ id: 't2', filename: 'b.pdf', specId: 'letter', test: true, status: 'succeeded' }),
          job({ id: 'x', filename: 'c.pdf', specId: 'other', test: true }),
        ]}
      />,
    );
    const list = await screen.findByRole('list', { name: 'Recent test runs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByRole('link', { name: 'a.pdf' })).toHaveAttribute(
      'href',
      '#/review/t1',
    );
    expect(within(list).getByText('Awaiting review')).toBeInTheDocument();
  });
});

describe('TemplateEditor tabs and step cards', () => {
  const stepHead = (n: number) =>
    screen.getByRole('button', { name: new RegExp(`^${n} (EXTRACT|CHECK)`) });

  it('counts sections, outputs and steps on the tabs', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    expect(await screen.findByRole('tab', { name: 'Sections 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Outputs 1 · 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pipeline 2' })).toBeInTheDocument();
  });

  it('orders the tabs General, Sections, Pipeline, Outputs, YAML, Quality', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    const tabs = await screen.findByRole('tablist', { name: 'Template sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent?.replace(/[\d·\s]+$/, '')),
    ).toEqual(['General', 'Sections', 'Pipeline', 'Outputs', 'YAML', 'Quality']);
  });

  it('splits Outputs into Fields and Tables sub-tabs', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Outputs/));
    const sub = screen.getByRole('tablist', { name: 'Outputs' });
    expect(within(sub).getByRole('tab', { name: 'Fields 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('table', { name: 'Fields' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Tables' })).not.toBeInTheDocument();
    await userEvent.click(within(sub).getByRole('tab', { name: 'Tables 1' }));
    expect(screen.queryByRole('table', { name: 'Fields' })).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Tables' })).toBeInTheDocument();
  });

  it('lists the tables and configures the selected one below the list', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Outputs/));
    await userEvent.click(screen.getByRole('tab', { name: /^Tables/ }));
    const list = screen.getByRole('table', { name: 'Tables' });
    expect(within(list).getByRole('button', { name: 'Configure table lines' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(list).getByText('2 columns')).toBeInTheDocument();
    const config = screen.getByRole('group', { name: 'Table lines' });
    expect(within(config).getByLabelText('Table 1 id')).toHaveValue('lines');
    expect(within(config).getByRole('table', { name: 'Table 1 columns' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add table' }));
    // The new table is selected at once, ready to name.
    const added = screen.getByRole('group', { name: 'Table 2' });
    await userEvent.type(within(added).getByLabelText('Table 2 id'), 'totals');
    expect(within(list).getByRole('button', { name: 'Configure table totals' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(list).getByRole('button', { name: 'Configure table lines' }));
    expect(screen.getByLabelText('Table 1 id')).toHaveValue('lines');
    expect(screen.queryByLabelText('Table 2 id')).not.toBeInTheDocument();

    await userEvent.click(within(list).getByRole('button', { name: 'Remove table 1' }));
    expect(screen.getByLabelText('Table 1 id')).toHaveValue('totals');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![2]).toMatchObject({
      outputs: { tables: [{ id: 'totals', columns: [] }] },
    });
  });

  it('says when there are no tables yet', async () => {
    setup(view(skeleton));
    await userEvent.click(await tab(/Outputs/));
    await userEvent.click(screen.getByRole('tab', { name: /^Tables/ }));
    expect(screen.getByText('No tables yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Table/ })).not.toBeInTheDocument();
  });

  it('sets the document type model on General, which steps naming none inherit', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    const model = await screen.findByRole('combobox', { name: 'Default model' });
    expect(model).toHaveValue('');
    await within(model).findByRole('option', { name: 'Default choice (Main Production Model)' });
    await userEvent.selectOptions(model, 'New for testing only');
    await userEvent.click(await tab(/Pipeline/));
    expect(stepHead(1)).toHaveTextContent('New for testing only (document type)');
    await userEvent.click(stepHead(1));
    const step = within(screen.getByRole('group', { name: 'Step 1' })).getByRole('combobox', {
      name: 'Model',
    });
    expect(step).toHaveValue('');
    expect(
      within(step).getByRole('option', { name: "Document type's model (New for testing only)" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const saved = vi.mocked(api.saveTemplate).mock.calls[0]![2] as Record<string, unknown>;
    expect(saved.model).toBe('test');
    expect((saved.pipeline as Record<string, unknown>[])[0]).not.toHaveProperty('model');
  });

  it('picks a step model from the model choices, by label', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Pipeline/));
    await userEvent.click(stepHead(1));
    const step = screen.getByRole('group', { name: 'Step 1' });
    const model = within(step).getByRole('combobox', { name: 'Model' });
    // No model: the default choice, named.
    expect(model).toHaveValue('');
    expect(
      within(model).getByRole('option', { name: 'Default choice (Main Production Model)' }),
    ).toBeInTheDocument();
    await within(model).findByRole('option', { name: 'New for testing only' });
    await userEvent.selectOptions(model, 'New for testing only');
    expect(stepHead(1)).toHaveTextContent('New for testing only');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![2]).toMatchObject({
      pipeline: [{ id: 'head', model: 'test' }, {}],
    });
    await userEvent.selectOptions(model, 'Default choice (Main Production Model)');
    expect(stepHead(1)).toHaveTextContent('default model');
  });

  it('shows steps as collapsed cards with a summary, one open at a time', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Pipeline/));
    expect(stepHead(1)).toHaveAttribute('aria-expanded', 'false');
    expect(stepHead(1)).toHaveTextContent('1 field · reads all · default model');
    expect(stepHead(2)).toHaveTextContent('Table lines · default model');
    expect(screen.queryByRole('group', { name: 'Step 1' })).not.toBeInTheDocument();
    await userEvent.click(stepHead(1));
    expect(stepHead(1)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Step 1' })).toBeInTheDocument();
    await userEvent.click(stepHead(2));
    expect(stepHead(1)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Step 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Step 2' })).toBeInTheDocument();
  });

  it('keeps the open step open when it moves, and closes it when removed', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Pipeline/));
    await userEvent.click(stepHead(1));
    await userEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));
    expect(
      within(screen.getByRole('group', { name: 'Step 2' })).getByLabelText('Step id'),
    ).toHaveValue('head');
    expect(stepHead(1)).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Remove step 2' }));
    expect(screen.queryByRole('group', { name: /Step/ })).not.toBeInTheDocument();
    expect(stepHead(1)).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the open step when an earlier step is removed', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Pipeline/));
    await userEvent.click(stepHead(2));
    await userEvent.click(screen.getByRole('button', { name: 'Remove step 1' }));
    expect(
      within(screen.getByRole('group', { name: 'Step 1' })).getByLabelText('Step id'),
    ).toHaveValue('rows');
  });

  it('switches what a step fills with the Fills choice', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Pipeline/));
    await userEvent.click(stepHead(1));
    const fills = screen.getByRole('group', { name: 'Fills' });
    expect(within(fills).getByRole('button', { name: 'Fields' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(fills).getByRole('button', { name: 'A table' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![2]).toMatchObject({
      pipeline: [{ id: 'head', table: 'lines', fields: [] }, {}],
    });
  });
});

describe('TemplateEditor review fixes', () => {
  it('lets a published version open its steps read-only', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'));
    await userEvent.click(await tab(/Pipeline/));
    const head = screen.getByRole('button', { name: /^1 EXTRACT head/ });
    expect(head).toBeEnabled();
    await userEvent.click(head);
    const step = screen.getByRole('group', { name: 'Step 1' });
    expect(within(step).getByLabelText('Step id')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move step 1 down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove step 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add extract step' })).toBeDisabled();
  });

  it('closes More actions on an outside click and on Escape from inside it', async () => {
    setup(view({ ...validDefinition(), version: 2 }));
    const more = await screen.findByRole('button', { name: 'More actions' });
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('heading', { level: 1, name: 'Letter' }));
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    screen.getByRole('button', { name: 'Delete draft' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
  });

  it('focuses Keep (not the destructive button) when the delete confirm opens', async () => {
    setup(view({ ...validDefinition(), version: 2 }));
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
  });
});
