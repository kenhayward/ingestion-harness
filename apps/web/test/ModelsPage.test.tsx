import type { LlmChoicesView, LlmEndpointView, LlmModelView } from '@ih/shared';
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

const model = (modelId: string, over: Partial<LlmModelView> = {}): LlmModelView => ({
  modelId,
  displayName: null,
  curated: true,
  enabled: true,
  maxOutputTokens: null,
  maxConcurrentCalls: null,
  ...over,
});

function endpoint(over: Partial<LlmEndpointView> = {}): LlmEndpointView {
  return {
    name: 'local',
    kind: 'openai-chat',
    baseUrl: 'http://host:1234/v1',
    location: 'local',
    enabled: true,
    toolCalls: true,
    source: 'env',
    editedAt: null,
    updatedBy: null,
    apiKeyEnv: 'LOCAL_LLM_API_KEY',
    keySet: false,
    models: [model('llama-3', { displayName: 'Llama 3', curated: false }), model('qwen')],
    ...over,
  };
}

function page(endpoints: LlmEndpointView[] = [endpoint()], overrides = {}) {
  const api = fakeApi({ listLlmEndpoints: vi.fn(async () => endpoints), ...overrides });
  render(<ModelsPage api={api} me={admin} />);
  return api;
}

const row = (name: string) => screen.findByRole('region', { name: `Endpoint ${name}` });

/** An endpoint's row, opened. */
async function opened(name: string) {
  const r = await row(name);
  await userEvent.click(within(r).getByRole('button', { expanded: false }));
  return r;
}

