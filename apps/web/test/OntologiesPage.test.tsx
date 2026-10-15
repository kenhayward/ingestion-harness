import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
      getOntologySettings: vi.fn(async () => ({ fetchHosts: ['w3id.org'], maxBytes: 1 })),
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
      getOntologySettings: vi.fn(async () => ({ fetchHosts: [], maxBytes: 1 })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a URL' }));
    expect(await within(dialog).findByText(/URL imports are off/)).toBeInTheDocument();
  });

  it('says why Import is disabled, on hover and in the dialog', async () => {
    page([], 'admin', {
      getOntologySettings: vi.fn(async () => ({ fetchHosts: ['www.dublincore.org'], maxBytes: 1 })),
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
