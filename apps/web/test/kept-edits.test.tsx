import { EditorView } from '@codemirror/view';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import type { Api, TemplateRecordView } from '../src/api/client.js';
import { TemplateEditor } from '../src/templates/TemplateEditor.js';
import { LatestRun } from '../src/workbench/EvaluateLatest.js';
import { ReviseFeedback } from '../src/workbench/ReviseFeedback.js';
import { SectionsTab } from '../src/workbench/SectionsTab.js';
import { SurveyTab } from '../src/workbench/SurveyTab.js';
import {
  fakeApi,
  feedbackItem,
  iterationView,
  MODEL_CHOICES,
  proposalView,
  revisePreview,
  sampleView,
  segmentationView,
  templateView,
} from './fake-api.js';
import { validDefinition } from './template-fixture.js';
import { setYaml } from './yaml-editor.js';

/** Leaving a tab or page unmounts it; coming back mounts it afresh. */
const RESTORED = /Restored your unsaved/;

describe('recipe editor keeps unsaved edits', () => {
  const record = (updatedAt: string, name = 'Letter'): TemplateRecordView => ({
    record: {
      id: 'letter',
      version: 2,
      status: 'draft',
      definition: { ...validDefinition(), version: 2, name },
      createdAt: '',
      updatedAt,
      publishedAt: null,
    },
    issues: [],
  });
  const open = (api: Api) =>
    render(<TemplateEditor api={api} templateId="letter" version={2} onNavigate={vi.fn()} />);

  it('brings them back after leaving, marked unsaved', async () => {
    const first = open(
      fakeApi({ getTemplate: vi.fn(async () => record('2026-10-14T10:00:00.000Z')) }),
    );
    await userEvent.type(await screen.findByLabelText('Name'), ' (edited)');
    first.unmount();

    open(fakeApi({ getTemplate: vi.fn(async () => record('2026-10-14T10:00:00.000Z')) }));
    expect(await screen.findByLabelText('Name')).toHaveValue('Letter (edited)');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(RESTORED);
  });

  it('saves restored edits against the draft they were made on, so a newer save is not overwritten', async () => {
    const first = open(
      fakeApi({ getTemplate: vi.fn(async () => record('2026-10-14T10:00:00.000Z')) }),
    );
    await userEvent.type(await screen.findByLabelText('Name'), ' (edited)');
    first.unmount();

    const api = fakeApi({
      getTemplate: vi.fn(async () => record('2026-10-14T11:00:00.000Z', 'Letter v2')),
      saveTemplate: vi.fn(async () => record('2026-10-14T12:00:00.000Z')),
    });
    open(api);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Restored your unsaved changes from your last visit, but the draft was saved again since: saving them will be refused. Note what you need, then reload the draft.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(api.saveTemplate).toHaveBeenCalledWith(
      'letter',
      2,
      expect.objectContaining({ name: 'Letter (edited)' }),
      '2026-10-14T10:00:00.000Z',
    );
  });

  it('keeps nothing once saved or discarded', async () => {
    const api = fakeApi({
      getTemplate: vi.fn(async () => record('t1')),
      saveTemplate: vi.fn(async () => record('t2', 'Letter (edited)')),
    });
    const first = open(api);
    await userEvent.type(await screen.findByLabelText('Name'), ' (edited)');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    first.unmount();
    expect(localStorage.getItem('ih.recipeDraft.letter.2')).toBeNull();
  });

  it('keeps YAML that was typed but not applied', async () => {
    const yaml = () =>
      EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Recipe YAML' }))!;
    const first = open(fakeApi({ getTemplate: vi.fn(async () => record('t1')) }));
    await userEvent.click(await screen.findByRole('tab', { name: /YAML/ }));
    setYaml('Recipe YAML', 'id: letter\nversion: 2\nname: Memo # not applied');
    // Another sub-tab and back: still there.
    await userEvent.click(screen.getByRole('tab', { name: /General/ }));
    await userEvent.click(screen.getByRole('tab', { name: /YAML/ }));
    expect(yaml().state.doc.toString()).toContain('# not applied');
    first.unmount();

    open(fakeApi({ getTemplate: vi.fn(async () => record('t1')) }));
    await userEvent.click(await screen.findByRole('tab', { name: /YAML/ }));
    expect(yaml().state.doc.toString()).toContain('# not applied');
    expect(screen.getByRole('status')).toHaveTextContent(RESTORED);
  });
});

describe('Sections tab keeps unsaved anchors', () => {
  const definition = {
    id: 'letter',
    version: 2,
    name: 'Letter',
    document: { ocr: 'auto', sections: [{ id: 'all', anchor: '\\A' }] },
    outputs: { fields: [] },
    pipeline: [],
  };
  const api = () =>
    fakeApi({
      getTemplate: vi.fn(async () => templateView(definition)),
      saveTemplate: vi.fn(async (_i: string, _v: number, d: Record<string, unknown>) =>
        templateView(d),
      ),
      listSamples: vi.fn(async () => [sampleView({ id: 's1', filename: 'a.pdf' })]),
      startSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', status: 'queued' })),
      getSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1' })),
    });
  const open = (a: Api) => render(<SectionsTab api={a} projectId="letter" draft={2} pollMs={1} />);

  it('brings them back after leaving the tab', async () => {
    const first = open(api());
    await userEvent.clear(await screen.findByLabelText('Anchor of section 1'));
    await userEvent.type(screen.getByLabelText('Anchor of section 1'), '^LETTER');
    first.unmount();

    open(api());
    expect(await screen.findByLabelText('Anchor of section 1')).toHaveValue('^LETTER');
    expect(screen.getByRole('status')).toHaveTextContent(RESTORED);
  });
});