describe('ModelsPage: endpoints', () => {
  it('lists each endpoint collapsed: kind, where it sends data and came from, models offered', async () => {
    page([
      endpoint(),
      endpoint({
        name: 'claude',
        kind: 'anthropic',
        baseUrl: null,
        location: 'external',
        enabled: false,
        source: 'ui',
        editedAt: '2026-10-13T10:00:00.000Z',
        updatedBy: 'Ken',
        apiKeyEnv: null,
        keySet: true,
        models: [],
      }),
    ]);
    const local = await row('local');
    const toggle = within(local).getByRole('button', { expanded: false });
    expect(toggle).toHaveTextContent('local');
    expect(toggle).toHaveTextContent('OpenAI-compatible (chat)');
    expect(toggle).toHaveTextContent('Local · from .env');
    expect(toggle).toHaveTextContent('1 of 2 offered');
    expect(toggle).toHaveTextContent('Enabled');
    expect(within(local).queryByText('http://host:1234/v1')).toBeNull();
    const claude = await row('claude');
    expect(claude).toHaveTextContent('External · added here by Ken');
    expect(claude).toHaveTextContent('0 of 0 offered');
    expect(claude).toHaveTextContent('Disabled');
  });

  it('opens an endpoint on its connection and the models it offers', async () => {
    page([endpoint({ keySet: true, apiKeyEnv: null })]);
    const local = await opened('local');
    expect(within(local).getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(within(local).getByText('http://host:1234/v1')).toBeInTheDocument();
    expect(
      within(within(local).getByRole('group', { name: 'Location' })).getByRole('button', {
        name: 'Local',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(within(local).getByText('Key stored (encrypted)')).toBeInTheDocument();
    const offered = within(local).getByRole('list', { name: 'Models offered on local' });
    expect(
      within(offered)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('qwen')]);
    await userEvent.click(within(local).getByRole('button', { expanded: true }));
    expect(within(local).queryByText('http://host:1234/v1')).toBeNull();
  });

  it('turns tool calls off and on for an endpoint', async () => {
    const updateLlmEndpoint = vi.fn(async () => endpoint({ toolCalls: false }));
    page([endpoint()], { updateLlmEndpoint });
    const local = await opened('local');
    const tools = within(local).getByRole('checkbox', { name: 'Tool calls' });
    expect(tools).toBeChecked();
    expect(within(local).getByText(/Workbench drafting may test anchors/)).toBeInTheDocument();
    await userEvent.click(tools);
    expect(updateLlmEndpoint).toHaveBeenLastCalledWith('local', { toolCalls: false });
  });

  it("sets an offered model's output limit", async () => {
    const api = page([endpoint()], { setLlmModelSettings: vi.fn(async () => endpoint()) });
    const local = await opened('local');
    const limit = within(local).getByRole('spinbutton', { name: 'Max output tokens for qwen' });
    expect(limit).toHaveAttribute('placeholder', '16,000');
    // Set shows once something changed, and only accepts a number in range.
    expect(
      within(local).queryByRole('button', { name: 'Set the output limit of qwen' }),
    ).toBeNull();
    await userEvent.type(limit, '500');
    const set = within(local).getByRole('button', { name: 'Set the output limit of qwen' });
    expect(set).toBeDisabled();
    expect(set).toHaveAttribute(
      'title',
      'Between 1,024 and 1,000,000 tokens, or empty for the default',
    );
    await userEvent.clear(limit);
    await userEvent.type(limit, '32000{Enter}');
    expect(api.setLlmModelSettings).toHaveBeenCalledWith('local', 'qwen', {
      maxOutputTokens: 32000,
    });
  });

  it('clears a set limit back to the default', async () => {
    const api = page([endpoint({ models: [model('qwen', { maxOutputTokens: 48000 })] })], {
      setLlmModelSettings: vi.fn(async () => endpoint()),
    });
    const local = await opened('local');
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

  it("sets an offered model's parallel calls, sending only that setting", async () => {
    const api = page([endpoint({ models: [model('qwen', { maxOutputTokens: 48000 })] })], {
      setLlmModelSettings: vi.fn(async () => endpoint()),
    });
    const local = await opened('local');
    const calls = within(local).getByRole('spinbutton', { name: 'Parallel calls for qwen' });
    expect(calls).toHaveAttribute('placeholder', '1');
    expect(calls).toHaveValue(null);
    // Set shows once something changed, and only accepts a whole number from 1 to 32.
    expect(
      within(local).queryByRole('button', { name: 'Set the parallel calls of qwen' }),
    ).toBeNull();
    await userEvent.type(calls, '33');
    const set = within(local).getByRole('button', { name: 'Set the parallel calls of qwen' });
    expect(set).toBeDisabled();
    expect(set).toHaveAttribute('title', 'Between 1 and 32 calls, or empty for one at a time');
    await userEvent.clear(calls);
    await userEvent.type(calls, '0');
    expect(set).toBeDisabled();
    await userEvent.clear(calls);
    await userEvent.type(calls, '4{Enter}');
    expect(api.setLlmModelSettings).toHaveBeenCalledTimes(1);
    expect(api.setLlmModelSettings).toHaveBeenCalledWith('local', 'qwen', {
      maxConcurrentCalls: 4,
    });
  });

  it('clears parallel calls back to one at a time', async () => {
    const api = page([endpoint({ models: [model('qwen', { maxConcurrentCalls: 8 })] })], {
      setLlmModelSettings: vi.fn(async () => endpoint()),
    });
    const local = await opened('local');
    const calls = within(local).getByRole('spinbutton', { name: 'Parallel calls for qwen' });
    expect(calls).toHaveValue(8);
    await userEvent.clear(calls);
    await userEvent.click(
      within(local).getByRole('button', { name: 'Set the parallel calls of qwen' }),
    );
    expect(api.setLlmModelSettings).toHaveBeenCalledWith('local', 'qwen', {
      maxConcurrentCalls: null,
    });
  });

  it('shows a refused parallel calls setting in the endpoint', async () => {
    page([endpoint()], {
      setLlmModelSettings: vi.fn(async () => {
        throw new ApiError('maxConcurrentCalls: Number must be less than or equal to 32', 400);
      }),
    });
    const local = await opened('local');
    await userEvent.type(
      within(local).getByRole('spinbutton', { name: 'Parallel calls for qwen' }),
      '2{Enter}',
    );
    expect(await within(local).findByRole('alert')).toHaveTextContent(
      'maxConcurrentCalls: Number must be less than or equal to 32',
    );
  });

  it('stops offering a model at once', async () => {
    const setLlmEndpointModels = vi.fn(async () => endpoint());
    page([endpoint({ models: [model('qwen'), model('gemma', { displayName: 'Gemma 3' })] })], {
      setLlmEndpointModels,
    });
    const local = await opened('local');
    await userEvent.click(within(local).getByRole('button', { name: 'Stop offering Gemma 3' }));
    expect(setLlmEndpointModels).toHaveBeenCalledWith('local', ['qwen']);
  });

  it('offers a discovered model, or one added by its id, at once', async () => {
    const setLlmEndpointModels = vi.fn(async () => endpoint());
    page([endpoint()], { setLlmEndpointModels });
    const local = await opened('local');
    const trigger = within(local).getByRole('button', { name: 'Offer a model' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    const pop = screen.getByRole('dialog', { name: 'Offer a model on local' });
    const options = within(within(pop).getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringMatching(/Llama 3.*llama-3.*Suggested/),
    ]);
    await userEvent.click(options[0]!);
    expect(setLlmEndpointModels).toHaveBeenLastCalledWith('local', ['llama-3', 'qwen']);
    expect(screen.queryByRole('dialog', { name: 'Offer a model on local' })).toBeNull();

    await userEvent.click(trigger);
    await userEvent.type(
      within(screen.getByRole('dialog', { name: 'Offer a model on local' })).getByRole('textbox', {
        name: 'Add a model id',
      }),
      'mistral{Enter}',
    );
    expect(setLlmEndpointModels).toHaveBeenLastCalledWith('local', ['mistral', 'qwen']);
  });

  it('closes the Offer a model dropdown on Escape, focus back on its button', async () => {
    page();
    const local = await opened('local');
    const trigger = within(local).getByRole('button', { name: 'Offer a model' });
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Offer a model on local' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('shows why the API refused, in the endpoint', async () => {
    page([endpoint()], {
      setLlmEndpointModels: vi.fn(async () => {
        throw new ApiError('alias default uses local/qwen: point it elsewhere first', 409);
      }),
    });
    const local = await opened('local');
    await userEvent.click(within(local).getByRole('button', { name: 'Stop offering qwen' }));
    expect(await within(local).findByRole('alert')).toHaveTextContent(
      'alias default uses local/qwen',
    );
  });

  it('disables, moves and keys an endpoint', async () => {
    const updateLlmEndpoint = vi.fn(async () => endpoint());
    page([endpoint()], { updateLlmEndpoint });
    const local = await opened('local');
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
    const local = await opened('local');
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
    const local = await opened('local');
    expect(within(local).queryByRole('button', { name: 'Remove endpoint' })).toBeNull();
    expect(local).toHaveTextContent("Set in .env, so it can't be removed here.");
    const gpu2 = await opened('gpu2');
    await userEvent.click(within(gpu2).getByRole('button', { name: 'Remove endpoint' }));
    expect(deleteLlmEndpoint).not.toHaveBeenCalled();
    await userEvent.click(within(gpu2).getByRole('button', { name: 'Confirm remove gpu2' }));
    expect(deleteLlmEndpoint).toHaveBeenCalledWith('gpu2');
  });

  it('asks the workers to discover an endpoint now', async () => {
    const discoverLlmEndpoint = vi.fn(async () => undefined);
    page([endpoint()], { discoverLlmEndpoint });
    const local = await opened('local');
    await userEvent.click(within(local).getByRole('button', { name: 'Discover models' }));
    expect(discoverLlmEndpoint).toHaveBeenCalledWith('local');
    expect(await within(local).findByRole('status')).toHaveTextContent(
      'Discovery requested: new models appear as suggestions within a minute.',
    );
  });

  it('is for admins only', () => {
    render(
      <ModelsPage
        api={fakeApi()}
        me={{ role: 'designer', label: 'Ann', email: null, mustChangePassword: false, userId: 'u' }}
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
        ref: 'cloud/sonnet',
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
        model('llama-3', { displayName: 'Llama 3' }),
        model('olmocr', { displayName: 'olmOCR 2' }),
        model('qwen', { displayName: 'Qwen 3' }),
        model('suggested', { curated: false }),
      ],
    }),
    endpoint({
      name: 'cloud',
      kind: 'anthropic',
      location: 'external',
      models: [model('sonnet', { displayName: 'Claude Sonnet' })],
    }),
  ];
  const choicesPage = (overrides = {}) =>
    page(endpoints, { listModelChoices: vi.fn(async () => choicesView()), ...overrides });
  const choiceList = () => screen.findByRole('list', { name: 'Model choices' });
  const choice = async (label: string) =>
    within(await choiceList()).getByRole('listitem', { name: label });

  it('lists the choices by label, with the model by name and the default marked', async () => {
    choicesPage();
    expect(await screen.findByRole('heading', { name: 'Model choices · 2' })).toBeInTheDocument();
    const main = await choice('Main Production Model');
    expect(main).toHaveTextContent('Default');
    expect(main).toHaveTextContent('What production uses');
    expect(within(main).getByText('Qwen 3')).toHaveAttribute('title', 'local/qwen');
    expect(main).toHaveTextContent('local');
    const test = await choice('New for testing only');
    expect(test).toHaveTextContent('cloud · external');
    expect(test).not.toHaveTextContent('Default');
  });

  it('keeps Make default and Remove off the default choice', async () => {
    choicesPage();
    const main = await choice('Main Production Model');
    await userEvent.click(
      within(main).getByRole('button', { name: 'Actions for Main Production Model' }),
    );
    const menu = screen.getByRole('menu', { name: 'Actions for Main Production Model' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Edit']);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('makes a choice the default from its menu', async () => {
    const setLlmSettings = vi.fn(async () => choicesView());
    choicesPage({ setLlmSettings });
    const test = await choice('New for testing only');
    await userEvent.click(
      within(test).getByRole('button', { name: 'Actions for New for testing only' }),
    );
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Make default', 'Edit', 'Remove']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Make default' }));
    expect(setLlmSettings).toHaveBeenCalledWith({ defaultChoice: 'test' });
  });

  it('adds a choice picked from the offered models, grouped by endpoint', async () => {
    const createModelChoice = vi.fn(async () => choicesView().choices[1]!);
    choicesPage({ createModelChoice });
    await choiceList();
    const add = screen.getByRole('button', { name: 'Add choice' });
    await userEvent.click(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
    const pop = screen.getByRole('dialog', { name: 'Add a model choice' });
    const search = within(pop).getByRole('searchbox', { name: 'Find a model' });
    expect(search).toHaveFocus();
    const groups = within(pop).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['cloud', 'local']);
    // Offered models only: never a suggestion.
    expect(within(pop).queryByRole('option', { name: /suggested/ })).toBeNull();
    expect(within(groups[1]!).getByRole('option', { name: /Qwen 3/ })).toHaveTextContent(
      'Used by Main Production Model',
    );
    await userEvent.type(search, 'llam');
    expect(within(pop).getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Add a model choice' })).toBeNull();

    const form = screen.getByRole('form', { name: 'New model choice' });
    expect(form).toHaveTextContent('local · llama-3');
    const label = within(form).getByRole('textbox', { name: 'Label' });
    expect(label).toHaveValue('Llama 3');
    expect(label).toHaveFocus();
    await userEvent.clear(label);
    await userEvent.type(label, 'Fast drafts');
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Description (optional)' }),
      'Cheap',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Add choice' }));
    expect(createModelChoice).toHaveBeenCalledWith({
      label: 'Fast drafts',
      description: 'Cheap',
      ref: 'local/llama-3',
    });
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'New model choice' })).toBeNull(),
    );
  });

  it('cancels a new choice', async () => {
    choicesPage();
    await choiceList();
    await userEvent.click(screen.getByRole('button', { name: 'Add choice' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Add a model choice' })).getByRole('option', {
        name: /Llama 3/,
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'New model choice' })).toBeNull();
  });

  it('renames and repoints a choice', async () => {
    const updateModelChoice = vi.fn(async () => choicesView().choices[0]!);
    choicesPage({ updateModelChoice });
    const main = await choice('Main Production Model');
    await userEvent.click(
      within(main).getByRole('button', { name: 'Actions for Main Production Model' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const list = await choiceList();
    const label = within(list).getByRole('textbox', { name: 'Label for main' });
    await userEvent.clear(label);
    await userEvent.type(label, 'Production');
    const pick = within(list).getByRole('combobox', { name: 'Model for main' });
    expect(within(pick).getByRole('option', { name: 'Llama 3 · local' })).toHaveValue(
      'local/llama-3',
    );
    await userEvent.selectOptions(pick, 'local/llama-3');
    await userEvent.click(within(list).getByRole('button', { name: 'Save main' }));
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
    const test = await choice('New for testing only');
    await userEvent.click(
      within(test).getByRole('button', { name: 'Actions for New for testing only' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(deleteModelChoice).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove test' }));
    expect(deleteModelChoice).toHaveBeenCalledWith('test');
    const section = screen.getByRole('region', { name: 'Model choices' });
    expect(await within(section).findByRole('alert')).toHaveTextContent('used by letter v2');
  });

  it('sets the OCR, drafting and embedding models, which are not choices', async () => {
    const setLlmSettings = vi.fn(async () => choicesView());
    choicesPage({ setLlmSettings });
    const pipeline = await screen.findByRole('region', { name: 'Pipeline models' });
    const ocr = within(pipeline).getByRole('combobox', { name: 'OCR model' });
    expect(ocr).toHaveValue('local/olmocr');
    expect(within(ocr).getByRole('option', { name: 'olmOCR 2 · local' })).toBeInTheDocument();
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
});
