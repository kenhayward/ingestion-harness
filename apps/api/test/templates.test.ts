import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { seedTemplates } from '../src/templates/seed.js';
import { fakePdf, multipart, seedModelChoices, testApp } from './helpers.js';

const repoSpecsDir = fileURLToPath(new URL('../../../specs', import.meta.url));

/** A minimal valid template definition. */
const definition = (id = 'letter', version = 1) => ({
  id,
  version,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: 'sender', type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'] }],
});

const json = (method: 'POST' | 'PUT', url: string, payload: object) => ({ method, url, payload });

describe('template lifecycle', () => {
  it('creates a document type as a v1 draft skeleton', async () => {
    const { app } = await testApp();
    const res = await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    expect(res.statusCode).toBe(201);
    expect(res.json().record).toMatchObject({ id: 'letter', version: 1, status: 'draft' });
    expect(res.json().record.definition.name).toBe('Letter');
    expect(res.json().issues.length).toBeGreaterThan(0); // a skeleton has no steps yet
    expect(
      (await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'x' }))).statusCode,
    ).toBe(409);
    expect(
      (await app.inject(json('POST', '/api/templates', { id: 'Bad Id', name: 'x' }))).statusCode,
    ).toBe(400);
  });

  it('saves drafts even when invalid, reporting the issues', async () => {
    const { app } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    const bad = { ...definition(), pipeline: [] };
    const saved = await app.inject(
      json('PUT', '/api/templates/letter/versions/1', { definition: bad }),
    );
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json().issues)).toContain('pipeline');

    const good = await app.inject(
      json('PUT', '/api/templates/letter/versions/1', {
        definition: { ...definition(), id: 'other', version: 7 },
      }),
    );
    expect(good.json().issues).toEqual([]);
    expect(good.json().record.definition).toMatchObject({ id: 'letter', version: 1 }); // pinned to path
  });

  it('publishes only valid drafts; published versions are immutable', async () => {
    const { app } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    expect(
      (await app.inject(json('POST', '/api/templates/letter/versions/1/publish', {}))).statusCode,
    ).toBe(400);

    await app.inject(json('PUT', '/api/templates/letter/versions/1', { definition: definition() }));
    const published = await app.inject(
      json('POST', '/api/templates/letter/versions/1/publish', {}),
    );
    expect(published.json().record).toMatchObject({ status: 'published' });
    expect(published.json().record.publishedAt).toBeTruthy();

    const edit = await app.inject(
      json('PUT', '/api/templates/letter/versions/1', { definition: definition() }),
    );
    expect(edit.statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/templates/letter/versions/1' })).statusCode,
    ).toBe(409);
  });

  it('reports a draft step naming a model, or a choice whose model is not offered, and will not publish it', async () => {
    const ctx = await testApp();
    const { app, repo, llm } = ctx;
    seedModelChoices(ctx);
    llm.seedChoice({ id: 'gone', label: 'Gone', ref: 'ryzen/other' });
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    const withModel = (model: string) => ({
      ...definition(),
      pipeline: [{ type: 'extract', id: 'head', fields: ['sender'], sections: ['all'], model }],
    });
    const issuesFor = async (model: string) =>
      (
        await app.inject(
          json('PUT', '/api/templates/letter/versions/1', { definition: withModel(model) }),
        )
      ).json().issues;
    // A draft names model choices (ADR 0010, phase 4c), even when the model is offered.
    expect(await issuesFor('local/qwen')).toEqual([
      {
        path: 'pipeline.0.model',
        message: 'step "head": pick a model choice instead of the model local/qwen',
      },
    ]);
    expect(await issuesFor('gone')).toEqual([
      {
        path: 'pipeline.0.model',
        message:
          'step "head": model choice gone uses ryzen/other, which is not offered: add it under Administration > Models',
      },
    ]);
    expect(repo.models.some((m) => m.ref === 'ryzen/other')).toBe(false);
    const refused = await app.inject(json('POST', '/api/templates/letter/versions/1/publish', {}));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().issues).toHaveLength(1);
    expect(await issuesFor('fast')).toEqual([]);
    const published = await app.inject(
      json('POST', '/api/templates/letter/versions/1/publish', {}),
    );
    expect(published.statusCode).toBe(200);
    expect(published.json().issues).toEqual([]);
  });

  it('refuses to import straight to published with a model that is not offered', async () => {
    const { app } = await testApp();
    const yaml = stringifyYaml({
      ...definition('memo'),
      pipeline: [
        { type: 'extract', id: 'head', fields: ['sender'], sections: ['all'], model: 'x/y' },
      ],
    });
    const res = await app.inject(json('POST', '/api/templates/import', { yaml, publish: true }));
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toContain('model x/y is not offered');
  });

  it('publishes a type without a Workbench project, even while another type has one', async () => {
    const { app, templates } = await testApp();
    await app.inject(json('POST', '/api/workbench/projects', { id: 'invoice', name: 'Invoice' }));
    await templates.create('letter', 1, definition(), 'draft');
    const res = await app.inject(json('POST', '/api/templates/letter/versions/1/publish', {}));
    expect(res.statusCode).toBe(200);
    expect(res.json().record).toMatchObject({ status: 'published' });
  });

  it('starts a new draft from a published version, one draft at a time', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, definition(), 'published');
    const draft = await app.inject(json('POST', '/api/templates/letter/drafts', {}));
    expect(draft.statusCode).toBe(201);
    expect(draft.json().record).toMatchObject({ version: 2, status: 'draft' });
    expect(draft.json().record.definition).toMatchObject({ version: 2, name: 'Letter' });
    expect((await app.inject(json('POST', '/api/templates/letter/drafts', {}))).statusCode).toBe(
      409,
    );

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/templates/letter/versions/2' })).statusCode,
    ).toBe(204);
  });

  it('lists document types with their published and draft versions', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, definition(), 'published');
    await templates.create('letter', 2, definition('letter', 2), 'draft');
    const [letter] = (await app.inject('/api/templates')).json();
    expect(letter).toMatchObject({ id: 'letter', name: 'Letter', published: 1, draft: 2 });
  });

  it('rejects custom prompt files, which database templates cannot hold', async () => {
    const { app } = await testApp();
    await app.inject(json('POST', '/api/templates', { id: 'letter', name: 'Letter' }));
    const withPrompt = {
      ...definition(),
      pipeline: [{ ...definition().pipeline[0], prompt: 'prompts/x.j2' }],
    };
    const res = await app.inject(
      json('PUT', '/api/templates/letter/versions/1', { definition: withPrompt }),
    );
    expect(JSON.stringify(res.json().issues)).toContain('custom prompt files');
  });
  it('seeds a missing version of a retired type and leaves it retired (D9)', async () => {
    const { templates } = await testApp();
    await templates.retire('process-validation-protocol', 'ken');
    expect(await seedTemplates(templates, repoSpecsDir)).toContain(
      'process-validation-protocol v3',
    );
    expect((await templates.get('process-validation-protocol', 3))?.status).toBe('published');
    expect(await templates.retirement('process-validation-protocol')).toMatchObject({
      retiredBy: 'ken',
    });
  });
});

