import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SignInEvent } from '../src/api/client.js';
import { SignInsPanel } from '../src/access/SignInsPanel.js';
import { ADMIN_FROM_LOG, fakeApi, user } from './fake-api.js';

const KEN = user();
const event = (fields: Partial<SignInEvent>): SignInEvent => ({
  id: crypto.randomUUID(),
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
  userId: KEN.id,
  name: 'Ken Hayward',
  result: 'ok',
  failures: null,
  lockedUntil: null,
  ip: '10.0.0.7',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  ...fields,
});

describe('SignInsPanel', () => {
  it('lists recent sign-ins in words', async () => {
    const listSignIns = vi.fn(async () => [
      event({ result: 'wrong-password', failures: 3 }),
      event({ result: 'unknown-login', userId: null, name: null, userAgent: null }),
    ]);
    render(
      <SignInsPanel
        api={fakeApi({ listSignIns })}
        users={[ADMIN_FROM_LOG, KEN]}
        userId={null}
        onUserId={vi.fn()}
        refreshKey={0}
      />,
    );
    const table = await screen.findByRole('table', { name: 'Recent sign-ins' });
    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(first).toHaveTextContent('Ken Hayward');
    expect(first).toHaveTextContent('Wrong password (3 in a row)');
    expect(first).toHaveTextContent('10.0.0.7');
    expect(first).toHaveTextContent('Firefox on Windows');
    expect(first).toHaveTextContent('5 min ago');
    expect(second).toHaveTextContent('Unknown email');
    expect(second).toHaveTextContent('—');
    expect(screen.getByText('Kept for 90 days.')).toBeInTheDocument();
    expect(listSignIns).toHaveBeenCalledWith({ limit: 50 });
  });

  it('asks for 200 with Show more', async () => {
    const listSignIns = vi.fn(async () => Array.from({ length: 50 }, () => event({})));
    render(
      <SignInsPanel
        api={fakeApi({ listSignIns })}
        users={[KEN]}
        userId={null}
        onUserId={vi.fn()}
        refreshKey={0}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(listSignIns).toHaveBeenLastCalledWith({ limit: 200 });
  });

  it('picks a user with the filter', async () => {
    const onUserId = vi.fn();
    render(
      <SignInsPanel
        api={fakeApi()}
        users={[ADMIN_FROM_LOG, KEN]}
        userId={null}
        onUserId={onUserId}
        refreshKey={0}
      />,
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Whose sign-ins' }),
      'Ken Hayward',
    );
    expect(onUserId).toHaveBeenCalledWith(KEN.id);
  });

  it('says when there are none, and shows an error without hiding anything else', async () => {
    const { unmount } = render(
      <SignInsPanel api={fakeApi()} users={[]} userId={null} onUserId={vi.fn()} refreshKey={0} />,
    );
    expect(await screen.findByText('No sign-ins yet.')).toBeInTheDocument();
    unmount();
    render(
      <SignInsPanel
        api={fakeApi({
          listSignIns: vi.fn(async () => {
            throw new Error('server down');
          }),
        })}
        users={[]}
        userId={null}
        onUserId={vi.fn()}
        refreshKey={0}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('server down');
  });
});
