import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteVersionView } from '@ih/shared';
import { PullDialog } from '../src/templates/github/PullDialog.js';
import { fakeApi, templateView } from './fake-api.js';

const rv = (o: Partial<RemoteVersionView>): RemoteVersionView => ({
  instance: 'production',
  typeId: 'invoice',
  version: 1,
  label: null,
  note: null,
  publishedBy: 'Ken',
  publishedAt: '2026-10-01T09:00:00.000Z',
  definitionSha256: 'abc',
  commit: 'deadbeefcafe',
  path: 'ct-studio/production/invoice/v1.yaml',
  mine: true,
  compare: 'same',
  ...o,
});

const listing = {
  versions: [
    rv({ version: 1, compare: 'same' }),
    rv({ version: 2, label: 'Signed off', compare: 'label' }),
    rv({
      instance: 'staging',
      version: 4,
      label: 'Staging trial',
      mine: false,
      compare: null,
      path: 'ct-studio/staging/invoice/v4.yaml',
      commit: '1234567890ab',
    }),
  ],
  skipped: [{ path: 'ct-studio/staging/invoice/v9.draft.yaml', reason: 'a draft file' }],
};

function setup(
  props: Partial<Parameters<typeof PullDialog>[0]> = {},
  apiOver: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    listGitHubRemote: vi.fn(async () => listing),
    takeGitHubLabel: vi.fn(async (id: string, version: number) =>
      templateView({ id, version }, 'published'),
    ),
    ...apiOver,
  });
  const onTaken = vi.fn();
  const onDraft = vi.fn();
  const onClose = vi.fn();
  render(
    <PullDialog
      api={api}
      templateId="invoice"
      retired={null}
      dirty={false}
      openUpdatedAt={null}
      onTaken={onTaken}
      onDraft={onDraft}
      onClose={onClose}
      {...props}
    />,
  );
  return { api, onTaken, onDraft, onClose };
}

describe('PullDialog', () => {
  it('lists this deployment with compare badges, other deployments apart, and unreadable files', async () => {
    setup();
    const mine = await screen.findByRole('region', { name: 'This deployment' });
    expect(within(mine).getByText('Same as here')).toBeInTheDocument();
    expect(within(mine).getByText('Label differs')).toBeInTheDocument();
    const others = screen.getByRole('region', { name: 'Other deployments' });
    expect(within(others).getByText(/Staging trial/)).toBeInTheDocument();
    expect(within(others).getByText(/published by Ken/)).toBeInTheDocument();
    const bad = screen.getByRole('region', { name: 'Not readable' });
    expect(bad).toHaveTextContent('ct-studio/staging/invoice/v9.draft.yaml: a draft file');
  });

  it("takes GitHub's label for a version whose label differs", async () => {
    const { api, onTaken } = setup();
    await userEvent.click(await screen.findByRole('button', { name: "Take GitHub's label" }));
    await waitFor(() =>
      expect(api.takeGitHubLabel).toHaveBeenCalledWith('invoice', 2, 'deadbeefcafe'),
    );
    await waitFor(() => expect(onTaken).toHaveBeenCalled());
  });

  it('uses another deployment version as the draft, sending the open draft time', async () => {
    const { api, onDraft } = setup({ openUpdatedAt: '2026-10-03T00:00:00.000Z' });
    const others = await screen.findByRole('region', { name: 'Other deployments' });
    await userEvent.click(within(others).getByRole('button', { name: /Use as draft/ }));
    await waitFor(() =>
      expect(api.useGitHubVersionAsDraft).toHaveBeenCalledWith('invoice', {
        instance: 'staging',
        typeId: 'invoice',
        version: 4,
        commit: '1234567890ab',
        baseUpdatedAt: '2026-10-03T00:00:00.000Z',
      }),
    );
    await waitFor(() => expect(onDraft).toHaveBeenCalled());
  });

  it('sends no base time when no draft is open', async () => {
    const { api } = setup();
    const others = await screen.findByRole('region', { name: 'Other deployments' });
    await userEvent.click(within(others).getByRole('button', { name: /Use as draft/ }));
    await waitFor(() => expect(api.useGitHubVersionAsDraft).toHaveBeenCalled());
    expect(vi.mocked(api.useGitHubVersionAsDraft).mock.calls[0]![1]).not.toHaveProperty(
      'baseUpdatedAt',
    );
  });

  it('disables Use as draft with a visible reason while dirty', async () => {
    setup({ dirty: true });
    const others = await screen.findByRole('region', { name: 'Other deployments' });
    expect(within(others).getByRole('button', { name: /Use as draft/ })).toBeDisabled();
    expect(within(others).getByText('Save or discard your changes first')).toBeInTheDocument();
  });

  it('disables Use as draft with the retired reason', async () => {
    setup({ retired: 'invoice is retired: unretire it to use it again' });
    const others = await screen.findByRole('region', { name: 'Other deployments' });
    expect(within(others).getByRole('button', { name: /Use as draft/ })).toBeDisabled();
    expect(
      within(others).getByText('invoice is retired: unretire it to use it again'),
    ).toBeInTheDocument();
  });

  it('shows a refusal as an alert', async () => {
    const { onDraft } = setup(
      {},
      {
        useGitHubVersionAsDraft: vi.fn(async () => {
          throw new Error('the draft changed while applying; try again');
        }),
      },
    );
    const others = await screen.findByRole('region', { name: 'Other deployments' });
    await userEvent.click(within(others).getByRole('button', { name: /Use as draft/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the draft changed while applying');
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('offers this deployment rows only what their comparison allows', async () => {
    const all = {
      versions: [
        rv({ version: 1, compare: 'same' }),
        rv({ version: 2, label: 'L', compare: 'label' }),
        rv({ version: 3, compare: 'differs' }),
        rv({ version: 5, compare: 'missing-here' }),
      ],
      skipped: [],
    };
    setup({}, { listGitHubRemote: vi.fn(async () => all) });
    const mine = await screen.findByRole('region', { name: 'This deployment' });
    const rows = within(mine).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    const byText = (t: string) => rows.find((r) => r.textContent!.includes(t))!;
    const buttons = (r: HTMLElement) =>
      within(r)
        .queryAllByRole('button')
        .map((b) => b.textContent);
    expect(buttons(byText('v1'))).toEqual([]);
    expect(buttons(byText('v2'))).toEqual(["Take GitHub's label"]);
    expect(buttons(byText('v3'))).toEqual([]);
    expect(within(byText('v3')).getByText('Different from here')).toBeInTheDocument();
    expect(buttons(byText('v5'))).toEqual(['Use as draft…']);
  });

  it("refetches the listing after taking GitHub's label", async () => {
    const after = {
      versions: [rv({ version: 2, label: 'Signed off', compare: 'same' })],
      skipped: [],
    };
    const before = {
      versions: [rv({ version: 2, label: 'Signed off', compare: 'label' })],
      skipped: [],
    };
    const list = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    setup({}, { listGitHubRemote: list });
    await userEvent.click(await screen.findByRole('button', { name: "Take GitHub's label" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Same as here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Take GitHub's label" })).not.toBeInTheDocument();
  });
});
