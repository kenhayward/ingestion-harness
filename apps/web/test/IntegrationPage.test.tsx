import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Me } from '../src/api/client.js';
import { IntegrationPage } from '../src/access/IntegrationPage.js';
import { fakeApi } from './fake-api.js';

const ADMIN: Me = {
  userId: 'a1',
  role: 'admin',
  label: 'Admin',
  email: null,
  mustChangePassword: false,
  avatarUrl: null,
};

const settings = (over: Partial<{ locked: boolean; instanceName: string }> = {}) => ({
  instanceName: 'production',
  instanceId: 'inst-1',
  defaultRoot: 'ct-studio',
  locked: false,
  ...over,
});

async function section(api = fakeApi()) {
  render(<IntegrationPage api={api} me={ADMIN} />);
  const region = await screen.findByRole('region', { name: 'GitHub sync' });
  await within(region).findByRole('textbox', { name: 'Deployment name' });
  return { api, region };
}

describe('GitHub sync settings (Administration > Integration)', () => {
  it('shows the name, the default folder and the read-only instance id, each with a hint', async () => {
    const { region } = await section();
    expect(within(region).getByRole('textbox', { name: 'Deployment name' })).toHaveValue(
      'production',
    );
    expect(within(region).getByRole('textbox', { name: 'Default folder' })).toHaveValue(
      'ct-studio',
    );
    expect(within(region).getByText('inst-1')).toBeInTheDocument();
    expect(region).toHaveTextContent('Lower-case letters, digits and hyphens');
  });

  it('saves both settings', async () => {
    const setGitHubSettings = vi.fn(async (b: { instanceName: string; defaultRoot: string }) =>
      settings(b),
    );
    const { region } = await section(fakeApi({ setGitHubSettings }));
    const name = within(region).getByRole('textbox', { name: 'Deployment name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'staging');
    const root = within(region).getByRole('textbox', { name: 'Default folder' });
    await userEvent.clear(root);
    await userEvent.type(root, 'recipes/ct');
    await userEvent.click(within(region).getByRole('button', { name: 'Save' }));
    expect(setGitHubSettings).toHaveBeenCalledWith({
      instanceName: 'staging',
      defaultRoot: 'recipes/ct',
    });
    expect(await within(region).findByRole('status')).toHaveTextContent('Saved.');
  });

  it('fixes the name once this deployment has pushed', async () => {
    const { region } = await section(
      fakeApi({ getGitHubSettings: vi.fn(async () => settings({ locked: true })) }),
    );
    expect(within(region).getByRole('textbox', { name: 'Deployment name' })).toHaveAttribute(
      'readonly',
    );
    expect(region).toHaveTextContent('Fixed once this deployment has pushed to GitHub');
    expect(within(region).getByRole('textbox', { name: 'Default folder' })).not.toHaveAttribute(
      'readonly',
    );
  });

  it('shows the refusal when the server says the name is locked', async () => {
    const setGitHubSettings = vi.fn(async () => {
      throw new ApiError('the deployment name is fixed once anything has been pushed', 409);
    });
    const { region } = await section(fakeApi({ setGitHubSettings }));
    const name = within(region).getByRole('textbox', { name: 'Deployment name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'other');
    await userEvent.click(within(region).getByRole('button', { name: 'Save' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent('is fixed once anything');
  });
});
