import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { OntologiesPage } from '../src/ontologies/OntologiesPage.js';
import { fakeApi, ontologySummary, ontologyVersion } from './fake-api.js';

function page(
  list = [ontologySummary()],
  role: 'admin' | 'user' = 'admin',
  overrides: Partial<Api> = {},
) {
  const api = fakeApi({ listOntologies: vi.fn(async () => list), ...overrides });
  render(<OntologiesPage api={api} role={role} pollMs={10} />);
  return api;
}

describe('OntologiesPage', () => {
  it('shows each ontology with its kinds, tags and newest version', async () => {
    page([
      ontologySummary({ localOnly: true }),
      ontologySummary({
        id: 'stages',
        label: 'Process stages',
        tags: [],
        latest: ontologyVersion({ status: 'failed', error: 'cannot read stages.ttl as Turtle' }),
      }),
    ]);
    const pv = await screen.findByRole('region', { name: 'Ontology Process validation' });
    expect(within(pv).getByRole('link', { name: 'Process validation' })).toHaveAttribute(
      'href',
      '#/ontologies/pv',
    );
    expect(within(pv).getByText('OWL')).toBeInTheDocument();
    expect(within(pv).getByText('Local only')).toBeInTheDocument();
    expect(within(pv).getByText('industry:pharma')).toBeInTheDocument();
    expect(within(pv).getByText(/3 classes · 2 properties/)).toBeInTheDocument();
    const stages = screen.getByRole('region', { name: 'Ontology Process stages' });
    expect(within(stages).getByText(/Import failed: cannot read stages.ttl/)).toBeInTheDocument();
  });

  it('filters by the search box', async () => {
    page([
      ontologySummary(),
      ontologySummary({ id: 'stages', label: 'Process stages', tags: ['customer:acme'] }),
    ]);
    await screen.findByRole('region', { name: 'Ontology Process stages' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search ontologies' }), 'acme');
    expect(
      screen.queryByRole('region', { name: 'Ontology Process validation' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Ontology Process stages' })).toBeInTheDocument();
  });

  it('offers Import only to admins and explains an empty library', async () => {
    page([], 'user');
    expect(
      await screen.findByText(/No ontologies yet\. An admin imports them\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import ontology' })).not.toBeInTheDocument();
  });

  it('polls while a version is importing', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([ontologySummary({ latest: ontologyVersion({ status: 'parsing' }) })])
      .mockResolvedValue([ontologySummary()]);
    page(undefined, 'admin', { listOntologies: list });
    expect(await screen.findByText('Importing…')).toBeInTheDocument();
    expect(await screen.findByText(/3 classes/)).toBeInTheDocument();
    const calls = list.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(list.mock.calls.length).toBe(calls); // stopped once ready
  });

  it('imports a new ontology, its id made from the name', async () => {
    const api = page([], 'admin', { importOntology: vi.fn(async () => ontologyVersion()) });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    const file = new File(['@prefix x: <y> .'], 'idmp.ttl', { type: 'text/turtle' });
    await userEvent.upload(within(dialog).getByLabelText('Ontology file'), file);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'IDMP O');
    expect(within(dialog).getByLabelText('Id')).toHaveValue('idmp-o');
    await userEvent.type(
      within(dialog).getByLabelText('Tags (comma-separated)'),
      'industry:pharma',
    );
    await userEvent.click(within(dialog).getByLabelText(/Local only/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importOntology).toHaveBeenCalledWith(file, {
        id: 'idmp-o',
        label: 'IDMP O',
        tags: ['industry:pharma'],
        localOnly: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('adds a version to an existing ontology and shows refusals', async () => {
    const api = page([ontologySummary()], 'admin', {
      importOntology: vi.fn(async () => {
        throw new Error('this file is already version 1 of pv');
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.type(within(dialog).getByLabelText('Id'), 'pv');
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Adds version 2 of Process validation.',
    );
    const file = new File(['x'], 'pv.ttl');
    await userEvent.upload(within(dialog).getByLabelText('Ontology file'), file);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already version 1 of pv');
    expect(api.importOntology).toHaveBeenCalledWith(file, { id: 'pv' });
  });

  it('imports from a URL on an allowed host', async () => {
    const api = page([], 'admin', {
      importOntologyFromUrl: vi.fn(async () => ontologyVersion({ sourceKind: 'url' })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a URL' }));
    expect(await within(dialog).findByText('Allowed hosts: w3id.org')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('URL'), 'https://w3id.org/idmp/core.ttl');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'IDMP');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importOntologyFromUrl).toHaveBeenCalledWith({
        id: 'idmp',
        label: 'IDMP',
        tags: [],
        localOnly: false,
        url: 'https://w3id.org/idmp/core.ttl',
      }),
    );
  });

  it('says why a URL cannot be imported before sending it', async () => {
    page([], 'admin', {
      getOntologySettings: vi.fn(async () => ({
        fetchHosts: ['w3id.org'],
        maxBytes: 1,
        maxUploadBytes: 1_000_000,
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a URL' }));
    await userEvent.type(within(dialog).getByLabelText('URL'), 'https://evil.org/x.ttl');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'X');
    expect(within(dialog).getByText('evil.org is not on ONTOLOGY_FETCH_ALLOW')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('explains when URL imports are off', async () => {
    page([], 'admin', {
      getOntologySettings: vi.fn(async () => ({
        fetchHosts: [],
        maxBytes: 1,
        maxUploadBytes: 1_000_000,
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a URL' }));
    expect(await within(dialog).findByText(/URL imports are off/)).toBeInTheDocument();
  });

  it('says why Import is disabled, on hover and in the dialog', async () => {
    page([], 'admin', {
      getOntologySettings: vi.fn(async () => ({
        fetchHosts: ['www.dublincore.org'],
        maxBytes: 1,
        maxUploadBytes: 1_000_000,
      })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    const importButton = () => within(dialog).getByRole('button', { name: 'Import' });
    expect(importButton()).toHaveAttribute('title', 'Choose an ontology file');
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a URL' }));
    await within(dialog).findByText('Allowed hosts: www.dublincore.org');
    expect(importButton()).toHaveAttribute('title', "Enter the ontology's URL");
    await userEvent.type(
      within(dialog).getByLabelText('URL'),
      'https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl',
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'DublinCore');
    expect(importButton()).toBeEnabled();
    await userEvent.clear(within(dialog).getByLabelText('Id'));
    await userEvent.type(within(dialog).getByLabelText('Id'), 'DCMI');
    const reason =
      'The id must be 2-63 lower-case letters, digits or hyphens, starting with a letter or digit (try dcmi)';
    expect(importButton()).toBeDisabled();
    expect(importButton()).toHaveAttribute('title', reason);
    expect(importButton()).toHaveAccessibleDescription(reason);
    expect(within(dialog).getByLabelText('Id')).toHaveAccessibleDescription(reason);
    await userEvent.clear(within(dialog).getByLabelText('Id'));
    await userEvent.type(within(dialog).getByLabelText('Id'), 'dcmi');
    expect(importButton()).toBeEnabled();
    expect(importButton()).not.toHaveAttribute('title');
  });
});

/** A file as a folder picker gives it: with its path in the folder. */
function inFolder(path: string, body = 'x'): File {
  const file = new File([body], path.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

describe('ImportOntologyDialog, from a folder or .zip', () => {
  const folder = [
    inFolder('idmp/core.ttl'),
    inFolder('idmp/sub/prod.ttl'),
    inFolder('idmp/README.md'),
    inFolder('idmp/.git/config.ttl'),
  ];

  async function open(overrides: Partial<Api> = {}, list = [ontologySummary()]) {
    const api = page(list, 'admin', overrides);
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a folder or .zip' }));
    return { api, dialog };
  }

  it('merges a folder into one ontology', async () => {
    const { api, dialog } = await open({
      importOntologyBatch: vi.fn(async () => ({
        versions: [ontologyVersion({ ontologyId: 'idmp-o', sourceKind: 'files' })],
        skipped: [],
      })),
    });
    const importButton = within(dialog).getByRole('button', { name: 'Import' });
    expect(importButton).toHaveAttribute('title', 'Choose a folder or a .zip');
    await userEvent.upload(within(dialog).getByLabelText('Ontology folder'), folder);
    expect(
      within(dialog).getByText('2 ontology files · 1 other file left out'),
    ).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'IDMP-O');
    expect(within(dialog).getByLabelText('Id')).toHaveValue('idmp-o');
    await userEvent.click(importButton);
    await waitFor(() =>
      expect(api.importOntologyBatch).toHaveBeenCalledWith(
        [
          { file: folder[0], path: 'idmp/core.ttl' },
          { file: folder[1], path: 'idmp/sub/prod.ttl' },
        ],
        { mode: 'merge', id: 'idmp-o', label: 'IDMP-O', tags: [], localOnly: false },
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('1 version queued.');
  });

  it('imports one ontology per file, previewing the ids and what they add to', async () => {
    const { api, dialog } = await open(
      {
        importOntologyBatch: vi.fn(async () => ({
          versions: [ontologyVersion({ ontologyId: 'idmp-core' })],
          skipped: [
            {
              fileName: 'idmp/sub/prod.ttl',
              ontologyId: 'idmp-prod',
              reason: 'already version 1 of idmp-prod',
            },
          ],
        })),
      },
      [ontologySummary({ id: 'idmp-prod', label: 'prod', versionCount: 1 })],
    );
    await userEvent.upload(within(dialog).getByLabelText('Ontology folder'), folder);
    await userEvent.click(within(dialog).getByRole('button', { name: 'One ontology per file' }));
    expect(within(dialog).getByLabelText('Id prefix')).toHaveValue('idmp-');
    const preview = within(dialog).getByRole('list', { name: 'Ontologies to import' });
    expect(preview).toHaveTextContent('idmp-core (new)');
    expect(preview).toHaveTextContent('idmp-prod (adds version 2)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importOntologyBatch).toHaveBeenCalledWith(expect.any(Array), {
        mode: 'separate',
        idPrefix: 'idmp-',
        tags: [],
        localOnly: false,
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '1 version queued. 1 file skipped: idmp/sub/prod.ttl (already version 1 of idmp-prod).',
    );
  });

  it('imports a .zip, and says when a folder has no ontology files', async () => {
    const { api, dialog } = await open({
      importOntologyBatch: vi.fn(async () => ({ versions: [ontologyVersion()], skipped: [] })),
    });
    await userEvent.upload(within(dialog).getByLabelText('Ontology folder'), [inFolder('x/a.md')]);
    expect(within(dialog).getByRole('button', { name: 'Import' })).toHaveAttribute(
      'title',
      'The folder has no ontology files',
    );
    const zip = new File(['PK'], 'idmp-o-1.4.zip', { type: 'application/zip' });
    await userEvent.upload(within(dialog).getByLabelText('or a .zip'), zip);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'IDMP-O');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importOntologyBatch).toHaveBeenCalledWith(
        [{ file: zip, path: 'idmp-o-1.4.zip' }],
        expect.objectContaining({ mode: 'merge', id: 'idmp-o' }),
      ),
    );
  });
});

describe('OntologiesPage layout (handoff: header row, Cards / List)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const two = () => [
    ontologySummary({ description: 'Validation protocols', localOnly: true }),
    ontologySummary({
      id: 'qudt-org-2-1-schema-extensions-functions',
      label: 'http://qudt.org/2.1/schema/extensions/functions',
      tags: ['imported-by:qudt-units'],
      latest: ontologyVersion({ status: 'failed', error: 'cannot read functions.ttl as Turtle' }),
      versionCount: 3,
    }),
    ontologySummary({ id: 'empty', label: 'Empty', latest: null, versionCount: 0, tags: [] }),
  ];

  it('puts the title, search, view switch and Import in one header row', async () => {
    page(two());
    const header = await screen.findByRole('banner', { name: 'Ontologies' });
    expect(
      within(header).getByRole('heading', { level: 1, name: 'Ontologies' }),
    ).toBeInTheDocument();
    expect(
      within(header).getByRole('searchbox', { name: 'Search ontologies' }),
    ).toBeInTheDocument();
    expect(within(header).getByRole('group', { name: 'View' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Import ontology' })).toBeInTheDocument();
  });

  it('leaves Import out for users, keeping the view switch', async () => {
    page(two(), 'user');
    const header = await screen.findByRole('banner', { name: 'Ontologies' });
    expect(within(header).getByRole('group', { name: 'View' })).toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: 'Import ontology' })).toBeNull();
  });

  it('shows cards by default: an icon tile, the id under the name', async () => {
    page(two());
    const pv = await screen.findByRole('region', { name: 'Ontology Process validation' });
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'false');
    const tile = pv.querySelector('.ontology-card-icon');
    expect(tile).not.toBeNull();
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    const name = within(pv).getByRole('link', { name: 'Process validation' });
    const id = within(pv).getByText('pv');
    expect(name.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(pv).getByText('Validation protocols')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('switches to a list table, remembered per browser', async () => {
    page(two());
    await screen.findByRole('region', { name: 'Ontology Process validation' });
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('ih.ontologyView')).toBe('list');
    const table = screen.getByRole('table', { name: 'Ontologies' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Ontology', 'Id', 'Format and tags', 'Version', 'Contents', 'Actions']);
    expect(screen.queryByRole('region', { name: /^Ontology / })).toBeNull();
    expect(table.querySelector('.ontology-card-icon')).toBeNull();
    // Long values are kept whole in a title.
    const long = within(table).getByRole('link', {
      name: 'http://qudt.org/2.1/schema/extensions/functions',
    });
    expect(long).toHaveAttribute('title', 'http://qudt.org/2.1/schema/extensions/functions');
    const row = long.closest('tr')!;
    expect(within(row).getByText('qudt-org-2-1-schema-extensions-functions')).toHaveAttribute(
      'title',
      'qudt-org-2-1-schema-extensions-functions',
    );
    expect(within(row).getByText('3 versions')).toBeInTheDocument();
    expect(within(row).getByText(/Import failed: cannot read functions.ttl/)).toHaveAttribute(
      'title',
      'Import failed: cannot read functions.ttl as Turtle',
    );
    const empty = within(table).getByRole('link', { name: 'Empty' }).closest('tr')!;
    expect(within(empty).getByText('—')).toBeInTheDocument();
    expect(within(empty).getByText('No versions')).toBeInTheDocument();
    // A new page starts in the list; Cards forgets the choice.
    cleanup();
    page(two());
    expect(await screen.findByRole('table', { name: 'Ontologies' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cards' }));
    expect(localStorage.getItem('ih.ontologyView')).toBeNull();
  });

  it('shows cards when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    page(two());
    expect(
      await screen.findByRole('region', { name: 'Ontology Process validation' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByRole('table', { name: 'Ontologies' })).toBeInTheDocument();
  });

  it('filters both views the same way, and says when nothing matches', async () => {
    page(two());
    await screen.findByRole('region', { name: 'Ontology Process validation' });
    const search = screen.getByRole('searchbox', { name: 'Search ontologies' });
    await userEvent.type(search, 'qudt');
    expect(screen.getAllByRole('region', { name: /^Ontology / })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2); // header + 1
    await userEvent.clear(search);
    await userEvent.type(search, 'nothing like this');
    expect(screen.getByText('No ontology matches “nothing like this”.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('OntologiesPage list row actions (Download, Edit, Delete as on the detail page)', () => {
  beforeEach(() => localStorage.setItem('ih.ontologyView', 'list'));
  afterEach(() => localStorage.clear());

  const rowOf = async (label: string) =>
    (await screen.findByRole('link', { name: label })).closest('tr')!;

  it('downloads the latest version file, or says why there is none', async () => {
    page([
      ontologySummary(),
      ontologySummary({
        id: 'idmp-o',
        label: 'IDMP-O',
        latest: ontologyVersion({
          ontologyId: 'idmp-o',
          sourceKind: 'files',
          fileName: 'idmp',
          sourceFiles: [
            { fileName: 'idmp/a.ttl', sha256: 'a', bytes: 1 },
            { fileName: 'idmp/b.ttl', sha256: 'b', bytes: 1 },
          ],
        }),
      }),
      ontologySummary({
        id: 'fetched',
        label: 'Fetched',
        latest: ontologyVersion({
          ontologyId: 'fetched',
          sourceKind: 'url',
          sha256: null,
          status: 'queued',
        }),
      }),
    ]);
    const pv = await rowOf('Process validation');
    expect(within(pv).getByRole('link', { name: 'Download pv.ttl' })).toHaveAttribute(
      'href',
      '/api/ontologies/pv/versions/1/source',
    );
    const idmp = await rowOf('IDMP-O');
    const many = within(idmp).getByRole('button', { name: 'Download IDMP-O' });
    expect(many).toBeDisabled();
    expect(many).toHaveAttribute('title', 'Imported from 2 files: open the ontology to see them');
    const fetched = await rowOf('Fetched');
    expect(within(fetched).getByRole('button', { name: 'Download Fetched' })).toHaveAttribute(
      'title',
      'Not fetched yet',
    );
  });

  it('edits an ontology from its row (admins)', async () => {
    const api = page([ontologySummary()], 'admin', {
      updateOntology: vi.fn(async () => ontologySummary({ label: 'PV' })),
    });
    const row = await rowOf('Process validation');
    await userEvent.click(within(row).getByRole('button', { name: 'Edit Process validation' }));
    const dialog = screen.getByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'PV');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateOntology).toHaveBeenCalledWith(
        'pv',
        expect.objectContaining({ label: 'PV' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.listOntologies).toHaveBeenCalledTimes(2); // reloaded
  });

  it('deletes the latest version after the same confirm as the detail page', async () => {
    const api = page(
      [ontologySummary({ versionCount: 2, latest: ontologyVersion({ version: 2 }) })],
      'admin',
      { deleteOntologyVersion: vi.fn(async () => undefined) },
    );
    const row = await rowOf('Process validation');
    await userEvent.click(
      within(row).getByRole('button', { name: 'Delete version 2 of Process validation' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete version 2' });
    expect(dialog).toHaveTextContent(
      'Deletes version 2 of Process validation, its terms and its file.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete version' }));
    await waitFor(() => expect(api.deleteOntologyVersion).toHaveBeenCalledWith('pv', 2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.listOntologies).toHaveBeenCalledTimes(2);
  });

  it('keeps a refused delete in the dialog, and cannot delete while importing', async () => {
    page(
      [
        ontologySummary(),
        ontologySummary({
          id: 'busy',
          label: 'Busy',
          latest: ontologyVersion({ ontologyId: 'busy', status: 'parsing' }),
        }),
      ],
      'admin',
      {
        deleteOntologyVersion: vi.fn(async () => {
          throw new Error('version 1 of pv is still being imported');
        }),
      },
    );
    const busy = await rowOf('Busy');
    const blocked = within(busy).getByRole('button', { name: 'Delete version 1 of Busy' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Still importing');
    const pv = await rowOf('Process validation');
    await userEvent.click(
      within(pv).getByRole('button', { name: 'Delete version 1 of Process validation' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete version 1' });
    expect(dialog).toHaveTextContent('It is the only version, so the ontology goes too.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete version' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('still being imported');
  });

  it('offers users only Download, as the detail page does', async () => {
    page([ontologySummary()], 'user');
    const row = await rowOf('Process validation');
    expect(within(row).getByRole('link', { name: 'Download pv.ttl' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Delete / })).toBeNull();
  });
});

describe('ImportOntologyDialog upload limit (a folder or file over it is refused before sending)', () => {
  const kb = (n: number, path: string) => {
    const file = new File([new Uint8Array(n * 1024)], path.split('/').pop()!);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  };

  async function open(source: string) {
    const api = page([ontologySummary()], 'admin', {
      getOntologySettings: vi.fn(async () => ({
        fetchHosts: [],
        maxBytes: 1,
        maxUploadBytes: 4 * 1024,
      })),
      importOntologyBatch: vi.fn(),
      importOntology: vi.fn(),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: source }));
    return { api, dialog };
  }

  it('names the total, the limit and the largest files of a folder over the limit', async () => {
    const { api, dialog } = await open('From a folder or .zip');
    await userEvent.upload(within(dialog).getByLabelText('Ontology folder'), [
      kb(9, 'afo/voc/chebi/chebi.ttl'),
      kb(2, 'afo/voc/pato/pato.ttl'),
      kb(1, 'afo/voc/bfo/bfo.ttl'),
    ]);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'AFO');
    const reason =
      'These files total 12 KB; the upload limit is 4 KB. Largest: afo/voc/chebi/chebi.ttl (9 KB), afo/voc/pato/pato.ttl (2 KB)';
    const importButton = within(dialog).getByRole('button', { name: 'Import' });
    await waitFor(() => expect(importButton).toHaveAttribute('title', reason));
    expect(importButton).toBeDisabled();
    expect(within(dialog).getByText(/These files total 12 KB/)).toBeInTheDocument();
    expect(api.importOntologyBatch).not.toHaveBeenCalled();
  });

  it('refuses a zip or a single file over the limit', async () => {
    const zip = await open('From a folder or .zip');
    await userEvent.upload(
      within(zip.dialog).getByLabelText('or a .zip'),
      new File([new Uint8Array(5 * 1024)], 'afo.zip', { type: 'application/zip' }),
    );
    await userEvent.type(within(zip.dialog).getByLabelText('Name'), 'AFO');
    await waitFor(() =>
      expect(within(zip.dialog).getByRole('button', { name: 'Import' })).toHaveAttribute(
        'title',
        'afo.zip is 5 KB; the upload limit is 4 KB',
      ),
    );
    cleanup();
    const one = await open('From a file');
    await userEvent.upload(within(one.dialog).getByLabelText('Ontology file'), kb(6, 'chebi.ttl'));
    await userEvent.type(within(one.dialog).getByLabelText('Name'), 'ChEBI');
    await waitFor(() =>
      expect(within(one.dialog).getByRole('button', { name: 'Import' })).toHaveAttribute(
        'title',
        'chebi.ttl is 6 KB; the upload limit is 4 KB',
      ),
    );
  });

  it('warns when a folder holds merged copies beside the modules they combine', async () => {
    const { dialog } = await open('From a folder or .zip');
    await userEvent.upload(within(dialog).getByLabelText('Ontology folder'), [
      kb(1, 'afo/voc/afo/REC/afo.ttl'),
      kb(1, 'afo/voc/afo/merged/REC/merged-without-qudt.ttl'),
    ]);
    expect(
      within(dialog).getByText(/merged copies \(merged\/\) beside the modules/),
    ).toBeInTheDocument();
  });
});