describe('Sections tab Discard', () => {
  it('goes back to the saved anchors and forgets the edits', async () => {
    const api = fakeApi({
      getTemplate: vi.fn(async () =>
        templateView({
          id: 'letter',
          version: 2,
          name: 'Letter',
          document: { ocr: 'auto', sections: [{ id: 'all', anchor: '\\A' }] },
          outputs: { fields: [] },
          pipeline: [],
        }),
      ),
      listSamples: vi.fn(async () => []),
      startSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1', status: 'queued' })),
      getSegmentation: vi.fn(async () => segmentationView({ jobId: 'j1' })),
    });
    render(<SectionsTab api={api} projectId="letter" draft={2} pollMs={1} />);
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    await userEvent.type(await screen.findByLabelText('Anchor of section 1'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Anchor of section 1')).toHaveValue('\\A');
    expect(screen.queryByText('Unsaved anchors')).toBeNull();
    expect(localStorage.getItem('ih.sectionsDraft.letter.2')).toBeNull();
  });
});

describe('Survey tab keeps typed answers', () => {
  const brief = { projectId: 'letter', version: 2, body: { ...EMPTY_BRIEF }, createdAt: '' };
  const open = (a: Api) =>
    render(
      <SurveyTab
        api={a}
        projectId="letter"
        dataPolicy="local"
        brief={brief}
        onBriefSaved={vi.fn()}
        pollMs={1}
      />,
    );
  const openQuestions = async () =>
    userEvent.click(await screen.findByRole('tab', { name: /^Questions/ }));
  const proposal = proposalView(); // the same survey on every visit
  const api = () =>
    fakeApi({
      listProposals: vi.fn(async () => [proposal]),
      saveBrief: vi.fn(async () => ({ ...brief, version: 3 })),
    });

  it('brings them back, and forgets them once saved to the brief', async () => {
    const first = open(api());
    await openQuestions();
    await userEvent.type(
      screen.getByLabelText('Which copy should be extracted?'),
      'The executed copy',
    );
    first.unmount();

    const second = open(api());
    await openQuestions();
    expect(screen.getByLabelText('Which copy should be extracted?')).toHaveValue(
      'The executed copy',
    );
    expect(screen.getByRole('status')).toHaveTextContent(RESTORED);
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 answer to brief (v3)' }));
    await screen.findByText('Answers saved to brief version 3');
    second.unmount();

    open(api());
    await openQuestions();
    expect(screen.getByLabelText('Which copy should be extracted?')).toHaveValue('');
  });
});

describe('Revise feedback keeps the note being written', () => {
  const open = (a: Api) =>
    render(
      <ReviseFeedback
        api={a}
        projectId="letter"
        items={[]}
        notSent={[]}
        samples={[]}
        iterations={[]}
        definition={revisePreview().draft!.definition}
        onChanged={vi.fn()}
      />,
    );

  it('brings it back, and forgets it once added', async () => {
    const first = open(fakeApi());
    await userEvent.type(screen.getByRole('textbox', { name: 'Feedback' }), 'Dates are DMY');
    first.unmount();

    const api = fakeApi({ addFeedback: vi.fn(async () => feedbackItem()) });
    const second = open(api);
    expect(screen.getByRole('textbox', { name: 'Feedback' })).toHaveValue('Dates are DMY');
    await userEvent.click(screen.getByRole('button', { name: /^Add/ }));
    await waitFor(() => expect(api.addFeedback).toHaveBeenCalled());
    second.unmount();

    open(fakeApi());
    expect(screen.getByRole('textbox', { name: 'Feedback' })).toHaveValue('');
  });
});

describe('Evaluate keeps a comment being written', () => {
  const open = (a: Api, iteration = iterationView()) =>
    render(
      <LatestRun
        api={a}
        projectId="letter"
        iteration={iteration}
        set="dev"
        threshold={0.9}
        choices={MODEL_CHOICES}
      />,
    );

  it('reopens the comment on the same run, but not on a newer one', async () => {
    const run = iterationView();
    const first = open(fakeApi(), run);
    await userEvent.click(screen.getByRole('button', { name: /^a\.pdf/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await userEvent.type(screen.getByLabelText(/^Comment on sent_on/), 'Dates are DMY');
    first.unmount();

    const second = open(fakeApi(), run);
    expect(screen.getByLabelText(/^Comment on sent_on/)).toHaveValue('Dates are DMY');
    second.unmount();

    open(fakeApi(), iterationView({ id: 'newer' }));
    expect(screen.queryByLabelText(/^Comment on sent_on/)).toBeNull();
  });
});
