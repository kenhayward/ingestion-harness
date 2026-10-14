import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Semantics } from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { MappingEditor } from '../src/templates/MappingEditor.js';
import { fakeApi } from './fake-api.js';

const A = 'https://acme.example/def/';
const definition = {
  id: 'letter',
  version: 1,
  outputs: {
    fields: [
      { id: 'sender', type: 'text' },
      { id: 'kind', type: 'enum', enum: ['memo', 'letter'] },
    ],
    tables: [{ id: 'lines', columns: [{ id: 'sku', type: 'text' }] }],
  },
};
const mapped: Semantics = {
  ontologies: [{ id: 'acme', version: 1 }],
  shapes: [],
  prefixes: { acme: A },
  document: { class: 'acme:Letter', iri: 'doc/{source}' },
  fields: {},
  tables: {},
  local: [],
};

/** The editor with its value held like TemplateEditor holds it; `last()` is the newest value. */
function setup(
  initial: Semantics | undefined,
  api: Api = fakeApi(),
  preview?: { projectId: string },
) {
  const changes: (Semantics | undefined)[] = [];
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <MappingEditor
        api={api}
        definition={definition}
        semantics={value}
        preview={preview}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Host />);
  return { api, last: () => changes.at(-1) };
}

describe('MappingEditor', () => {
  it('starts and removes a mapping', async () => {
    const { last } = setup(undefined);
    await userEvent.click(screen.getByRole('button', { name: 'Map to ontologies' }));
    expect(last()).toEqual({
      ontologies: [],
      shapes: [],
      prefixes: {},
      document: { class: '', iri: 'doc/{source}' },
      fields: {},
      tables: {},
      local: [],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove the mapping' }));
    expect(last()).toBeUndefined();
  });

  it('pins a ready version of a library ontology', async () => {
    const api = fakeApi({
      listOntologies: vi.fn(async () => [
        { id: 'acme', label: 'Acme terms' } as Awaited<ReturnType<Api['listOntologies']>>[number],
      ]),
      getOntology: vi.fn(async () => ({
        id: 'acme',
        label: 'Acme terms',
        versions: [
          { version: 2, status: 'failed' },
          { version: 1, status: 'ready' },
        ],
      })) as unknown as Api['getOntology'],
    });
    const { last } = setup({ ...mapped, ontologies: [] }, api);
    const pins = screen.getByRole('region', { name: 'Ontologies' });
    await userEvent.selectOptions(await within(pins).findByLabelText('Ontology'), 'acme');
    const version = await within(pins).findByLabelText('Version');
    expect(within(version).queryByRole('option', { name: 'v2' })).toBeNull();
    await userEvent.selectOptions(version, '1');
    await userEvent.click(within(pins).getByRole('button', { name: 'Pin' }));
    expect(last()?.ontologies).toEqual([{ id: 'acme', version: 1 }]);
  });

  it('maps a field to a property found with the term picker', async () => {
    const listOntologyTerms = vi.fn(async () => ({
      items: [{ iri: `${A}sentBy`, kind: 'object_property', label: 'sent by' }] as Awaited<
        ReturnType<Api['listOntologyTerms']>
      >['items'],
      total: 1,
      offset: 0,
      limit: 20,
    }));
    const { last } = setup(mapped, fakeApi({ listOntologyTerms }));
    const row = screen.getByRole('group', { name: 'sender' });
    await userEvent.click(within(row).getByRole('button', { name: 'Find a property' }));
    const dialog = await screen.findByRole('dialog', { name: 'Find a property' });
    await userEvent.type(within(dialog).getByLabelText('Search'), 'sent');
    await userEvent.click(await within(dialog).findByRole('button', { name: /sent by/ }));
    expect(listOntologyTerms).toHaveBeenLastCalledWith('acme', 1, {
      q: 'sent',
      group: 'properties',
      limit: 20,
    });
    expect(last()?.fields.sender).toEqual({ property: 'acme:sentBy' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('makes a field an entity with a readable IRI, or a concept per value', async () => {
    const { last } = setup({ ...mapped, fields: { sender: { property: 'acme:sentBy' } } });
    const sender = screen.getByRole('group', { name: 'sender' });
    await userEvent.selectOptions(within(sender).getByLabelText('Value as'), 'entity');
    expect(last()?.fields.sender).toEqual({
      property: 'acme:sentBy',
      object: { class: '', iri: 'sender/{value|slug}' },
    });

    const kind = screen.getByRole('group', { name: 'kind' });
    await userEvent.type(within(kind).getByLabelText('Property'), 'acme:kind');
    await userEvent.selectOptions(within(kind).getByLabelText('Value as'), 'concept');
    await userEvent.type(within(kind).getByLabelText('Concept for memo'), 'acme:Memo');
    expect(last()?.fields.kind).toEqual({
      property: 'acme:kind',
      concepts: { values: { memo: 'acme:Memo' } },
    });
  });

  it('maps a table: its link, row class and columns', async () => {
    const { last } = setup(mapped);
    const lines = screen.getByRole('group', { name: 'Table lines' });
    await userEvent.type(within(lines).getByLabelText('Link from the document'), 'acme:hasLine');
    await userEvent.type(within(lines).getByLabelText('Row class'), 'acme:Line');
    await userEvent.type(
      within(within(lines).getByRole('group', { name: 'lines.sku' })).getByLabelText('Property'),
      'acme:sku',
    );
    expect(last()?.tables.lines).toEqual({
      link: 'acme:hasLine',
      class: 'acme:Line',
      columns: { sku: { property: 'acme:sku' } },
    });
  });

  it('previews the graph of a dev sample', async () => {
    const startGraphPreview = vi.fn(async () => ({
      jobId: 'g1',
      status: 'queued' as const,
      error: null,
      result: null,
    }));
    const getGraphPreview = vi.fn(async () => ({
      jobId: 'g1',
      status: 'succeeded' as const,
      error: null,
      result: {
        samples: [
          { sampleId: 's1', fileName: 's1.pdf', turtle: '<a> <b> <c> .', triples: 1, report: null },
        ],
      },
    }));
    setup(mapped, fakeApi({ startGraphPreview, getGraphPreview }), { projectId: 'letter' });
    await userEvent.click(screen.getByRole('button', { name: 'Preview on dev samples' }));
    expect(startGraphPreview).toHaveBeenCalledWith('letter');
    await waitFor(() => expect(screen.getByText('<a> <b> <c> .')).toBeTruthy());
    expect(screen.getByText(/s1\.pdf · 1 triple/)).toBeTruthy();
  });

  it('shows why a preview could not start', async () => {
    const startGraphPreview = vi.fn(async () => {
      throw new Error('set the customer on the Linked data page');
    });
    setup(mapped, fakeApi({ startGraphPreview }), { projectId: 'letter' });
    await userEvent.click(screen.getByRole('button', { name: 'Preview on dev samples' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'set the customer on the Linked data page',
    );
  });
});

describe('MappingEditor prefixes', () => {
  it('never overwrites a namespace when adding a prefix after removing one', async () => {
    const { last } = setup({ ...mapped, prefixes: {} });
    const add = () => userEvent.click(screen.getByRole('button', { name: 'Add a prefix' }));
    await add();
    await add();
    const namespaces = () => screen.getAllByLabelText('Namespace');
    await userEvent.type(namespaces()[1]!, 'https://two.example/');
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove prefix' })[0]!);
    await add();
    expect(last()?.prefixes).toEqual({ p2: 'https://two.example/', p1: '' });
  });

  it('keeps both rows while a prefix repeats another, and says so', async () => {
    const { last } = setup({
      ...mapped,
      prefixes: { ex: 'https://ex.example/', ey: 'https://ey.example/' },
    });
    const second = screen.getAllByLabelText('Prefix')[1]!;
    await userEvent.clear(second);
    await userEvent.type(second, 'ex');
    expect(screen.getAllByLabelText('Namespace')).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('Each prefix must be unique and not empty');
    // Nothing invalid is written: the last good set stands until the clash is fixed.
    expect(last()?.prefixes).toEqual({ ex: 'https://ex.example/', e: 'https://ey.example/' });
    await userEvent.type(second, '2');
    expect(last()?.prefixes).toEqual({ ex: 'https://ex.example/', ex2: 'https://ey.example/' });
  });
});

describe('MappingEditor shapes (ADR 0011 step 5)', () => {
  it('pins a ready version as the shapes the graph is checked against', async () => {
    const api = fakeApi({
      listOntologies: vi.fn(async () => [
        { id: 'acme-shapes', label: 'Acme shapes' } as Awaited<
          ReturnType<Api['listOntologies']>
        >[number],
      ]),
      getOntology: vi.fn(async () => ({
        id: 'acme-shapes',
        label: 'Acme shapes',
        versions: [{ version: 1, status: 'ready' }],
      })) as unknown as Api['getOntology'],
    });
    const { last } = setup(mapped, api);
    const shapes = screen.getByRole('region', { name: 'Shapes' });
    await userEvent.selectOptions(await within(shapes).findByLabelText('Ontology'), 'acme-shapes');
    await userEvent.selectOptions(await within(shapes).findByLabelText('Version'), '1');
    await userEvent.click(within(shapes).getByRole('button', { name: 'Pin' }));
    expect(last()?.shapes).toEqual([{ id: 'acme-shapes', version: 1 }]);
  });

  it('shows each previewed sample violations', async () => {
    const report = {
      conforms: false,
      results: [
        {
          severity: 'Violation' as const,
          shape: 'https://a/S',
          focus: 'https://d/x',
          path: 'https://a/p',
          output: 'sender',
          message: 'a letter names its sender',
          value: '',
        },
      ],
    };
    const startGraphPreview = vi.fn(async () => ({
      jobId: 'g1',
      status: 'queued' as const,
      error: null,
      result: null,
    }));
    const getGraphPreview = vi.fn(async () => ({
      jobId: 'g1',
      status: 'succeeded' as const,
      error: null,
      result: { samples: [{ sampleId: 's1', fileName: 's1.pdf', turtle: '', triples: 0, report }] },
    }));
    setup(mapped, fakeApi({ startGraphPreview, getGraphPreview }), { projectId: 'letter' });
    await userEvent.click(screen.getByRole('button', { name: 'Preview on dev samples' }));
    expect(await screen.findByText(/1 violation/)).toBeInTheDocument();
    expect(screen.getByText(/sender: a letter names its sender/)).toBeInTheDocument();
  });
});
