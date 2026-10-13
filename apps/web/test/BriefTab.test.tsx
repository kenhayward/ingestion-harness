import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_BRIEF,
  type Brief,
  type BriefBody,
  type BriefVersionView,
  type OverviewItem,
} from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { BriefTab } from '../src/workbench/BriefTab.js';
import { fakeApi, proposalView } from './fake-api.js';

const item: OverviewItem = { stage: 'brief', state: 'accepted', status: 'Saved v2', metrics: [] };
const brief = (version: number, body: Partial<BriefBody> = {}): Brief => ({
  projectId: 'letter',
  version,
  body: { ...EMPTY_BRIEF, ...body },
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
});
const version = (v: number, o: Partial<BriefVersionView> = {}): BriefVersionView => ({
  version: v,
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  changedSections: [],
  usedBy: [],
  ...o,
});
const show = (
  api: Api,
  current: Brief | null,
  more: { onSaved?: () => void; onNavigate?: () => void } = {},
) =>
  render(
    <BriefTab
      api={api}
      projectId="letter"
      brief={current}
      item={item}
      onSaved={more.onSaved ?? vi.fn()}
      onNavigate={more.onNavigate ?? vi.fn()}
    />,
  );

describe('BriefTab', () => {
  it('starts from the latest version with its status line', async () => {
    show(fakeApi(), brief(2, { rules: 'Dates are DMY' }));
    expect(screen.getByLabelText('Rules')).toHaveValue('Dates are DMY');
    const header = screen.getByRole('heading', { level: 2, name: 'Brief' }).closest('header')!;
    expect(header).toHaveTextContent('Saved as v2 · 2 days ago');
    expect(within(header).queryByRole('button', { name: /Save as/ })).toBeNull();
  });

  it('shows the unsaved bar, the edited tag and the changed count; Discard restores', async () => {
    show(fakeApi(), brief(2, { purpose: 'Invoices' }));
    await userEvent.type(screen.getByLabelText('Glossary'), 'PO');
    const header = screen.getByRole('heading', { level: 2, name: 'Brief' }).closest('header')!;
    expect(header).toHaveTextContent('Saved as v2 · 2 days ago · 1 field changed since');
    expect(header).toHaveTextContent('Unsaved changes');
    const glossary = screen.getByLabelText('Glossary').closest('section')!;
    expect(glossary).toHaveTextContent('edited');
    expect(glossary).toHaveTextContent('2 chars');
    expect(screen.getByLabelText('Purpose').closest('section')).not.toHaveTextContent('edited');

    await userEvent.click(within(header).getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Glossary')).toHaveValue('');
    expect(within(header).queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('saves the brief as the next version, keeping the survey answers', async () => {
    const answers = [{ question: 'Which copy?', answer: 'Executed' }];
    const saved = brief(3, { purpose: 'QA', answers });
    const onSaved = vi.fn();
    const api = fakeApi({ saveBrief: vi.fn(async () => saved) });
    show(api, brief(2, { answers }), { onSaved });
    await userEvent.type(screen.getByLabelText('Purpose'), 'QA');
    await userEvent.click(screen.getByRole('button', { name: 'Save as v3' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', {
      ...EMPTY_BRIEF,
      purpose: 'QA',
      answers,
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as v3');
    expect(api.listBriefVersions).toHaveBeenCalledTimes(2); // reloaded after the save
  });

  it('shows a save error and keeps the edit and the Save button', async () => {
    const api = fakeApi({
      saveBrief: vi.fn(async () => {
        throw new Error('brief too large');
      }),
    });
    const onSaved = vi.fn();
    show(api, brief(2), { onSaved });
    await userEvent.type(screen.getByLabelText('Purpose'), 'QA');
    await userEvent.click(screen.getByRole('button', { name: 'Save as v3' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('brief too large');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Purpose')).toHaveValue('QA');
    expect(screen.getByRole('button', { name: 'Save as v3' })).toBeEnabled();
  });

  it('clears "Saved as vN" once the brief is edited again', async () => {
    const api = fakeApi({ saveBrief: vi.fn(async () => brief(3, { purpose: 'QA' })) });
    show(api, brief(2));
    await userEvent.type(screen.getByLabelText('Purpose'), 'QA');
    await userEvent.click(screen.getByRole('button', { name: 'Save as v3' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as v3');
    await userEvent.type(screen.getByLabelText('Rules'), 'x');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says in the Versions card when the versions cannot be loaded', async () => {
    const api = fakeApi({
      listBriefVersions: vi.fn(async () => {
        throw new Error('versions down');
      }),
    });
    show(api, brief(2));
    const card = screen.getByRole('region', { name: 'Versions' });
    expect(await within(card).findByText(/versions down/)).toBeInTheDocument();
    expect(card).not.toHaveTextContent('Loading…');
  });

  it('offers Save as v1 for a project without a brief', async () => {
    show(fakeApi(), null);
    await userEvent.type(screen.getByLabelText('Purpose'), 'x');
    expect(screen.getByRole('button', { name: 'Save as v1' })).toBeEnabled();
  });

  it('jumps to a section from the nav, marking empty sections in words', async () => {
    show(fakeApi(), brief(1, { purpose: 'Invoices' }));
    const nav = screen.getByRole('navigation', { name: 'Brief sections' });
    expect(within(nav).getByRole('button', { name: 'Purpose' })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('button', { name: 'Glossary (empty)' }));
    expect(screen.getByLabelText('Glossary')).toHaveFocus();
    expect(within(nav).getByRole('button', { name: /Survey answers · 0/ })).toBeInTheDocument();
  });

  it('previews the example output as a table', async () => {
    show(
      fakeApi(),
      brief(1, {
        exampleOutput:
          'invoice,description,amount\nINV-1,"Nitrile gloves, M (100)",85.00\nINV-1,Tips,125.00',
      }),
    );
    expect(screen.getByText('Preview · 2 rows × 3 columns')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Example output preview' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['invoice', 'description', 'amount']);
    expect(table).toHaveTextContent('Nitrile gloves, M (100)');
  });

  it('lists saved survey answers read-only', async () => {
    show(fakeApi(), brief(1, { answers: [{ question: 'Which copy?', answer: 'Executed' }] }));
    const card = screen.getByRole('region', { name: 'Survey answers' });
    expect(card).toHaveTextContent('Which copy?');
    expect(card).toHaveTextContent('Executed');
    expect(within(card).queryByRole('textbox')).toBeNull();
  });

  it('links an empty survey answers card to Survey with the open questions', async () => {
    const onNavigate = vi.fn();
    const survey = proposalView({
      stage: 'survey',
      status: 'ready',
      body: {
        summary: '',
        structure: [],
        variants: [],
        candidates: [],
        questions: [
          { question: 'Which copy?', why: '' },
          { question: 'Dates?', why: '' },
        ],
      },
    });
    show(fakeApi({ listProposals: vi.fn(async () => [survey]) }), brief(1), { onNavigate });
    const card = screen.getByRole('region', { name: 'Survey answers' });
    expect(await within(card).findByText(/the Survey has 2 open questions/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Open Survey' }));
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter/survey');
  });

  it('lists versions with CURRENT, used-by tags and what changed', async () => {
    const api = fakeApi({
      listBriefVersions: vi.fn(async () => [
        version(3, { changedSections: ['variants', 'rules'] }),
        version(2, { changedSections: ['exampleOutput'], usedBy: ['outputs'] }),
        version(1, { changedSections: ['purpose'] }),
      ]),
    });
    show(api, brief(3));
    const list = await screen.findByRole('list', { name: 'Versions' });
    const v3 = within(list).getByRole('listitem', { name: 'v3' });
    expect(v3).toHaveTextContent('CURRENT');
    expect(v3).toHaveTextContent('Variants, rules');
    const v2 = within(list).getByRole('listitem', { name: 'v2' });
    expect(v2).toHaveTextContent('used by Outputs');
    expect(v2).not.toHaveTextContent('CURRENT');
    expect(within(list).getByRole('listitem', { name: 'v1' })).toHaveTextContent('First brief');
  });

  it('compares an older version with the current one, section by section', async () => {
    const versions = [version(2, { changedSections: ['glossary'] }), version(1)];
    const bodies: Record<number, Brief> = {
      1: brief(1, { purpose: 'Invoices' }),
      2: brief(2, { purpose: 'Invoices', glossary: 'PO: purchase order' }),
    };
    const api = fakeApi({
      listBriefVersions: vi.fn(async () => versions),
      getBriefVersion: vi.fn(async (_p: string, v: number) => bodies[v]!),
    });
    show(api, bodies[2]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Compare v1' }));
    expect(api.getBriefVersion).toHaveBeenCalledWith('letter', 1);
    expect(api.getBriefVersion).toHaveBeenCalledWith('letter', 2);
    const panel = await screen.findByRole('region', { name: 'Compare v1 with v2' });
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Glossary—PO: purchase order');
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Compare v1 with v2' })).toBeNull();
  });

  it('disables Compare with a reason when there is one version', async () => {
    show(fakeApi({ listBriefVersions: vi.fn(async () => [version(1)]) }), brief(1));
    const compare = await screen.findByRole('button', { name: 'Compare v1' });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute('title', 'Nothing to compare yet');
  });

  it('renders the side panel it is given', async () => {
    render(
      <BriefTab
        api={fakeApi()}
        projectId="letter"
        brief={null}
        item={null}
        onSaved={vi.fn()}
        onNavigate={vi.fn()}
        aside={<p>bundle here</p>}
      />,
    );
    expect(screen.getByText('bundle here')).toBeInTheDocument();
  });
});
