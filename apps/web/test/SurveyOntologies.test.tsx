import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF, type BriefBody, type OntologySuggestionsView } from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { SurveyOntologies } from '../src/workbench/SurveyOntologies.js';
import { fakeApi } from './fake-api.js';

const brief = { projectId: 'letter', version: 2, body: { ...EMPTY_BRIEF }, createdAt: '' };

const view = (over: Partial<OntologySuggestionsView> = {}): OntologySuggestionsView => ({
  record: {
    surveyProposalId: 'p1',
    createdAt: '2026-10-15T10:00:00Z',
    candidates: 3,
    libraryKey: 'lexical|idmp@2',
    suggestions: [
      {
        ontologyId: 'idmp',
        version: 2,
        label: 'IDMP-O',
        covers: ['active_substance', 'strength'],
        evidence: [
          {
            candidate: 'active_substance',
            iri: 'https://ex.example/idmp#Substance',
            label: 'Substance',
            kind: 'class',
            via: 'lexical',
            similarity: 0.59,
          },
        ],
      },
    ],
    pinned: [],
    alsoMatched: [
      { ontologyId: 'afo', version: 1, label: 'AFO merged', covers: ['strength', 'batch'] },
    ],
    uncovered: ['batch_number'],
    notes: ['Retrieval was lexical only: no embedding model is set.'],
  },
  running: false,
  failed: null,
  stale: null,
  ...over,
});

function show(overrides = {}, props: Partial<Parameters<typeof SurveyOntologies>[0]> = {}) {
  const api = fakeApi({ getOntologySuggestions: vi.fn(async () => view()), ...overrides });
  const onBriefSaved = vi.fn();
  render(
    <SurveyOntologies
      api={api}
      projectId="letter"
      dataPolicy="local"
      brief={brief}
      onBriefSaved={onBriefSaved}
      pollMs={1}
      retired={null}
      hasSurvey
      {...props}
    />,
  );
  return { api, onBriefSaved };
}

