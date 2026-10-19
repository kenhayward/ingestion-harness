import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Semantics, TermLabel } from '@ih/shared';
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
  readOnly?: boolean,
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
        readOnly={readOnly}
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

/** Opens an item of the outline (Ontologies, a field id, `Table lines`, `lines.sku`, …). */
const open = (name: string) =>
  userEvent.click(
    within(screen.getByRole('navigation', { name: 'Mapping outline' })).getByRole('button', {
      name,
    }),
  );

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
    await open('sender');
    const row = screen.getByRole('group', { name: 'sender' });
    await userEvent.click(within(row).getByRole('button', { name: 'Find a property' }));
    // The search opens under the field, not in a dialog.
    expect(screen.queryByRole('dialog')).toBeNull();
    const search = within(row).getByRole('group', { name: 'Find a property' });
    await userEvent.type(within(search).getByLabelText('Search'), 'sent');
    await userEvent.click(await within(search).findByRole('button', { name: /sent by/ }));
    expect(listOntologyTerms).toHaveBeenLastCalledWith('acme', 1, {
      q: 'sent',
      group: 'properties',
      limit: 20,
    });
    expect(last()?.fields.sender).toEqual({ property: 'acme:sentBy' });
    expect(within(row).queryByRole('group', { name: 'Find a property' })).toBeNull();
  });

  it('makes a field an entity with a readable IRI, or a concept per value', async () => {
    const { last } = setup({ ...mapped, fields: { sender: { property: 'acme:sentBy' } } });
    await open('sender');
    const sender = screen.getByRole('group', { name: 'sender' });
    const valueAs = within(sender).getByRole('group', { name: 'Value as' });
    await userEvent.click(within(valueAs).getByRole('button', { name: 'Entity' }));
    expect(within(valueAs).getByRole('button', { name: 'Entity' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(last()?.fields.sender).toEqual({
      property: 'acme:sentBy',
      object: { class: '', iri: 'sender/{value|slug}' },
    });

    await open('kind');
    const kind = screen.getByRole('group', { name: 'kind' });
    await userEvent.type(within(kind).getByLabelText('Property'), 'acme:kind');
    await userEvent.click(
      within(within(kind).getByRole('group', { name: 'Value as' })).getByRole('button', {
        name: 'Concept',
      }),
    );
    await userEvent.type(within(kind).getByLabelText('Concept for memo'), 'acme:Memo');
    expect(last()?.fields.kind).toEqual({
      property: 'acme:kind',
      concepts: { values: { memo: 'acme:Memo' } },
    });
  });

  it('maps a table: its link, row class and columns', async () => {
    const { last } = setup(mapped);
    await open('Table lines');
    const lines = screen.getByRole('group', { name: 'Table lines' });
    await userEvent.type(within(lines).getByLabelText('Link from the document'), 'acme:hasLine');
    await userEvent.type(within(lines).getByLabelText('Row class'), 'acme:Line');
    await open('lines.sku');
    await userEvent.type(
      within(screen.getByRole('group', { name: 'lines.sku' })).getByLabelText('Property'),
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
          {
            sampleId: 's1',
            fileName: 's1.pdf',
            turtle: `<https://d/doc/s1> a <${A}Letter> ; <${A}sentBy> "Ünïcorn" .`,
            triples: 2,
            report: null,
          },
        ],
      },
    }));
    const api = fakeApi({ startGraphPreview, getGraphPreview });
    setup(mapped, api, { projectId: 'letter' });
    await open('Preview');
    await userEvent.click(screen.getByRole('button', { name: 'Preview on dev samples' }));
    expect(startGraphPreview).toHaveBeenCalledWith('letter');
    expect(await screen.findByText(/s1\.pdf · 2 triples/)).toBeTruthy();
    // Each sample's graph reads as cards, named with the mapping's own pins.
    const card = await screen.findByRole('article', { name: 'Letter s1' });
    expect(
      within(card).getByRole('rowheader', { name: 'Sent by' }).closest('tr'),
    ).toHaveTextContent('Ünïcorn');
    await waitFor(() =>
      expect(api.termLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          ontologies: [{ id: 'acme', version: 1 }],
          terms: expect.arrayContaining([`${A}Letter`, `${A}sentBy`]),
        }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Turtle' }));
    expect(screen.getByText(/<https:\/\/d\/doc\/s1> a/)).toBeInTheDocument();
  });

  it('shows why a preview could not start', async () => {
    const startGraphPreview = vi.fn(async () => {
      throw new Error('set the customer under Administration > Linked data');
    });
    setup(mapped, fakeApi({ startGraphPreview }), { projectId: 'letter' });
    await open('Preview');
    await userEvent.click(screen.getByRole('button', { name: 'Preview on dev samples' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'set the customer under Administration > Linked data',
    );
  });
});