describe('import / export', () => {
  it('exports a version as YAML and imports it back', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, definition(), 'published');
    const exported = await app.inject('/api/templates/letter/versions/1/export');
    expect(exported.headers['content-type']).toContain('yaml');
    expect(exported.headers['content-disposition']).toContain('letter-v1.yaml');
    expect(parseYaml(exported.body)).toMatchObject({ id: 'letter', version: 1 });

    const yaml = exported.body.replace('version: 1', 'version: 5');
    const imported = await app.inject(json('POST', '/api/templates/import', { yaml }));
    expect(imported.statusCode).toBe(201);
    expect(imported.json().record).toMatchObject({ version: 5, status: 'draft' });

    const again = await app.inject(json('POST', '/api/templates/import', { yaml }));
    expect(again.statusCode).toBe(409);
  });

  it('can import straight to published when valid', async () => {
    const { app } = await testApp();
    const res = await app.inject(
      json('POST', '/api/templates/import', {
        yaml: JSON.stringify(definition('memo', 3)),
        publish: true,
      }),
    );
    expect(res.json().record).toMatchObject({ id: 'memo', version: 3, status: 'published' });
    const invalid = await app.inject(
      json('POST', '/api/templates/import', { yaml: 'id: memo\nversion: 4\n', publish: true }),
    );
    expect(invalid.statusCode).toBe(400);
  });

  it('seeds template files that are not in the database yet (idempotent)', async () => {
    const { templates } = await testApp();
    expect(await seedTemplates(templates, repoSpecsDir)).toContain(
      'process-validation-protocol v3',
    );
    expect(await seedTemplates(templates, repoSpecsDir)).toEqual([]);
    expect((await templates.get('process-validation-protocol', 3))?.status).toBe('published');
  });
});

