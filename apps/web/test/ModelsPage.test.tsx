import type { LlmChoicesView, LlmEndpointView } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ModelsPage } from '../src/models/ModelsPage.js';
import { fakeApi } from './fake-api.js';

const admin = {
  role: 'admin' as const,
  label: 'Ken',
  email: null,
  mustChangePassword: false,
  userId: 'u-test',
};

function endpoint(over: Partial<LlmEndpointView> = {}): LlmEndpointView {
  return {
    name: 'local',
    kind: 'openai-chat',
    baseUrl: 'http://host:1234/v1',
    location: 'local',
    enabled: true,
    source: 'env',
    editedAt: null,
    updatedBy: null,
    apiKeyEnv: 'LOCAL_LLM_API_KEY',
    keySet: false,
    models: [
      {
        modelId: 'llama-3',
        displayName: 'Llama 3',
        curated: false,
        enabled: true,
        maxOutputTokens: null,
      },
      { modelId: 'qwen', displayName: null, curated: true, enabled: true, maxOutputTokens: null },
    ],
    ...over,
  };
}

function page(endpoints: LlmEndpointView[] = [endpoint()], overrides = {}) {
  const api = fakeApi({ listLlmEndpoints: vi.fn(async () => endpoints), ...overrides });
  render(<ModelsPage api={api} me={admin} />);
  return api;
}

const card = (name: string) => screen.findByRole('region', { name: `Endpoint ${name}` });

