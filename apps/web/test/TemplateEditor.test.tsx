import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateRecordView } from '../src/api/client.js';
import { TemplateEditor } from '../src/templates/TemplateEditor.js';
import { fakeApi } from './fake-api.js';
import { validDefinition } from './template-fixture.js';

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

function setup(record: TemplateRecordView, overrides = {}) {
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
    />,
  );
  return { api, onNavigate };
}

const tab = (name: RegExp) => screen.findByRole('tab', { name });

describe('TemplateEditor', () => {
  it('shows live validation issues for an incomplete draft', async () => {
    setup(view(skeleton));
    const issues = await screen.findByRole('list', { name: 'Validation issues' });
    expect(issues).toHaveTextContent('pipeline');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
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
    const publish = await screen.findByRole('button', { name: 'Publish' });
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

  it('sets step context from earlier steps', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/Pipeline/));
    const head = screen.getByRole('group', { name: 'Step 1' });
    // validDefinition: step 1 fills "sender"; step 2 fills table "lines" -> step 2 can use step 1
    const rows = screen.getByRole('group', { name: 'Step 2' });
    await userEvent.type(within(rows).getByLabelText('Context'), 'from_letterhead = sender');
    expect(within(head).getByLabelText('Context')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const saved = vi.mocked(api.saveTemplate).mock.calls[0]![2] as { pipeline: object[] };
    expect(saved.pipeline[1]).toMatchObject({ context: { from_letterhead: 'sender' } });
  });

  it('edits as YAML', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await userEvent.click(await tab(/YAML/));
    const editor = screen.getByLabelText('Template YAML');
    expect((editor as HTMLTextAreaElement).value).toContain('name: Letter');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'id: letter{enter}version: 1{enter}name: Memo');
    await userEvent.click(screen.getByRole('button', { name: 'Apply YAML' }));
    await userEvent.click(await tab(/General/));
    expect(screen.getByLabelText('Name')).toHaveValue('Memo');
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
    await userEvent.click(await screen.findByRole('button', { name: 'Run regression on v2' }));
    expect(api.runRegression).toHaveBeenCalledWith('letter', 2);
    const row = await screen.findByRole('row', { name: /acme/ });
    expect(row).toHaveTextContent('50%');
    expect(row).toHaveTextContent('sender');
    expect(row).toHaveTextContent('lines: 1 missing');
    expect(screen.getByText(/Average score 50%/)).toBeInTheDocument();
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

  it('test-runs a draft on a sample document', async () => {
    const { api } = setup(view({ ...validDefinition(), version: 1 }));
    const file = new File(['%PDF-1.7'], 'sample.pdf', { type: 'application/pdf' });
    await userEvent.upload(await screen.findByLabelText('Sample PDF'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Test run' }));
    expect(api.testRun).toHaveBeenCalledWith(file, 'letter', 1);
    expect(await screen.findByRole('status')).toHaveTextContent('Test run queued');
  });
});