describe('SurveyOntologies', () => {
  it('shows each suggestion with what it covers and its evidence', async () => {
    show();
    const card = await screen.findByRole('article', { name: 'IDMP-O v2' });
    expect(within(card).getByText('covers 2 of 3 candidates')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Evidence' }));
    expect(within(card).getByText(/active_substance → Substance/)).toBeInTheDocument();
    expect(screen.getByText(/Not covered: batch_number/)).toBeInTheDocument();
    expect(screen.getByText(/lexical only/)).toBeInTheDocument();
  });

  it('pins a suggestion into the brief', async () => {
    const saved = { ...brief, version: 3 };
    const { api, onBriefSaved } = show({ saveBrief: vi.fn(async () => saved) });
    await userEvent.click(await screen.findByRole('button', { name: 'Pin IDMP-O v2' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', {
      ...brief.body,
      ontologies: [{ ontologyId: 'idmp', version: 2, role: 'vocabulary' }],
    });
    await waitFor(() => expect(onBriefSaved).toHaveBeenCalledWith(saved));
  });

  it('disables Pin while a pin is saving', async () => {
    let resolve: (b: typeof brief) => void = () => {};
    const { api } = show({
      saveBrief: vi.fn(() => new Promise<typeof brief>((r) => (resolve = r))),
    });
    const pin = await screen.findByRole('button', { name: 'Pin IDMP-O v2' });
    await userEvent.click(pin);
    expect(pin).toBeDisabled();
    await userEvent.click(pin);
    expect(api.saveBrief).toHaveBeenCalledTimes(1);
    resolve(brief);
  });

  it('shows a pinned suggestion as pinned', async () => {
    show(
      {},
      {
        brief: {
          ...brief,
          body: {
            ...EMPTY_BRIEF,
            ontologies: [{ ontologyId: 'idmp', version: 2, role: 'vocabulary' }],
          },
        },
      },
    );
    expect(await screen.findByText('Pinned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin IDMP-O v2' })).toBeNull();
  });

  it('offers a stale refresh and polls while it runs', async () => {
    const getOntologySuggestions = vi
      .fn()
      .mockResolvedValueOnce(view({ stale: 'library' }))
      .mockResolvedValueOnce(view({ running: true }))
      .mockResolvedValue(view());
    const { api } = show({
      getOntologySuggestions,
      refreshOntologySuggestions: vi.fn(async () => view({ running: true })),
    });
    expect(await screen.findByText(/library changed since these suggestions/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh suggestions' }));
    expect(api.refreshOntologySuggestions).toHaveBeenCalledWith('letter');
    await waitFor(() => expect(getOntologySuggestions.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('shows a failed refresh', async () => {
    show({ getOntologySuggestions: vi.fn(async () => view({ failed: 'index down' })) });
    expect(await screen.findByRole('alert')).toHaveTextContent('index down');
  });

  it('asks for a survey when there is none', async () => {
    show(
      { getOntologySuggestions: vi.fn(async () => view({ record: null })) },
      { hasSurvey: false },
    );
    expect(await screen.findByText('Run the survey to get suggestions.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh suggestions' })).toBeNull();
  });

  it('disables Pin and Refresh for a retired type', async () => {
    show(
      { getOntologySuggestions: vi.fn(async () => view({ stale: 'library' })) },
      { retired: 'Letter is retired' },
    );
    expect(await screen.findByRole('button', { name: 'Pin IDMP-O v2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh suggestions' })).toBeDisabled();
  });

  it('keeps the manual picker, saving a removal straight away', async () => {
    const pinned = {
      ...brief,
      body: {
        ...EMPTY_BRIEF,
        ontologies: [{ ontologyId: 'qudt', version: 1, role: 'vocabulary' as const }],
      },
    };
    const { api } = show({ saveBrief: vi.fn(async () => pinned) }, { brief: pinned });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove qudt v1' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...pinned.body, ontologies: [] });
  });

  it('saves mapping guidance with its own button', async () => {
    const { api } = show({ saveBrief: vi.fn(async () => brief) });
    await userEvent.type(await screen.findByLabelText('Guidance for the mapping'), 'Prefer IDMP-O');
    await userEvent.click(screen.getByRole('button', { name: 'Save guidance' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', {
      ...brief.body,
      ontologyGuidance: 'Prefer IDMP-O',
    });
  });
});

// The manual picker, moved here from the Brief tab: each change is saved into the brief at once.
describe('SurveyOntologies manual picker (moved from the Brief)', () => {
  const summary = (id: string, latest: number, localOnly = false) =>
    ({
      id,
      label: id === 'acme' ? 'Acme terms' : 'Pharma',
      localOnly,
      latest: { version: latest, status: 'ready' },
    }) as unknown as Awaited<ReturnType<Api['listOntologies']>>[number];
  const detail = {
    id: 'acme',
    label: 'Acme terms',
    versions: [
      { version: 2, status: 'failed' },
      { version: 1, status: 'ready' },
    ],
  } as unknown as Awaited<ReturnType<Api['getOntology']>>;
  const none = vi.fn(async () => view({ record: null }));

  it('adds an ontology with a ready version and a role, saving it straight away', async () => {
    const saveBrief = vi.fn(async (_id: string, body: BriefBody) => ({ ...brief, body }));
    show({
      getOntologySuggestions: none,
      listOntologies: vi.fn(async () => [summary('acme', 2)]),
      getOntology: vi.fn(async () => detail),
      saveBrief,
    } as Partial<Api>);
    const section = await screen.findByRole('region', { name: 'Ontologies' });
    const picker = within(section).getByRole('region', { name: 'Pinned ontologies' });
    await userEvent.selectOptions(await within(picker).findByLabelText('Ontology'), 'acme');
    const versionSelect = await within(picker).findByLabelText('Version');
    expect(within(versionSelect).queryByRole('option', { name: 'v2' })).toBeNull();
    await userEvent.selectOptions(versionSelect, '1');
    await userEvent.selectOptions(within(picker).getByLabelText('Role'), 'shapes');
    await userEvent.click(within(picker).getByRole('button', { name: 'Add ontology' }));
    expect(saveBrief.mock.calls[0]![1]).toMatchObject({
      ontologies: [{ ontologyId: 'acme', version: 1, role: 'shapes' }],
    });
  });

  it('says when a newer ready version exists, and moves the pick to it', async () => {
    const pinned = {
      ...brief,
      body: {
        ...EMPTY_BRIEF,
        ontologies: [{ ontologyId: 'acme', version: 1, role: 'vocabulary' as const }],
      },
    };
    const saveBrief = vi.fn(async (_id: string, body: BriefBody) => ({ ...pinned, body }));
    show(
      {
        getOntologySuggestions: none,
        listOntologies: vi.fn(async () => [summary('acme', 3)]),
        saveBrief,
      } as Partial<Api>,
      { brief: pinned },
    );
    const pick = await screen.findByRole('listitem', { name: 'acme v1' });
    expect(pick).toHaveTextContent('Update available: v3');
    await userEvent.click(within(pick).getByRole('button', { name: 'Use v3' }));
    expect(saveBrief.mock.calls[0]![1].ontologies).toEqual([
      { ontologyId: 'acme', version: 3, role: 'vocabulary' },
    ]);
  });

  it('notes that a local-only ontology keeps mapping on local models', async () => {
    show(
      {
        getOntologySuggestions: none,
        listOntologies: vi.fn(async () => [summary('pharma', 1, true)]),
      } as Partial<Api>,
      {
        dataPolicy: 'external',
        brief: {
          ...brief,
          body: {
            ...EMPTY_BRIEF,
            ontologies: [{ ontologyId: 'pharma', version: 1, role: 'vocabulary' }],
          },
        },
      },
    );
    expect(await screen.findByText(/mapping will use local models/)).toBeTruthy();
  });
});