describe('uploads against database templates', () => {
  it('uses the latest published version by default', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, definition(), 'published');
    await templates.create('letter', 2, definition('letter', 2), 'draft');
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'letter' }, { filename: 'a.pdf', content: fakePdf }),
    });
    expect(res.json()).toMatchObject({ specVersion: 1, test: false });
  });

  it('runs drafts only as test runs, whose approval only finishes review', async () => {
    const { app, repo, templates } = await testApp();
    await templates.create('letter', 2, definition('letter', 2), 'draft');
    const upload = (fields: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/documents',
        ...multipart(fields, { filename: 'a.pdf', content: fakePdf }),
      });
    expect((await upload({ specId: 'letter', specVersion: '2' })).statusCode).toBe(400);

    const test = await upload({ specId: 'letter', specVersion: '2', test: 'true' });
    expect(test.json()).toMatchObject({ specVersion: 2, test: true });
    // the draft's outputs at the run, which Save as reference trusts after later draft edits
    expect(await repo.getJobParams(test.json().id)).toEqual({
      outputs: definition('letter', 2).outputs,
    });

    repo.jobs.set(test.json().id, { ...repo.jobs.get(test.json().id)!, status: 'awaiting_review' });
    // Approving a test run (a workbench reference run) is allowed: the publish task writes the
    // reviewed document but never delivers a test run to the target (worker publish_job).
    const approve = await app.inject(json('POST', `/api/jobs/${test.json().id}/approve`, {}));
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ test: true, status: 'queued', task: 'publish' });
  });

  it('lists database templates among the document types offered for upload', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, definition(), 'published');
    await templates.create('letter', 2, definition('letter', 2), 'draft');
    const specs = (await app.inject('/api/specs')).json();
    expect(specs.filter((s: { id: string }) => s.id === 'letter')).toEqual([
      { id: 'letter', version: 1, title: 'Letter', description: undefined, kind: 'template' },
    ]);
  });
});

describe('import of a CT Studio recipe file', () => {
  const wrapper = (over: Record<string, unknown> = {}, id = 'letter', version = 7) =>
    stringifyYaml({
      format: 'ct-recipe',
      formatVersion: 1,
      instance: 'prod',
      version: {
        number: version,
        status: 'published',
        label: 'Q3 layout',
        note: 'third quarter',
        labelSetBy: 'Pat',
        labelSetAt: '2026-10-02T00:00:00.000Z',
        publishedBy: 'Pat',
        publishedAt: '2026-10-01T00:00:00.000Z',
        basedOn: null,
        importedFrom: null,
        definitionSha256: 'a'.repeat(64),
      },
      definition: definition(id, version),
      ...over,
    });

  it('creates a new type as a v1 draft with the label and a logged source', async () => {
    const { app, templates } = await testApp();
    const res = await app.inject(json('POST', '/api/templates/import', { yaml: wrapper() }));
    expect(res.statusCode).toBe(201);
    expect(res.json().record).toMatchObject({
      id: 'letter',
      version: 1,
      status: 'draft',
      label: 'Q3 layout',
      note: 'third quarter',
    });
    expect(res.json().record.definition).toMatchObject({ id: 'letter', version: 1 });
    expect(res.json().record.importedFrom).toEqual({
      instance: 'prod',
      typeId: 'letter',
      version: 7,
      commit: null,
    });
    const [change] = await templates.listChanges('letter', 1);
    expect(change).toMatchObject({
      source: 'import',
      summary: 'Imported from YAML (prod/letter v7)',
    });
  });

  it("creates an existing type's next free version as a draft", async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, definition(), 'published');
    await templates.create('letter', 2, definition('letter', 2), 'published');
    const res = await app.inject(json('POST', '/api/templates/import', { yaml: wrapper() }));
    expect(res.statusCode).toBe(201);
    expect(res.json().record).toMatchObject({ version: 3, status: 'draft', label: 'Q3 layout' });
    const again = await app.inject(json('POST', '/api/templates/import', { yaml: wrapper() }));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('a draft already exists; edit or delete it first');
  });

  it('refuses publish: true for a wrapper', async () => {
    const { app, templates } = await testApp();
    const res = await app.inject(
      json('POST', '/api/templates/import', { yaml: wrapper(), publish: true }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('a CT Studio recipe file is always imported as a draft');
    expect(await templates.list()).toEqual([]);
  });

  it('refuses a wrapper that is not a usable recipe file, and a retired type', async () => {
    const { app, templates } = await testApp();
    const bad = await app.inject(
      json('POST', '/api/templates/import', { yaml: wrapper({ formatVersion: 2 }) }),
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('format');
    await templates.create('letter', 1, definition(), 'published');
    await templates.retire('letter', 'Admin');
    const retired = await app.inject(json('POST', '/api/templates/import', { yaml: wrapper() }));
    expect(retired.statusCode).toBe(409);
  });
});