describe('MappingEditor outline (option B)', () => {
  const partly: Semantics = {
    ...mapped,
    fields: {
      sender: { property: 'acme:sentBy' },
      kind: { property: 'acme:kind', concepts: { values: { memo: 'acme:Memo' } } },
    },
  };

  it('lists the setup, every field and every table column with how far each is mapped', async () => {
    setup(partly);
    const outline = screen.getByRole('navigation', { name: 'Mapping outline' });
    const names = within(outline)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'Ontologies',
      'Shapes',
      'Prefixes',
      'Document',
      'Value nodes',
      'sender',
      'kind',
      'Table lines',
      'lines.sku',
      'Local terms',
    ]);
    const item = (name: string) => within(outline).getByRole('button', { name });
    expect(item('sender')).toHaveAccessibleDescription('acme:sentBy (mapped)');
    expect(item('kind')).toHaveAccessibleDescription('concept · 1 of 2 (needs attention)');
    expect(item('lines.sku')).toHaveAccessibleDescription('unmapped (not mapped)');
    expect(screen.getByRole('img', { name: '1 of 3 outputs mapped' })).toBeInTheDocument();
  });

  it('opens on the ontologies until one is pinned, then on the first output to finish', async () => {
    setup({ ...mapped, ontologies: [] });
    expect(screen.getByRole('region', { name: 'Ontologies' })).toBeInTheDocument();
  });

  it('opens on the first output not yet mapped and steps through the outline', async () => {
    setup(partly);
    expect(screen.getByRole('region', { name: 'kind' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Mapping outline' })).getByRole('button', {
        name: 'kind',
      }),
    ).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Next: Table lines' }));
    expect(screen.getByRole('region', { name: 'Table lines' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous: kind' }));
    expect(screen.getByRole('region', { name: 'kind' })).toBeInTheDocument();
  });

  it('stays on the item being edited when it becomes mapped', async () => {
    const { last } = setup(mapped);
    expect(screen.getByRole('region', { name: 'sender' })).toBeInTheDocument();
    await userEvent.type(
      within(screen.getByRole('group', { name: 'sender' })).getByLabelText('Property'),
      'acme:sentBy',
    );
    expect(last()?.fields.sender).toEqual({ property: 'acme:sentBy' });
    expect(screen.getByRole('region', { name: 'sender' })).toBeInTheDocument();
  });

  it('stays on the ontologies after pinning the first one', async () => {
    const api = fakeApi({
      listOntologies: vi.fn(async () => [
        { id: 'acme', label: 'Acme' } as Awaited<ReturnType<Api['listOntologies']>>[number],
      ]),
      getOntology: vi.fn(async () => ({
        id: 'acme',
        label: 'Acme',
        versions: [{ version: 1, status: 'ready' }],
      })) as unknown as Api['getOntology'],
    });
    const { last } = setup({ ...mapped, ontologies: [] }, api);
    const region = screen.getByRole('region', { name: 'Ontologies' });
    await userEvent.selectOptions(await within(region).findByLabelText('Ontology'), 'acme');
    await userEvent.selectOptions(await within(region).findByLabelText('Version'), '1');
    await userEvent.click(within(region).getByRole('button', { name: 'Pin' }));
    expect(last()?.ontologies).toEqual([{ id: 'acme', version: 1 }]);
    expect(screen.getByRole('region', { name: 'Ontologies' })).toBeInTheDocument();
  });

  it('can be browsed read-only: the outline and stepping work, editing does not', async () => {
    setup(mapped, fakeApi(), undefined, true);
    const outline = screen.getByRole('navigation', { name: 'Mapping outline' });
    for (const b of within(outline).getAllByRole('button')) expect(b).toBeEnabled();
    await open('kind');
    expect(
      within(screen.getByRole('group', { name: 'kind' })).getByLabelText('Property'),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next: Table lines' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove the mapping' })).toBeDisabled();
  });

  it('cannot start a mapping read-only', () => {
    setup(undefined, fakeApi(), undefined, true);
    expect(screen.getByRole('button', { name: 'Map to ontologies' })).toBeDisabled();
  });

  it('lists the preview only in the Workbench', async () => {
    setup(mapped, fakeApi(), { projectId: 'letter' });
    expect(
      within(screen.getByRole('navigation', { name: 'Mapping outline' })).getByRole('button', {
        name: 'Preview',
      }),
    ).toBeInTheDocument();
  });
});

