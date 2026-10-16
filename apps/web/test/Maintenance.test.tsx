import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_ERROR, type MaintenanceNotice } from '@ih/shared';
import { App } from '../src/App.js';
import { MaintenancePage } from '../src/access/MaintenancePage.js';
import { ApiError } from '../src/api/client.js';
import { ADMIN_ME, fakeApi } from './fake-api.js';

const ON: MaintenanceNotice = {
  enabled: true,
  message: 'Swapping models, back by 3pm.',
  since: '2026-10-16T13:00:00.000Z',
};

const refusal = (notice = ON) =>
  new ApiError(MAINTENANCE_ERROR, 503, { error: MAINTENANCE_ERROR, maintenance: notice });

const USER = { ...ADMIN_ME, role: 'user' as const, label: 'Pat', email: 'pat@example.com' };

describe('maintenance: what people see', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('the sign-in page shows the banner, with its warning triangle, before anyone signs in', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      getMaintenanceNotice: vi.fn(async () => ON),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('alert', { name: 'Under maintenance' });
    expect(banner).toHaveTextContent('Swapping models, back by 3pm.');
    expect(banner).toHaveTextContent('Only admins can sign in until it is over.');
    expect(banner.querySelector('[data-icon="warning"]')).not.toBeNull();
    // The form stays: admins still sign in.
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('shows no banner while maintenance is off', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    await screen.findByLabelText('Email address');
    expect(screen.queryByRole('alert', { name: 'Under maintenance' })).toBeNull();
  });

  it('a blank message reads as the default one', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      getMaintenanceNotice: vi.fn(async () => ({ ...ON, message: '' })),
    });
    render(<App api={api} pollMs={0} />);
    expect(await screen.findByRole('alert', { name: 'Under maintenance' })).toHaveTextContent(
      'CT Studio is down for maintenance. Please try again later.',
    );
  });

  it('a user refused at sign-in sees the banner, not a sign-in error', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw refusal();
      }),
    });
    render(<App api={api} pollMs={0} />);
    await userEvent.type(await screen.findByLabelText('Email address'), 'pat@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'a long test phrase');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert', { name: 'Under maintenance' })).toHaveTextContent(
      'Swapping models, back by 3pm.',
    );
  });

  it('a signed-in user reaching the site gets the maintenance page, and Check again lets them in', async () => {
    const me = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce(USER);
    const getMaintenanceNotice = vi.fn(async () => ON);
    render(<App api={fakeApi({ me, getMaintenanceNotice })} pollMs={0} />);
    const banner = await screen.findByRole('alert', { name: 'Under maintenance' });
    expect(banner).toHaveTextContent('Swapping models, back by 3pm.');
    expect(screen.queryByText(/Can't reach the server/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('No jobs yet: upload a document to start.')).toBeInTheDocument();
  });

  it('a user mid-session is sent to the maintenance page when the API refuses them', async () => {
    const api = fakeApi({ me: vi.fn(async () => USER) });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('No jobs yet: upload a document to start.');
    act(() => api.startMaintenance(ON));
    expect(await screen.findByRole('alert', { name: 'Under maintenance' })).toBeInTheDocument();
  });

  it('admins keep the app, with a strip saying maintenance is on', async () => {
    const api = fakeApi({ getMaintenanceNotice: vi.fn(async () => ON) });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('No jobs yet: upload a document to start.');
    expect(await screen.findByRole('status', { name: 'Maintenance mode is on' })).toHaveTextContent(
      'Only admins can use CT Studio',
    );
  });
});

describe('Administration > Maintenance', () => {
  it('switches maintenance on with a message', async () => {
    const api = fakeApi();
    render(<MaintenancePage api={api} me={ADMIN_ME} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Under maintenance' });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await userEvent.type(
      screen.getByLabelText('Message to users'),
      'Swapping models, back by 3pm.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.setMaintenance).toHaveBeenCalledWith({
      enabled: true,
      message: 'Swapping models, back by 3pm.',
    });
    expect(await screen.findByText(/^On since/)).toBeInTheDocument();
    // The preview shows what people will see.
    const preview = screen.getByRole('region', { name: 'What users see' });
    expect(within(preview).getByText('Swapping models, back by 3pm.')).toBeInTheDocument();
  });

  it('switches it off, keeping the message', async () => {
    const api = fakeApi({
      getMaintenance: vi.fn(async () => ({ ...ON, updatedBy: 'Ken', updatedAt: ON.since })),
    });
    render(<MaintenancePage api={api} me={ADMIN_ME} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Under maintenance' });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/Ken/)).toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.setMaintenance).toHaveBeenCalledWith({
      enabled: false,
      message: 'Swapping models, back by 3pm.',
    });
  });

  it('shows a refusal', async () => {
    const api = fakeApi({
      setMaintenance: vi.fn(async () => {
        throw new Error('admins only');
      }),
    });
    render(<MaintenancePage api={api} me={ADMIN_ME} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Under maintenance' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('admins only')).toBeInTheDocument();
  });
});
