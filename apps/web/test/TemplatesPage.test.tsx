import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateListItem } from '../src/api/client.js';
import { TemplatesPage } from '../src/templates/TemplatesPage.js';
import { fakeApi, templateView } from './fake-api.js';

const summary = {
  sections: 5,
  fields: 9,
  tables: 1,
  references: 3,
  draftIssues: 0,
  lastRegression: { version: 4, matched: 3, total: 3, at: '2026-10-12T10:00:00Z' },
  regressionRunning: false,
};

const list: TemplateListItem[] = [
  {
    id: 'pvp',
    name: 'Process Validation Protocol',
    description: null,
    published: 3,
    draft: 4,
    retired: null,
    versions: [],
    summary,
  },
  {
    id: 'coa',
    name: 'Certificate of analysis',
    description: null,
    published: 2,
    draft: null,
    retired: null,
    versions: [],
    summary: { ...summary, references: 0, draftIssues: null, lastRegression: null },
  },
];

const card = (name: string) => screen.getByRole('article', { name });
const pdf = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

function setup(overrides = {}) {
  const onNavigate = vi.fn();
  const api = fakeApi({ listTemplates: vi.fn(async () => list), ...overrides });
  render(<TemplatesPage api={api} onNavigate={onNavigate} />);
  return { api, onNavigate };
}

describe('TemplatesPage cards', () => {
  it('has a header and a card per document type', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1, name: 'Document types' })).toBeInTheDocument();
    expect(
      screen.getByText(/Published versions are immutable; edit a draft\./),
    ).toBeInTheDocument();
    const pvp = await screen.findByRole('article', { name: 'Process Validation Protocol' });
    expect(within(pvp).getByText('pvp')).toBeInTheDocument();
    expect(within(pvp).getByRole('link', { name: 'Published v3' })).toHaveAttribute(
      'href',
      '#/templates/pvp/3',
    );
    expect(within(pvp).getByText('Draft v4')).toBeInTheDocument();
    expect(within(pvp).getByText('5 sections · 9 fields · 1 table')).toBeInTheDocument();
    expect(within(pvp).getByText('Regression: 3 of 3 references match')).toBeInTheDocument();
    expect(within(pvp).getByRole('link', { name: 'Edit draft v4' })).toHaveAttribute(
      'href',
      '#/templates/pvp/4',
    );
    expect(
      within(pvp).getByRole('link', { name: 'Export Process Validation Protocol YAML' }),
    ).toHaveAttribute('href', '/api/templates/pvp/versions/4/export');
  });

  it('offers a new draft for a published-only type', async () => {
    const { api, onNavigate } = setup({
      newDraft: vi.fn(async () => templateView({ id: 'coa', version: 3 })),
    });
    const coa = await screen.findByRole('article', { name: 'Certificate of analysis' });
    expect(within(coa).getByText('No reference documents yet')).toBeInTheDocument();
    expect(within(coa).queryByText(/^Draft v/)).not.toBeInTheDocument();
    await userEvent.click(within(coa).getByRole('button', { name: 'New draft from v2' }));
    expect(api.newDraft).toHaveBeenCalledWith('coa', 2);
    expect(onNavigate).toHaveBeenCalledWith('#/templates/coa/3');
  });

  it('test-runs a PDF on the version shown', async () => {
    const { api } = setup();
    await screen.findByRole('article', { name: 'Process Validation Protocol' });
    const file = pdf('sample.pdf');
    await userEvent.upload(
      within(card('Process Validation Protocol')).getByLabelText(
        'Test run Process Validation Protocol with a PDF or Word document',
      ),
      file,
    );
    const dialog = screen.getByRole('dialog', { name: 'Test run Process Validation Protocol v4' });
    expect(dialog).toHaveTextContent('Runs sample.pdf through v4');
    expect(api.testRun).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run test' }));
    expect(api.testRun).toHaveBeenCalledWith(file, 'pvp', 4, null);
    expect(
      await within(card('Process Validation Protocol')).findByRole('status'),
    ).toHaveTextContent('Test run queued — see Jobs');
  });

  it('test-runs a Word document', async () => {
    const { api } = setup();
    await screen.findByRole('article', { name: 'Process Validation Protocol' });
    const word = new File(['PK'], 'protocol.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await userEvent.upload(
      within(card('Process Validation Protocol')).getByLabelText(
        'Test run Process Validation Protocol with a PDF or Word document',
      ),
      word,
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Run test' }),
    );
    expect(api.testRun).toHaveBeenCalledWith(word, 'pvp', 4, null);
  });

  it('sends nothing when no file or a non-PDF is chosen', async () => {
    const { api } = setup();
    await screen.findByRole('article', { name: 'Certificate of analysis' });
    const input = within(card('Certificate of analysis')).getByLabelText(
      'Test run Certificate of analysis with a PDF or Word document',
    );
    fireEvent.change(input, { target: { files: [] } });
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    expect(api.testRun).not.toHaveBeenCalled();
    expect(within(card('Certificate of analysis')).getByRole('status')).toHaveTextContent(
      'Choose a PDF or Word document',
    );
  });

  it('links each document type to its workbench project', async () => {
    const api = fakeApi({ listTemplates: vi.fn(async () => list) });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} />);
    await screen.findByRole('article', { name: 'Process Validation Protocol' });
    for (const [name, id] of [
      ['Process Validation Protocol', 'pvp'],
      ['Certificate of analysis', 'coa'],
    ] as const) {
      expect(within(card(name)).getByRole('link', { name: 'Open in workbench' })).toHaveAttribute(
        'href',
        `#/workbench/${id}`,
      );
    }
  });

  it('filters cards with the top-bar search', async () => {
    const api = fakeApi({ listTemplates: vi.fn(async () => list) });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} query="certificate" />);
    expect(
      await screen.findByRole('article', { name: 'Certificate of analysis' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: 'Process Validation Protocol' }),
    ).not.toBeInTheDocument();
  });
});

describe('TemplatesPage dialogs', () => {
  it('creates a document type and opens its v1 draft', async () => {
    const { api, onNavigate } = setup({ listTemplates: vi.fn(async () => []) });
    await userEvent.click(screen.getByRole('button', { name: 'New document type' }));
    const dialog = screen.getByRole('dialog', { name: 'New document type' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'letter');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Letter');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(api.createTemplate).toHaveBeenCalledWith('letter', 'Letter');
    expect(onNavigate).toHaveBeenCalledWith('#/templates/letter/1');
  });

  it('imports YAML, optionally publishing it', async () => {
    const { api, onNavigate } = setup({ listTemplates: vi.fn(async () => []) });
    await userEvent.click(screen.getByRole('button', { name: 'Import YAML' }));
    const dialog = screen.getByRole('dialog', { name: 'Import YAML' });
    await userEvent.type(within(dialog).getByLabelText('Recipe YAML'), 'id: memo');
    await userEvent.click(within(dialog).getByLabelText('Publish if valid'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(api.importTemplate).toHaveBeenCalledWith('id: memo', true);
    expect(onNavigate).toHaveBeenCalledWith('#/templates/memo/4');
  });

  it('shows an error inside the dialog and keeps it open', async () => {
    setup({
      listTemplates: vi.fn(async () => []),
      createTemplate: vi.fn(async () => {
        throw new Error('document type letter already exists');
      }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'New document type' }));
    const dialog = screen.getByRole('dialog', { name: 'New document type' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'letter');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Letter');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
  });
});