describe('MappingEditor term labels', () => {
  const found = (label: string, iri: string): TermLabel => ({
    from: 'ontology',
    iri,
    label,
    kind: 'object_property',
    ontology: 'acme@1',
    deprecated: false,
    altLabels: [],
    definition: null,
  });
  const partly: Semantics = {
    ...mapped,
    fields: {
      sender: { property: 'acme:sentBy' },
      kind: { property: 'acme:kind', concepts: { values: { memo: 'acme:Memo' } } },
    },
    local: [{ iri: 'acme:Memo', kind: 'concept', label: 'Memo', definition: 'A short note.' }],
  };

  it('asks once for the name of every term the mapping uses', async () => {
    const termLabels = vi.fn(async () => ({ terms: {} }));
    setup(partly, fakeApi({ termLabels }));
    await waitFor(() => expect(termLabels).toHaveBeenCalledTimes(1));
    expect(termLabels).toHaveBeenCalledWith({
      ontologies: [{ id: 'acme', version: 1 }],
      prefixes: { acme: A },
      local: [{ iri: 'acme:Memo', label: 'Memo', definition: 'A short note.' }],
      terms: ['acme:Letter', 'acme:Memo', 'acme:kind', 'acme:sentBy'],
    });
  });

  it('shows each term by its name in the outline and under its field', async () => {
    const termLabels = vi.fn(async () => ({
      terms: {
        'acme:sentBy': {
          ...found('sent by', `${A}sentBy`),
          altLabels: ['sender', 'from'],
          definition: 'Who sent the letter.',
        },
        'acme:kind': { ...found('kind of letter', `${A}kind`), deprecated: true },
        'acme:Memo': {
          ...found('Memo', `${A}Memo`),
          from: 'local' as const,
          kind: null,
          ontology: null,
        },
        'acme:Letter': {
          ...found('', `${A}Letter`),
          from: 'unknown' as const,
          label: null,
          kind: null,
          ontology: null,
        },
      },
    }));
    setup(partly, fakeApi({ termLabels }));
    const outline = screen.getByRole('navigation', { name: 'Mapping outline' });
    await waitFor(() =>
      expect(within(outline).getByRole('button', { name: 'sender' })).toHaveAccessibleDescription(
        'sent by (acme:sentBy, mapped)',
      ),
    );
    expect(within(outline).getByRole('button', { name: 'Document' })).toHaveAccessibleDescription(
      'acme:Letter (mapped)',
    );

    const kind = screen.getByRole('group', { name: 'kind' });
    expect(within(kind).getByText('kind of letter')).toBeInTheDocument();
    expect(within(kind).getByText('deprecated')).toBeInTheDocument();
    expect(within(kind).getByText('Memo')).toBeInTheDocument();
    expect(within(kind).getByText('local term')).toBeInTheDocument();

    await open('sender');
    const sender = screen.getByRole('group', { name: 'sender' });
    expect(within(sender).getByText('Also called: sender, from')).toBeInTheDocument();
    expect(within(sender).getByText('Who sent the letter.')).toBeInTheDocument();
    expect(within(sender).getByRole('link', { name: 'Open in Ontologies' })).toHaveAttribute(
      'href',
      `#/ontologies/acme/1/${encodeURIComponent(`${A}sentBy`)}`,
    );

    await open('Document');
    expect(screen.getByText(/Not in the pinned ontologies or the local terms/)).toBeInTheDocument();
  });

  it('still maps when the names cannot be read', async () => {
    const termLabels = vi.fn(async () => {
      throw new Error('offline');
    });
    const { last } = setup(mapped, fakeApi({ termLabels }));
    await userEvent.type(
      within(screen.getByRole('group', { name: 'sender' })).getByLabelText('Property'),
      'acme:sentBy',
    );
    expect(last()?.fields.sender).toEqual({ property: 'acme:sentBy' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MappingEditor prefixes', () => {
  it('never overwrites a namespace when adding a prefix after removing one', async () => {
    const { last } = setup({ ...mapped, prefixes: {} });
    await open('Prefixes');
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
    await open('Prefixes');
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
    await open('Shapes');
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
    await open('Preview');
    await userEvent.click(screen.getByRole('button', { name: 'Preview on dev samples' }));
    expect(await screen.findByText(/1 violation/)).toBeInTheDocument();
    expect(screen.getByText(/sender: a letter names its sender/)).toBeInTheDocument();
  });
});

describe('MappingEditor value nodes', () => {
  const withDefaults: Semantics = {
    ...mapped,
    valueNodes: { link: 'acme:hasResult', value: 'acme:numericValue' },
    fields: { sender: { property: 'acme:sentBy' } },
  };
  const valueAs = () =>
    within(screen.getByRole('group', { name: 'sender' })).getByRole('group', { name: 'Value as' });

  it('Value as Node keeps the property, drops the entity and asks for the class', async () => {
    const { last } = setup({
      ...withDefaults,
      fields: { sender: { property: 'acme:sentBy', object: { class: 'acme:Party', iri: 'p/x' } } },
    });
    await open('sender');
    await userEvent.click(within(valueAs()).getByRole('button', { name: 'Node' }));
    expect(last()?.fields.sender).toEqual({ property: 'acme:sentBy', node: { class: '' } });
    const sender = screen.getByRole('group', { name: 'sender' });
    expect(within(sender).getByLabelText('Link property')).toBeInTheDocument();
    expect(within(sender).getByLabelText('Node class')).toBeInTheDocument();
    expect(within(sender).getByLabelText('Value property')).toBeInTheDocument();
    expect(within(sender).getByLabelText('Unit')).toBeInTheDocument();
    expect(within(sender).queryByLabelText('Entity class')).toBeNull();
    await userEvent.type(within(sender).getByLabelText('Node class'), 'acme:SenderName');
    expect(last()?.fields.sender).toEqual({
      property: 'acme:sentBy',
      node: { class: 'acme:SenderName' },
    });
  });

  it('an empty link or value property falls back to the recipe defaults, and says so', async () => {
    const { last } = setup(withDefaults);
    await open('sender');
    await userEvent.click(within(valueAs()).getByRole('button', { name: 'Node' }));
    const sender = screen.getByRole('group', { name: 'sender' });
    await userEvent.clear(within(sender).getByLabelText('Link property'));
    expect(last()?.fields.sender).toEqual({ node: { class: '' } });
    expect(within(sender).getByText('Empty: the recipe default, acme:hasResult.')).toBeVisible();
    expect(within(sender).getByLabelText('Value property')).toHaveAttribute(
      'placeholder',
      'acme:numericValue (recipe default)',
    );
  });

  it('asks for a unit property only once a unit is set, and keeps the unit', async () => {
    const { last } = setup({ ...withDefaults, fields: { sender: { node: { class: 'acme:N' } } } });
    await open('sender');
    const sender = screen.getByRole('group', { name: 'sender' });
    expect(within(sender).queryByLabelText('Unit property')).toBeNull();
    await userEvent.type(within(sender).getByLabelText('Unit'), 'unit:PERCENT');
    expect(last()?.fields.sender).toEqual({ node: { class: 'acme:N', unit: 'unit:PERCENT' } });
    expect(within(sender).getByLabelText('Unit property')).toBeInTheDocument();
  });

  it('sets the value-node defaults under Value nodes', async () => {
    const { last } = setup(mapped);
    await open('Value nodes');
    const form = screen.getByRole('region', { name: 'Value nodes' });
    await userEvent.type(within(form).getByLabelText('Link to a value node'), 'acme:hasResult');
    await userEvent.type(within(form).getByLabelText('Value property'), 'acme:numericValue');
    await userEvent.type(within(form).getByLabelText('Unit property'), 'acme:unit');
    expect(last()?.valueNodes).toEqual({
      link: 'acme:hasResult',
      value: 'acme:numericValue',
      unitProperty: 'acme:unit',
    });
  });

  it('the outline shows a value node by its class', async () => {
    setup({ ...withDefaults, fields: { sender: { node: { class: 'acme:SenderName' } } } });
    const outline = screen.getByRole('navigation', { name: 'Mapping outline' });
    expect(within(outline).getByRole('button', { name: 'sender' })).toHaveAccessibleDescription(
      'node · acme:SenderName (mapped)',
    );
  });
});
