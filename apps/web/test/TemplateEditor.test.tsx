import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Api, type TemplateRecordView } from '../src/api/client.js';
import { TemplateEditor, type EmbeddedEditor } from '../src/templates/TemplateEditor.js';
import { fakeApi, job, projectOverview, projectView, publication, sampleView } from './fake-api.js';
import { RETIRED_REASON } from '../src/ui/retired.js';
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

function setup(record: TemplateRecordView, overrides = {}, embedded?: EmbeddedEditor) {
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

  it('sends one save while a save is in flight, and disables Save meanwhile', async () => {
    let finish: (v: TemplateRecordView) => void = () => {};
    const saveTemplate = vi.fn(
      () =>
        new Promise<TemplateRecordView>((resolve) => {
          finish = resolve;
        }),
    );
    setup(view({ ...validDefinition(), version: 1 }), { saveTemplate });
    await userEvent.type(await screen.findByLabelText('Name'), '!');
    const save = screen.getByRole('button', { name: 'Save draft' });
    await userEvent.dblClick(save);
    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Saving…');
    finish(view({ ...validDefinition(), version: 1, name: 'Letter!' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('labels a published version on the Versions tab and replaces the draft with it (#144)', async () => {
    const draft = view({ ...validDefinition(), version: 2 });
    draft.record.updatedAt = '2026-10-13T10:00:00.000Z';
    const restored = view({ ...validDefinition(), name: 'From v1', version: 2 });
    const item = (version: number, status: 'draft' | 'published') => ({
      version,
      status,
      createdAt: '',
      updatedAt: '2026-10-13T10:00:00.000Z',
      publishedAt: status === 'published' ? '2026-10-12T10:00:00.000Z' : null,
      label: null,
      note: null,
      labelSetBy: null,
      labelSetAt: null,
    });
    const { api } = setup(draft, {
      listVersions: vi.fn(async () => [item(2, 'draft'), item(1, 'published')]),
      restoreVersion: vi.fn(async () => restored),
    });
    await userEvent.click(await tab(/^Versions/));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit label of v1' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), 'First cut');
    await userEvent.click(screen.getByRole('button', { name: 'Save label' }));
    expect(api.setVersionLabel).toHaveBeenCalledWith('letter', 1, {
      label: 'First cut',
      note: null,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Replace draft v2 with v1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Replace draft' }));
    expect(api.restoreVersion).toHaveBeenCalledWith('letter', 2, 1, '2026-10-13T10:00:00.000Z');
    expect(await screen.findByText('Draft v2 replaced (not published yet).')).toBeInTheDocument();
    await userEvent.click(await tab(/^General/));
    expect(screen.getByLabelText('Name')).toHaveValue('From v1');
  });

  it('saves with the base it started from on the Templates page too', async () => {
    const record = view({ ...validDefinition(), version: 1 });
    record.record.updatedAt = '2026-10-13T10:00:00.000Z';
    const { api } = setup(record);
    await userEvent.type(await screen.findByLabelText('Name'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![3]).toBe('2026-10-13T10:00:00.000Z');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('has no Checks or Changes panels on the Templates page', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    await screen.findByRole('heading', { level: 1, name: 'Letter' });
    expect(screen.queryByRole('region', { name: 'Checks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /needs attention/ })).not.toBeInTheDocument();
  });

  describe('embedded in the workbench', () => {
    it('hides the single-sample test run (the Runs tab replaces it)', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await screen.findByRole('heading', { level: 2, name: 'Transformation recipe · draft v1' });
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

    it('has the tab header, with Publish, and no back link, name heading or Save draft button', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      expect(
        await screen.findByText(/Model proposals and your edits change the same draft/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 2, name: 'Transformation recipe · draft v1' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Document types/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Publish v1/ })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Export YAML' })).toHaveAttribute(
        'href',
        '/api/templates/letter/versions/1/export',
      );
    });

    it('opens on Pipeline, ordered General, Sections, Outputs, Pipeline, Mapping, YAML, Versions, without Quality', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await screen.findByRole('heading', { level: 2, name: 'Transformation recipe · draft v1' });
      const tabs = within(screen.getByRole('tablist', { name: 'Template sections' })).getAllByRole(
        'tab',
      );
      expect(tabs.map((t) => t.textContent?.replace(/\s*\d+.*$/, ''))).toEqual([
        'General',
        'Sections',
        'Outputs',
        'Pipeline',
        'Mapping',
        'YAML',
        'Versions',
      ]);
      expect(screen.getByRole('tab', { name: /^Pipeline/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.queryByRole('tab', { name: /Quality/ })).not.toBeInTheDocument();
      // validDefinition: one field and one table.
      expect(screen.getByRole('tab', { name: /^Outputs/ })).toHaveTextContent('Outputs 2');
    });

    it('shows the unsaved bar on any edit, and Discard restores the saved draft', async () => {
      const { api } = setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await userEvent.click(await tab(/^General/));
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
      await userEvent.type(screen.getByLabelText('Name'), '!');
      const bar = screen.getByRole('region', { name: 'Unsaved changes' });
      expect(bar).toHaveTextContent('Unsaved change to the name');
      expect(bar).toHaveTextContent('Saving marks the latest evaluation out of date.');
      await userEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
      expect(screen.getByLabelText('Name')).toHaveValue('Letter');
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
      expect(api.saveTemplate).not.toHaveBeenCalled();
    });

    it('saves from the bar with the base it started from and reports the save', async () => {
      const record = view({ ...validDefinition(), version: 1 });
      record.record.updatedAt = '2026-10-13T10:00:00.000Z';
      const onSaved = vi.fn();
      const { api } = setup(record, {}, { onChanged: vi.fn(), onSaved });
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      expect(api.saveTemplate).toHaveBeenCalledWith(
        'letter',
        1,
        expect.objectContaining({ name: 'Letter!' }),
        '2026-10-13T10:00:00.000Z',
      );
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    });

    it('sends one save from the bar while a save is in flight', async () => {
      let finish: (v: TemplateRecordView) => void = () => {};
      const saveTemplate = vi.fn(
        () =>
          new Promise<TemplateRecordView>((resolve) => {
            finish = resolve;
          }),
      );
      setup(view({ ...validDefinition(), version: 1 }), { saveTemplate }, { onChanged: vi.fn() });
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.dblClick(screen.getByRole('button', { name: 'Save draft v1' }));
      expect(saveTemplate).toHaveBeenCalledTimes(1);
      const bar = screen.getByRole('region', { name: 'Unsaved changes' });
      expect(within(bar).getByRole('button', { name: 'Saving…' })).toBeDisabled();
      expect(within(bar).getByRole('button', { name: 'Discard' })).toBeDisabled();
      finish(view({ ...validDefinition(), version: 1, name: 'Letter!' }));
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument(),
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('Discard after a refused save clears the conflict alert and the Reload button', async () => {
      const saveTemplate = vi.fn(async () => {
        throw new ApiError('the draft changed since you opened it; reload it', 409);
      });
      setup(view({ ...validDefinition(), version: 1 }), { saveTemplate }, { onChanged: vi.fn() });
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reload the draft' })).not.toBeInTheDocument();
    });

    it('Reload the draft refreshes the change log', async () => {
      const definition = { ...validDefinition(), version: 1 };
      const { api } = setup(
        view(definition),
        {
          saveTemplate: vi.fn(async () => {
            throw new ApiError('the draft changed since you opened it; reload it', 409);
          }),
        },
        { onChanged: vi.fn() },
      );
      await waitFor(() => expect(api.listDraftChanges).toHaveBeenCalledTimes(1));
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Reload the draft' }));
      await waitFor(() => expect(api.listDraftChanges).toHaveBeenCalledTimes(2));
    });

    it('shows the overview status line in the tab header', async () => {
      setup(
        view({ ...validDefinition(), version: 1 }),
        {},
        {
          onChanged: vi.fn(),
          item: {
            ...projectOverview().stages.find((s) => s.stage === 'template')!,
            state: 'accepted',
            status: 'Draft v1 is ready',
          },
        },
      );
      await screen.findByRole('heading', { level: 2 });
      expect(await screen.findByText('Draft v1 is ready')).toBeInTheDocument();
    });

    it('disables Test run with the validation count while the draft has issues', async () => {
      setup(
        view({ ...skeleton }),
        { listSamples: vi.fn(async () => [sampleView()]) },
        { onChanged: vi.fn() },
      );
      const run = await screen.findByRole('button', { name: 'Test run' });
      await waitFor(() => expect(run.getAttribute('title')).toMatch(/^Fix \d+ validation issues?/));
      expect(run).toBeDisabled();
    });

    it.each([
      ['local', true],
      ['external', false],
    ] as const)(
      "gives the Try on dialog the project's %s data policy",
      async (dataPolicy, cloudDisabled) => {
        setup(
          view({ ...validDefinition(), version: 1 }),
          { listSamples: vi.fn(async () => [sampleView()]) },
          { onChanged: vi.fn(), dataPolicy },
        );
        const run = await screen.findByRole('button', { name: 'Test run' });
        await waitFor(() => expect(run).toBeEnabled());
        await userEvent.click(run);
        const dialog = await screen.findByRole('dialog');
        const cloud = within(dialog).getByRole('option', { name: /Cloud model/ });
        expect((cloud as HTMLOptionElement).disabled).toBe(cloudDisabled);
      },
    );

    it('offers a reload when the draft changed elsewhere', async () => {
      const definition = { ...validDefinition(), version: 1 };
      const getTemplate = vi
        .fn()
        .mockResolvedValueOnce(view(definition))
        .mockResolvedValue(view({ ...definition, name: 'Changed elsewhere' }));
      setup(
        view(definition),
        {
          getTemplate,
          saveTemplate: vi.fn(async () => {
            throw new ApiError(
              'the draft changed since you opened it; reload it to see the changes',
              409,
            );
          }),
        },
        { onChanged: vi.fn() },
      );
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'the draft changed since you opened it',
      );
      await userEvent.click(screen.getByRole('button', { name: 'Reload the draft' }));
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Changed elsewhere'));
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    });

    it('tries the saved draft on one prepared dev sample', async () => {
      const onSaved = vi.fn();
      const { api } = setup(
        view({ ...validDefinition(), version: 1 }),
        {
          listSamples: vi.fn(async () => [
            sampleView({ id: 's1', filename: 'inv-0001.pdf' }),
            sampleView({ id: 's2', filename: 'inv-0012-initech.pdf' }),
            sampleView({ id: 'h1', filename: 'holdout.pdf', role: 'holdout' }),
            sampleView({ id: 'p1', filename: 'preparing.pdf', state: 'preparing' }),
          ]),
        },
        { onChanged: vi.fn(), onSaved, dataPolicy: 'local' },
      );
      const pick = await screen.findByRole('combobox', { name: 'Try on' });
      await waitFor(() =>
        expect([...(pick as HTMLSelectElement).options].map((o) => o.text)).toEqual([
          'inv-0001.pdf',
          'inv-0012-initech.pdf',
        ]),
      );
      await userEvent.selectOptions(pick, 's2');
      await userEvent.click(screen.getByRole('button', { name: 'Test run' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Run test' }));
      expect(api.runDevTests).toHaveBeenCalledWith('letter', { model: null, sampleIds: ['s2'] });
      expect(
        await screen.findByText('Test run queued on inv-0012-initech.pdf.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'See Test runs' })).toHaveAttribute(
        'href',
        '#/workbench/letter/runs',
      );
      expect(onSaved).toHaveBeenCalled();
    });

    it('disables Test run with a reason while edits are unsaved or no dev sample is prepared', async () => {
      setup(
        view({ ...validDefinition(), version: 1 }),
        { listSamples: vi.fn(async () => [sampleView({ state: 'failed', error: 'password' })]) },
        { onChanged: vi.fn() },
      );
      const run = await screen.findByRole('button', { name: 'Test run' });
      await waitFor(() =>
        expect(run).toHaveAttribute(
          'title',
          'No prepared dev samples: add or prepare some on the Samples tab',
        ),
      );
      expect(run).toBeDisabled();
      cleanup();
      setup(
        view({ ...validDefinition(), version: 1 }),
        { listSamples: vi.fn(async () => [sampleView()]) },
        { onChanged: vi.fn() },
      );
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      const blocked = screen.getByRole('button', { name: 'Test run' });
      expect(blocked).toBeDisabled();
      expect(blocked).toHaveAttribute(
        'title',
        'Save the draft first: a test run uses the saved draft',
      );
    });

    it('ends each part with a link to the stage that drafts it', async () => {
      setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      expect(await screen.findByRole('link', { name: 'Ask the model in Steps' })).toHaveAttribute(
        'href',
        '#/workbench/letter/steps',
      );
      await userEvent.click(await tab(/^Outputs/));
      expect(screen.getByRole('link', { name: 'Ask the model in Outputs' })).toHaveAttribute(
        'href',
        '#/workbench/letter/outputs',
      );
      await userEvent.click(await tab(/^Sections/));
      expect(screen.getByRole('link', { name: 'Ask the model in Sections' })).toBeInTheDocument();
      await userEvent.click(await tab(/^General/));
      expect(screen.getByRole('link', { name: /Revise/ })).toHaveAttribute(
        'href',
        '#/workbench/letter/revise',
      );
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

    it('marks the sub-tabs a check fails on and lists the checks, stale stages included', async () => {
      const definition = {
        ...validDefinition(),
        version: 1,
        outputs: {
          ...validDefinition().outputs,
          fields: [
            { id: 'sender', type: 'text' },
            { id: 'due_date', type: 'date' },
          ],
        },
      };
      setup(
        view(definition),
        {},
        {
          onChanged: vi.fn(),
          stages: [
            {
              stage: 'sections',
              state: 'stale',
              status: 'Stale — Outputs changed after it was accepted',
              metrics: [],
            },
          ],
        },
      );
      const checks = await screen.findByRole('region', { name: 'Checks' });
      expect(within(checks).getByText(/due_date is not filled by any step\./)).toBeInTheDocument();
      expect(within(checks).getByRole('link', { name: 'Review in Sections' })).toHaveAttribute(
        'href',
        '#/workbench/letter/sections',
      );
      expect(screen.getByRole('tab', { name: /^Pipeline.*needs attention/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Outputs.*needs attention/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Sections/ })).not.toHaveAccessibleName(
        /needs attention/,
      );
    });

    it('opens the sub-tab a validation issue names', async () => {
      setup(view({ ...skeleton }), {}, { onChanged: vi.fn() });
      await userEvent.click(await tab(/^General/));
      const checks = screen.getByRole('region', { name: 'Checks' });
      await userEvent.click(within(checks).getAllByRole('button', { name: 'Open Pipeline' })[0]!);
      expect(screen.getByRole('tab', { name: /^Pipeline/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('reloads the change log after a save', async () => {
      const { api } = setup(view({ ...validDefinition(), version: 1 }), {}, { onChanged: vi.fn() });
      await screen.findByRole('region', { name: 'Changes in draft v1' });
      await waitFor(() => expect(api.listDraftChanges).toHaveBeenCalledTimes(1));
      await userEvent.click(await tab(/^General/));
      await userEvent.type(screen.getByLabelText('Name'), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
      await waitFor(() => expect(api.listDraftChanges).toHaveBeenCalledTimes(2));
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
    const editor = screen.getByRole('textbox', { name: 'Recipe YAML' });
    expect(editor).toHaveTextContent('name: Letter');
    setYaml('Recipe YAML', 'id: letter\nversion: 1\nname: Memo');
    await userEvent.click(screen.getByRole('button', { name: 'Apply YAML' }));
    await userEvent.click(await tab(/General/));
    expect(screen.getByLabelText('Name')).toHaveValue('Memo');
  });

  it('shows a published version as read-only YAML', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'));
    await userEvent.click(await tab(/YAML/));
    expect(screen.getByRole('textbox', { name: 'Recipe YAML' })).toHaveAttribute(
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
    expect(dialog).toHaveTextContent("The recipe's own models");
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
    ).toEqual(['#', 'Section ID', 'Anchor', 'Required', 'Repeats', '']);
    const row = within(grid).getAllByRole('row')[1]!;
    expect(within(row).getByLabelText('Section 1 id')).toHaveValue('all');
    await userEvent.clear(within(row).getByLabelText('Section 1 anchor'));
    await userEvent.type(within(row).getByLabelText('Section 1 anchor'), '^Intro');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![2]).toMatchObject({
      document: { sections: [{ id: 'all', anchor: '^Intro' }] },
    });
  });

  it('marks a section as repeating with a key, and clears both when unticked', async () => {
    const { api } = setup(view(skeleton));
    await userEvent.click(await tab(/Sections/));
    expect(screen.queryByLabelText('Section 1 key')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Section 1 repeats' }));
    await userEvent.type(screen.getByLabelText('Section 1 key'), 'Batch (.+)');
    expect(
      within(screen.getByRole('combobox', { name: 'Section 1 key from' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None']);
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(vi.mocked(api.saveTemplate).mock.calls[0]![2]).toMatchObject({
      document: { sections: [{ id: 'all', repeat: true, key: 'Batch (.+)' }] },
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Section 1 repeats' }));
    expect(screen.queryByLabelText('Section 1 key')).not.toBeInTheDocument();
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

  it('orders the tabs General, Sections, Pipeline, Outputs, YAML, Quality, Versions', async () => {
    setup(view({ ...validDefinition(), version: 1 }));
    const tabs = await screen.findByRole('tablist', { name: 'Template sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent?.replace(/[\d·\s]+$/, '')),
    ).toEqual([
      'General',
      'Sections',
      'Pipeline',
      'Outputs',
      'Mapping',
      'YAML',
      'Quality',
      'Versions',
    ]);
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

describe('TemplateEditor embedded Pipeline (handoff §10)', () => {
  const invoice = () => ({
    id: 'letter',
    version: 1,
    name: 'Invoice',
    document: {
      sections: ['header', 'supplier', 'line_items', 'totals', 'payment'].map((id) => ({
        id,
        anchor: `^${id}`,
      })),
    },
    outputs: {
      fields: ['supplier_name', 'due_date', 'subtotal', 'total'].map((id) => ({
        id,
        type: 'text',
      })),
      tables: [{ id: 'line_items', columns: [{ id: 'amount', type: 'number' }] }],
    },
    pipeline: [
      {
        type: 'extract',
        id: 'header',
        fields: ['supplier_name'],
        sections: ['header', 'supplier'],
      },
      { type: 'extract', id: 'line_items', table: 'line_items', sections: ['line_items'] },
      {
        type: 'extract',
        id: 'totals',
        fields: ['subtotal', 'total'],
        sections: ['totals', 'payment'],
      },
    ],
  });
  const open = (overrides = {}) => setup(view(invoice()), overrides, { onChanged: vi.fn() });
  const savedPipeline = (api: ReturnType<typeof open>['api']) =>
    (vi.mocked(api.saveTemplate).mock.calls.at(-1)![2] as { pipeline: Record<string, unknown>[] })
      .pipeline;

  it('lists the steps as pressable rows and opens the first', async () => {
    open();
    const first = await screen.findByRole('button', {
      name: /^1 header Fills 1 · reads header, supplier/,
    });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Step 1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^3 totals/ }));
    expect(screen.getByRole('button', { name: /^3 totals/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('region', { name: 'Step 3' })).toBeInTheDocument();
  });

  it('toggles the sections a step reads', async () => {
    const { api } = open();
    await userEvent.click(await screen.findByRole('button', { name: /^3 totals/ }));
    const step = screen.getByRole('region', { name: 'Step 3' });
    const payment = within(step).getByRole('checkbox', { name: 'payment' });
    expect(payment).toBeChecked();
    await userEvent.click(payment);
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    expect(savedPipeline(api)[2]!.sections).toEqual(['totals']);
  });

  it('lists the sections a step can read, one tick box per row', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: /^3 totals/ }));
    const step = screen.getByRole('region', { name: 'Step 3' });
    const reads = within(step).getByRole('group', { name: 'Reads sections' });
    const rows = within(within(reads).getByRole('list')).getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(within(row).getAllByRole('checkbox')).toHaveLength(1);
  });

  it('removes a filled output and offers unfilled outputs first', async () => {
    const { api } = open();
    await userEvent.click(await screen.findByRole('button', { name: /^3 totals/ }));
    const step = screen.getByRole('region', { name: 'Step 3' });
    await userEvent.click(within(step).getByRole('button', { name: 'Stop filling total' }));
    const add = within(step).getByRole('combobox', { name: 'Add output' });
    const groups = [...add.querySelectorAll('optgroup')].map((g) => [
      g.label,
      [...g.querySelectorAll('option')].map((o) => o.value),
    ]);
    expect(groups).toEqual([
      ['Not filled by any step', ['due_date', 'total']],
      ['Filled by another step', ['supplier_name']],
    ]);
    await userEvent.selectOptions(add, 'due_date');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    expect(savedPipeline(api)[2]!.fields).toEqual(['subtotal', 'due_date']);
  });

  it('a table step fills one table: Add output says why it is disabled', async () => {
    open();
    await userEvent.click(await screen.findByRole('button', { name: /^2 line_items/ }));
    const add = within(screen.getByRole('region', { name: 'Step 2' })).getByRole('combobox', {
      name: 'Add output',
    });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute(
      'title',
      'A table step fills one table: remove it to fill fields instead',
    );
    expect(
      within(screen.getByRole('region', { name: 'Step 2' })).getByLabelText('Pages per call'),
    ).toHaveAttribute('placeholder', 'all');
  });

  it('adds a step, opens it, and lets it fill a table', async () => {
    const { api } = open();
    await userEvent.click(await screen.findByRole('button', { name: 'Add extract step' }));
    const step = screen.getByRole('region', { name: 'Step 4' });
    await userEvent.type(within(step).getByLabelText('Step id'), 'rows');
    await userEvent.selectOptions(
      within(step).getByRole('combobox', { name: 'Add output' }),
      'line_items',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    expect(savedPipeline(api)[3]).toMatchObject({ id: 'rows', table: 'line_items', fields: [] });
  });

  it('shows the last runs and explains a step that keeps retrying', async () => {
    open({
      getMetrics: vi.fn(async () => ({
        templateId: 'letter',
        versions: [],
        topEdited: [],
        steps: [
          {
            stepId: 'totals',
            runs: 18,
            reruns: 0,
            failures: 0,
            avgAttempts: 2,
            avgOutputTokens: null,
            avgSeconds: 5,
          },
        ],
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: /^3 totals/ }));
    const step = screen.getByRole('region', { name: 'Step 3' });
    expect(await within(step).findByText(/2\.0 attempts on average/)).toHaveTextContent(
      'add instructions below',
    );
    expect(within(step).getByText('18')).toBeInTheDocument();
  });

  it("removing a middle step shows the next step's context; editing it changes that step only", async () => {
    const def = invoice();
    def.pipeline[1] = { ...def.pipeline[1], context: { a: 'supplier_name' } } as never;
    def.pipeline[2] = { ...def.pipeline[2], context: { b: 'subtotal' } } as never;
    const { api } = setup(view(def), {}, { onChanged: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: /^2 line_items/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove step 2' }));
    const step = screen.getByRole('region', { name: 'Step 2' });
    await userEvent.click(within(step).getByText('More settings'));
    const ctx = within(step).getByLabelText('Context') as HTMLTextAreaElement;
    expect(ctx.value).toBe('b = subtotal');
    await userEvent.type(ctx, '\nc = total');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    const saved = savedPipeline(api);
    expect(saved).toHaveLength(2);
    expect(saved[1]!.context).toEqual({ b: 'subtotal', c: 'total' });
    expect(saved[0]!.context).toBeUndefined();
  });

  it('Discard shows the saved context in the open step', async () => {
    const def = invoice();
    def.pipeline[0] = { ...def.pipeline[0], context: { a: 'subtotal' } } as never;
    setup(view(def), {}, { onChanged: vi.fn() });
    const step = await screen.findByRole('region', { name: 'Step 1' });
    await userEvent.click(within(step).getByText('More settings'));
    await userEvent.type(within(step).getByLabelText('Context'), '\nc = total');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const after = screen.getByRole('region', { name: 'Step 1' });
    await userEvent.click(within(after).getByText('More settings'));
    expect((within(after).getByLabelText('Context') as HTMLTextAreaElement).value).toBe(
      'a = subtotal',
    );
  });

  it('says why the first step cannot move up', async () => {
    open();
    const up = await screen.findByRole('button', { name: 'Move step 1 up' });
    expect(up).toBeDisabled();
    expect(up).toHaveAttribute('title', 'Already the first step');
    await userEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));
    expect(screen.getByRole('button', { name: /^2 header/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('TemplateEditor of a retired type (D17: read-only)', () => {
  const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  const retiredList = (published: number | null, draft: number | null) =>
    vi.fn(async () => [{ ...listItem(published, draft), retired: retirement }]);
  const blocked = (element: HTMLElement) => {
    expect(element).toBeDisabled();
    expect(element).toHaveAttribute('title', RETIRED_REASON);
  };

  it('opens a draft read-only with the banner; publish, save and test runs carry the reason', async () => {
    setup(view({ ...validDefinition(), version: 2 }), { listTemplates: retiredList(1, 2) });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Retired by ken on 14 Oct 2026');
    expect(note).toHaveTextContent('DELETE /api/specs/letter/retirement');
    blocked(screen.getByRole('button', { name: /^Publish v2/ }));
    blocked(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByLabelText('Name')).toBeDisabled(); // the form is read-only
    blocked(screen.getByLabelText('Sample document'));
    blocked(screen.getByRole('button', { name: 'Run test' }));
    // Still allowed: export, and deleting the draft (D5).
    expect(screen.getByRole('link', { name: 'Export YAML' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /unretire/i })).toBeNull();
  });

  it('disables New draft from vN on a published version', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'), {
      listTemplates: retiredList(1, null),
    });
    await screen.findByRole('note');
    blocked(screen.getByRole('button', { name: 'New draft from v1' }));
  });

  it('disables Run regression on the Quality tab', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'), {
      listTemplates: retiredList(1, null),
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
    });
    await screen.findByRole('note');
    await userEvent.click(await tab(/Quality/));
    blocked(await screen.findByRole('button', { name: 'Run regression on v1…' }));
  });

  it('embedded: read-only, Try on and Publish carry the reason, and no banner of its own', async () => {
    setup(
      view({ ...validDefinition(), version: 2 }),
      {
        listTemplates: retiredList(1, 2),
        listSamples: vi.fn(async () => [sampleView()]),
      },
      { onChanged: vi.fn() },
    );
    const publish = await screen.findByRole('button', { name: /^Publish v2/ });
    await waitFor(() => expect(publish).toHaveAttribute('title', RETIRED_REASON));
    expect(publish).toBeDisabled();
    blocked(screen.getByRole('button', { name: 'Test run' }));
    expect(screen.queryByRole('note')).toBeNull(); // the project page shows the banner
  });

  it('is not editable until the retirement is known (Task 9 note)', async () => {
    type Items = Awaited<ReturnType<Api['listTemplates']>>;
    let answer: (items: Items) => void = () => {};
    const pending = new Promise<Items>((r) => (answer = r));
    setup(view({ ...validDefinition(), version: 2 }), { listTemplates: vi.fn(() => pending) });
    const name = await screen.findByLabelText('Name');
    expect(name).toBeDisabled();
    answer([{ ...listItem(1, 2), retired: null }]);
    await waitFor(() => expect(name).toBeEnabled());
  });

  it('stays editable for an active type', async () => {
    setup(view({ ...validDefinition(), version: 2 }), {
      listTemplates: vi.fn(async () => [listItem(1, 2)]),
    });
    await screen.findByText('from published v1 · letter');
    expect(screen.getByLabelText('Name')).toBeEnabled();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('delivered formats (ADR 0011)', () => {
  it('offers RDF only once the recipe has a mapping', async () => {
    setup(view(validDefinition()));
    await userEvent.click(await tab(/General/));
    const rdf = screen.getByRole('checkbox', { name: /RDF/ });
    expect(rdf).toBeDisabled();
    expect(
      screen.getByText('Add an ontology mapping on the Mapping tab to deliver RDF.'),
    ).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'CSV' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'JSON' })).toBeChecked();
  });

  it('saves the formats ticked', async () => {
    const semantics = {
      ontologies: [],
      prefixes: { ex: 'https://ex.example/' },
      document: { class: 'ex:Letter' },
      local: [{ iri: 'ex:Letter', kind: 'class', label: 'Letter' }],
    };
    const { api } = setup(view({ ...validDefinition(), semantics }));
    await userEvent.click(await tab(/General/));
    await userEvent.click(screen.getByRole('checkbox', { name: /RDF/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'CSV' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.saveTemplate).toHaveBeenCalled());
    const saved = vi.mocked(api.saveTemplate).mock.calls.at(-1)![2];
    expect(saved.delivery).toEqual({ formats: ['json', 'rdf'] });
  });

  it('has a Mapping sub-tab', async () => {
    setup(view(validDefinition()));
    await userEvent.click(await tab(/Mapping/));
    expect(screen.getByRole('button', { name: 'Map to ontologies' })).toBeTruthy();
  });
});

const REPEAT_SECTIONS = [
  { id: 'front', anchor: '\\A' },
  { id: 'batch', anchor: '^\\d+\\. STUDY', repeat: true, key: 'BATCH (.+)' },
  { id: 'appearance', anchor: '^Table', repeat: true, key: 'Batch (.+)', keyFrom: 'batch' },
  { id: 'plain_repeat', anchor: '^Annex', repeat: true },
];

describe('repeating sections in the step form', () => {
  const repeatRecipe = () => ({
    id: 'covalidation',
    version: 1,
    name: 'Covalidation',
    document: { ocr: 'auto', sections: REPEAT_SECTIONS },
    outputs: {
      fields: [{ id: 'study', type: 'text' }],
      tables: [
        {
          id: 'appearance_results',
          columns: [
            { id: 'batch', type: 'text' },
            { id: 'result', type: 'text' },
          ],
        },
      ],
    },
    pipeline: [
      { type: 'extract', id: 'header', fields: ['study'], sections: ['front'] },
      { type: 'extract', id: 'appearance', table: 'appearance_results', sections: ['appearance'] },
    ],
  });

  it('sets the key column of a table step reading a repeating section', async () => {
    const { api } = setup(view(repeatRecipe()), {}, { onChanged: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: /^2 appearance/ }));
    const step = screen.getByRole('region', { name: 'Step 2' });
    expect(within(step).getByText('Runs once per occurrence of appearance')).toBeInTheDocument();
    const column = within(step).getByRole('combobox', { name: 'Key column' });
    expect(
      within(column)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['None', 'batch', 'result']);
    await userEvent.selectOptions(column, 'batch');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft v1' }));
    const saved = vi.mocked(api.saveTemplate).mock.calls.at(-1)![2] as {
      pipeline: Record<string, unknown>[];
    };
    expect(saved.pipeline[1]).toMatchObject({ keyColumn: 'batch' });
  });

  it('keeps a field step off repeating sections', async () => {
    setup(view(repeatRecipe()), {}, { onChanged: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: /^1 header/ }));
    const step = screen.getByRole('region', { name: 'Step 1' });
    expect(within(step).getByRole('checkbox', { name: 'batch repeats' })).toBeDisabled();
    expect(within(step).getByRole('checkbox', { name: 'front' })).toBeEnabled();
    expect(within(step).queryByRole('combobox', { name: 'Key column' })).not.toBeInTheDocument();
  });
});