describe('ModelsPage', () => {
  it("sets an offered model's output limit, and clears it back to the default", async () => {
    const api = page([endpoint()], {
      setLlmModelSettings: vi.fn(async () => endpoint()),
    });
    const local = await card('local');
    // Only offered models have a limit: a suggestion does not run.
    expect(within(local).queryByRole('spinbutton', { name: /llama-3/ })).toBeNull();
    const limit = within(local).getByRole('spinbutton', { name: 'Max output tokens for qwen' });
    expect(limit).toHaveAttribute('placeholder', '16,000 (default)');
    const set = within(local).getByRole('button', { name: 'Set the output limit of qwen' });
    expect(set).toBeDisabled(); // nothing changed
    await userEvent.type(limit, '500');
    expect(set).toBeDisabled();
    expect(set).toHaveAttribute(
      'title',
      'Between 1,024 and 1,000,000 tokens, or empty for the default',
    );
    await userEvent.clear(limit);
    await userEvent.type(limit, '32000');
    await userEvent.click(set);
    expect(api.setLlmModelSettings).toHaveBeenCalledWith('local', 'qwen', {
      maxOutputTokens: 32000,
    });
  });

  it('clears a set limit back to the default', async () => {
    const api = page(
      [
        endpoint({
          models: [
            {
              modelId: 'qwen',
              displayName: null,
              curated: true,
              enabled: true,
              maxOutputTokens: 48000,
            },
          ],
        }),
      ],
      { setLlmModelSettings: vi.fn(async () => endpoint()) },
    );
    const local = await card('local');
    const limit = within(local).getByRole('spinbutton', { name: 'Max output tokens for qwen' });
    expect(limit).toHaveValue(48000);
    await userEvent.clear(limit);
    await userEvent.click(
      within(local).getByRole('button', { name: 'Set the output limit of qwen' }),
    );
    expect(api.setLlmModelSettings).toHaveBeenCalledWith('local', 'qwen', {
      maxOutputTokens: null,
    });
  });

  it('shows each endpoint with where it sends data, where it came from and its key', async () => {
    page([
      endpoint(),
      endpoint({
        name: 'claude',
        kind: 'anthropic',
        baseUrl: null,
        location: 'external',
        source: 'ui',
        editedAt: '2026-10-13T10:00:00.000Z',
        updatedBy: 'Ken',
        apiKeyEnv: null,
        keySet: true,
        models: [],
      }),
    ]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeInTheDocument();
    const local = await card('local');
    expect(within(local).getByText('http://host:1234/v1')).toBeInTheDocument();
    const where = (c: HTMLElement, name: string) =>
      within(within(c).getByRole('group', { name: 'Location' })).getByRole('button', { name });
    expect(where(local, 'Local')).toHaveAttribute('aria-pressed', 'true');
    expect(within(local).getByText('From .env')).toBeInTheDocument();
    expect(within(local).getByText('Key from .env (LOCAL_LLM_API_KEY)')).toBeInTheDocument();
    const claude = await card('claude');
    expect(where(claude, 'External')).toHaveAttribute('aria-pressed', 'true');
    expect(within(claude).getByText('Added here by Ken')).toBeInTheDocument();
    expect(within(claude).getByText('Key stored (encrypted)')).toBeInTheDocument();
  });

  it('chooses the offered models, from suggestions and new ids', async () => {
    const setLlmEndpointModels = vi.fn(async () => endpoint());
    page([endpoint()], { setLlmEndpointModels });
    const local = await card('local');
    const models = within(local).getByRole('group', { name: 'Models offered' });
    const qwen = within(models).getByRole('checkbox', { name: 'qwen' });
    const llama = within(models).getByRole('checkbox', { name: 'Llama 3 (llama-3) suggested' });
    expect(qwen).toBeChecked();
    expect(llama).not.toBeChecked();
    const save = within(local).getByRole('button', { name: 'Save models' });
    expect(save).toBeDisabled();
    await userEvent.click(llama);
    await userEvent.type(
      within(local).getByRole('textbox', { name: 'Add a model id' }),
      'mistral{Enter}',
    );
    expect(within(models).getByRole('checkbox', { name: 'mistral' })).toBeChecked();
    await userEvent.click(save);
    expect(setLlmEndpointModels).toHaveBeenCalledWith('local', ['llama-3', 'mistral', 'qwen']);
  });

  it('shows why the API refused, in the endpoint', async () => {
    page([endpoint()], {
      setLlmEndpointModels: vi.fn(async () => {
        throw new ApiError('alias default uses local/qwen: point it elsewhere first', 409);
      }),
    });
    const local = await card('local');
    await userEvent.click(within(local).getByRole('checkbox', { name: 'qwen' }));
    await userEvent.click(within(local).getByRole('button', { name: 'Save models' }));
    expect(await within(local).findByRole('alert')).toHaveTextContent(
      'alias default uses local/qwen',
    );
  });

  it('disables, moves and keys an endpoint', async () => {
    const updateLlmEndpoint = vi.fn(async () => endpoint());
    page([endpoint()], { updateLlmEndpoint });
    const local = await card('local');
    await userEvent.click(within(local).getByRole('button', { name: 'Disable' }));
    expect(updateLlmEndpoint).toHaveBeenLastCalledWith('local', { enabled: false });
    await userEvent.click(within(local).getByRole('button', { name: 'External' }));
    expect(updateLlmEndpoint).toHaveBeenLastCalledWith('local', { location: 'external' });
    await userEvent.click(within(local).getByRole('button', { name: 'Edit base URL' }));
    const url = within(local).getByRole('textbox', { name: 'Base URL' });
    await userEvent.clear(url);
    await userEvent.type(url, 'http://gpu:8000/v1');
    await userEvent.click(within(local).getByRole('button', { name: 'Save base URL' }));
    expect(updateLlmEndpoint).toHaveBeenLastCalledWith('local', { baseUrl: 'http://gpu:8000/v1' });
    await userEvent.click(within(local).getByRole('button', { name: 'Set key' }));
    await userEvent.type(within(local).getByLabelText('API key'), 'sk-new');
    await userEvent.click(within(local).getByRole('button', { name: 'Save key' }));
    expect(updateLlmEndpoint).toHaveBeenLastCalledWith('local', { apiKey: 'sk-new' });
  });

  it('removes a stored key', async () => {
    const updateLlmEndpoint = vi.fn(async () => endpoint());
    page([endpoint({ keySet: true })], { updateLlmEndpoint });
    const local = await card('local');
    await userEvent.click(within(local).getByRole('button', { name: 'Remove key' }));
    expect(updateLlmEndpoint).toHaveBeenCalledWith('local', { apiKey: null });
  });

  it('adds an endpoint', async () => {
    const createLlmEndpoint = vi.fn(async () => endpoint({ name: 'gpu2' }));
    page([endpoint()], { createLlmEndpoint });
    await userEvent.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    const dialog = screen.getByRole('dialog', { name: 'Add endpoint' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'gpu2');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Base URL' }),
      'http://192.168.1.140:8000/v1',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Models (comma-separated)' }),
      'llama-4-70b, qwen3-32b',
    );
    await userEvent.type(within(dialog).getByLabelText('API key (optional)'), 'sk-gpu');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(createLlmEndpoint).toHaveBeenCalledWith({
      name: 'gpu2',
      kind: 'openai-chat',
      baseUrl: 'http://192.168.1.140:8000/v1',
      location: 'local',
      models: ['llama-4-70b', 'qwen3-32b'],
      apiKey: 'sk-gpu',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('removes only endpoints added here, after a confirm', async () => {
    const deleteLlmEndpoint = vi.fn(async () => undefined);
    page([endpoint(), endpoint({ name: 'gpu2', source: 'ui' })], { deleteLlmEndpoint });
    const local = await card('local');
    expect(within(local).queryByRole('button', { name: 'Remove endpoint' })).toBeNull();
    const gpu2 = await card('gpu2');
    await userEvent.click(within(gpu2).getByRole('button', { name: 'Remove endpoint' }));
    expect(deleteLlmEndpoint).not.toHaveBeenCalled();
    await userEvent.click(within(gpu2).getByRole('button', { name: 'Confirm remove gpu2' }));
    expect(deleteLlmEndpoint).toHaveBeenCalledWith('gpu2');
  });

  it('is for admins only', () => {
    render(
      <ModelsPage
        api={fakeApi()}
        me={{
          role: 'user',
          label: 'Ann',
          email: null,
          mustChangePassword: false,
          userId: 'u-test',
        }}
      />,
    );
    expect(screen.getByText('Admins only.')).toBeInTheDocument();
  });
});

describe('ModelsPage: model choices and pipeline models', () => {
  const choicesView = (over: Partial<LlmChoicesView> = {}): LlmChoicesView => ({
    choices: [
      {
        id: 'main',
        label: 'Main Production Model',
        description: 'What production uses',
        ref: 'local/qwen',
        source: 'env',
        editedAt: null,
        updatedBy: null,
      },
      {
        id: 'test',
        label: 'New for testing only',
        description: '',
        ref: 'local/llama-3',
        source: 'ui',
        editedAt: '2026-10-13T10:00:00.000Z',
        updatedBy: 'Ken',
      },
    ],
    settings: {
      defaultChoice: 'main',
      draftingModel: 'local/qwen',
      ocrModel: 'local/olmocr',
      embeddingModel: null,
    },
    ...over,
  });
  const endpoints = [
    endpoint({
      models: [
        {
          modelId: 'llama-3',
          displayName: null,
          curated: true,
          enabled: true,
          maxOutputTokens: null,
        },
        {
          modelId: 'olmocr',
          displayName: null,
          curated: true,
          enabled: true,
          maxOutputTokens: null,
        },
        { modelId: 'qwen', displayName: null, curated: true, enabled: true, maxOutputTokens: null },
        {
          modelId: 'suggested',
          displayName: null,
          curated: false,
          enabled: true,
          maxOutputTokens: null,
        },
      ],
    }),
  ];
  const choicesPage = (overrides = {}) =>
    page(endpoints, { listModelChoices: vi.fn(async () => choicesView()), ...overrides });
  const section = (name: string) => screen.findByRole('region', { name });

  it('lists the choices by label with their model, and marks the default', async () => {
    choicesPage();
    const choices = await section('Model choices');
    const main = within(choices).getByRole('row', { name: /Main Production Model/ });
    expect(main).toHaveTextContent('local/qwen');
    expect(main).toHaveTextContent('Default');
    expect(main).toHaveTextContent('What production uses');
    const test = within(choices).getByRole('row', { name: /New for testing only/ });
    expect(within(test).getByRole('button', { name: 'Make default' })).toBeInTheDocument();
    expect(within(main).queryByRole('button', { name: 'Make default' })).toBeNull();
  });

  it('adds a choice from the offered models only', async () => {
    const createModelChoice = vi.fn(async () => choicesView().choices[1]!);
    choicesPage({ createModelChoice });
    const choices = await section('Model choices');
    const form = within(choices).getByRole('form', { name: 'Add a model choice' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Label' }), 'Fast drafts');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Description' }), 'Cheap');
    const model = within(form).getByRole('combobox', { name: 'Model' });
    expect(within(model).queryByRole('option', { name: 'local/suggested' })).toBeNull();
    await userEvent.selectOptions(model, 'local/llama-3');
    await userEvent.click(within(form).getByRole('button', { name: 'Add choice' }));
    expect(createModelChoice).toHaveBeenCalledWith({
      label: 'Fast drafts',
      description: 'Cheap',
      ref: 'local/llama-3',
    });
  });

  it('makes a choice the default', async () => {
    const setLlmSettings = vi.fn(async () => choicesView());
    choicesPage({ setLlmSettings });
    const choices = await section('Model choices');
    const test = within(choices).getByRole('row', { name: /New for testing only/ });
    await userEvent.click(within(test).getByRole('button', { name: 'Make default' }));
    expect(setLlmSettings).toHaveBeenCalledWith({ defaultChoice: 'test' });
  });

  it('renames and repoints a choice', async () => {
    const updateModelChoice = vi.fn(async () => choicesView().choices[0]!);
    choicesPage({ updateModelChoice });
    const choices = await section('Model choices');
    const main = within(choices).getByRole('row', { name: /Main Production Model/ });
    await userEvent.click(within(main).getByRole('button', { name: 'Edit Main Production Model' }));
    const label = within(choices).getByRole('textbox', { name: 'Label for main' });
    await userEvent.clear(label);
    await userEvent.type(label, 'Production');
    await userEvent.selectOptions(
      within(choices).getByRole('combobox', { name: 'Model for main' }),
      'local/llama-3',
    );
    await userEvent.click(within(choices).getByRole('button', { name: 'Save main' }));
    expect(updateModelChoice).toHaveBeenCalledWith('main', {
      label: 'Production',
      description: 'What production uses',
      ref: 'local/llama-3',
    });
  });

  it('removes a choice after a confirm, and shows a refusal', async () => {
    const deleteModelChoice = vi.fn(async () => {
      throw new ApiError('New for testing only is used by letter v2 (step head)', 409);
    });
    choicesPage({ deleteModelChoice });
    const choices = await section('Model choices');
    const test = within(choices).getByRole('row', { name: /New for testing only/ });
    await userEvent.click(
      within(test).getByRole('button', { name: 'Remove New for testing only' }),
    );
    expect(deleteModelChoice).not.toHaveBeenCalled();
    await userEvent.click(within(choices).getByRole('button', { name: 'Confirm remove test' }));
    expect(deleteModelChoice).toHaveBeenCalledWith('test');
    expect(await within(choices).findByRole('alert')).toHaveTextContent('used by letter v2');
  });

  it('sets the OCR and drafting models, which are not choices', async () => {
    const setLlmSettings = vi.fn(async () => choicesView());
    choicesPage({ setLlmSettings });
    const pipeline = await section('Pipeline models');
    const ocr = within(pipeline).getByRole('combobox', { name: 'OCR model' });
    expect(ocr).toHaveValue('local/olmocr');
    await userEvent.selectOptions(ocr, 'local/qwen');
    expect(setLlmSettings).toHaveBeenLastCalledWith({ ocrModel: 'local/qwen' });
    await userEvent.selectOptions(
      within(pipeline).getByRole('combobox', { name: 'Drafting model' }),
      'local/llama-3',
    );
    expect(setLlmSettings).toHaveBeenLastCalledWith({ draftingModel: 'local/llama-3' });
    const embedding = within(pipeline).getByRole('combobox', { name: 'Embedding model' });
    expect(embedding).toHaveValue('');
    await userEvent.selectOptions(embedding, 'local/qwen');
    expect(setLlmSettings).toHaveBeenLastCalledWith({ embeddingModel: 'local/qwen' });
    await userEvent.selectOptions(embedding, '');
    expect(setLlmSettings).toHaveBeenLastCalledWith({ embeddingModel: null });
  });

  it('asks the workers to discover an endpoint now', async () => {
    const discoverLlmEndpoint = vi.fn(async () => undefined);
    choicesPage({ discoverLlmEndpoint });
    const local = await card('local');
    await userEvent.click(within(local).getByRole('button', { name: 'Discover models' }));
    expect(discoverLlmEndpoint).toHaveBeenCalledWith('local');
    expect(await within(local).findByRole('status')).toHaveTextContent(
      'Discovery requested: new models appear as suggestions within a minute.',
    );
  });
});
