import type { LlmEndpointView } from '@ih/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { ModelsPage } from '../src/models/ModelsPage.js';
import { fakeApi } from './fake-api.js';

const admin = { role: 'admin' as const, label: 'Ken', expiresAt: null };

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
      { modelId: 'llama-3', displayName: 'Llama 3', curated: false, enabled: true },
      { modelId: 'qwen', displayName: null, curated: true, enabled: true },
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
    render(<ModelsPage api={fakeApi()} me={{ role: 'user', label: 'Ann', expiresAt: null }} />);
    expect(screen.getByText('Admins only.')).toBeInTheDocument();
  });
});
