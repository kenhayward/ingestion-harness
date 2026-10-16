import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { VersionSync } from '@ih/shared';
import type { Api, TemplateVersionItem } from '../src/api/client.js';
import { VersionsPanel } from '../src/templates/VersionsPanel.js';
import { fakeApi, templateView } from './fake-api.js';

const item = (overrides: Partial<TemplateVersionItem> = {}): TemplateVersionItem => ({
  version: 1,
  status: 'published',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  publishedAt: '2026-10-01T09:00:00.000Z',
  label: null,
  note: null,
  labelSetBy: null,
  labelSetAt: null,
  ...overrides,
});

const withDraft = [
  item({ version: 3, status: 'draft', publishedAt: null, updatedAt: '2026-10-03T00:00:00.000Z' }),
  item({ version: 2, label: 'Two-page letters', note: 'Signed off', labelSetBy: 'Ken' }),
  item({ version: 1 }),
];

function setup(
  versions: TemplateVersionItem[],
  props: Partial<Parameters<typeof VersionsPanel>[0]> = {},
) {
  const api = fakeApi({ listVersions: vi.fn(async () => versions) });
  const onRestored = vi.fn();
  const onStarted = vi.fn();
  render(
    <VersionsPanel
      api={api}
      templateId="letter"
      openVersion={3}
      openUpdatedAt="2026-10-03T00:00:00.000Z"
      dirty={false}
      retired={null}
      refreshKey={0}
      onRestored={onRestored}
      onStarted={onStarted}
      {...props}
    />,
  );
  return { api, onRestored, onStarted };
}

describe('VersionsPanel (#144)', () => {
  it('lists the versions newest first with their labels and notes', async () => {
    setup(withDraft);
    const list = await screen.findByRole('list', { name: 'Versions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'v3 · Draft',
      'v2 · Published · Two-page letters',
      'v1 · Published',
    ]);
    expect(rows[1]).toHaveTextContent('Signed off');
    expect(rows[1]).toHaveTextContent('Ken');
    expect(within(rows[0]!).getByText('Open in the editor')).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('link', { name: 'Open v1' })).toHaveAttribute(
      'href',
      '#/templates/letter/1',
    );
  });

  it('edits a label and note, and clears a label left blank', async () => {
    const { api } = setup(withDraft);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit label of v1' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), '  First cut ');
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Single pages');
    await userEvent.click(screen.getByRole('button', { name: 'Save label' }));
    expect(api.setVersionLabel).toHaveBeenCalledWith('letter', 1, {
      label: 'First cut',
      note: 'Single pages',
    });
    await waitFor(() => expect(api.listVersions).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: 'Edit label of v2' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Label' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save label' }));
    expect(api.setVersionLabel).toHaveBeenLastCalledWith('letter', 2, {
      label: null,
      note: 'Signed off',
    });
  });

  it('replaces the open draft with an earlier version after a confirm', async () => {
    const { api, onRestored } = setup(withDraft);
    await userEvent.click(await screen.findByRole('button', { name: 'Replace draft v3 with v2' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace draft v3 with v2?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace draft' }));
    expect(api.restoreVersion).toHaveBeenCalledWith('letter', 3, 2, '2026-10-03T00:00:00.000Z');
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a refused replace in the dialog', async () => {
    const { api } = setup(withDraft);
    vi.mocked(api.restoreVersion).mockRejectedValueOnce(new Error('the draft changed'));
    await userEvent.click(await screen.findByRole('button', { name: 'Replace draft v3 with v1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Replace draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the draft changed');
  });

  it('will not replace a draft with unsaved edits', async () => {
    setup(withDraft, { dirty: true });
    const replace = await screen.findByRole('button', { name: 'Replace draft v3 with v2' });
    expect(replace).toBeDisabled();
    expect(replace).toHaveAttribute('title', 'Save or discard your changes first');
  });

  it('starts the next draft from a version when none is open', async () => {
    const versions = [item({ version: 2, label: 'Two-page letters' }), item({ version: 1 })];
    const api = fakeApi({
      listVersions: vi.fn(async () => versions),
      newDraft: vi.fn(async () => templateView({ id: 'letter', version: 3 })),
    });
    const onStarted = vi.fn();
    render(
      <VersionsPanel
        api={api}
        templateId="letter"
        openVersion={2}
        openUpdatedAt={null}
        dirty={false}
        retired={null}
        refreshKey={0}
        onRestored={vi.fn()}
        onStarted={onStarted}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Start v3 from v1' }));
    expect(api.newDraft).toHaveBeenCalledWith('letter', 1);
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Replace draft/ })).not.toBeInTheDocument();
  });

  it('labels a retired type but starts nothing from it', async () => {
    setup(withDraft, { retired: 'Letter is retired' });
    expect(await screen.findByRole('button', { name: 'Edit label of v1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replace draft v3 with v1' })).toBeDisabled();
  });
});

describe('VersionsPanel GitHub sync', () => {
  const link = {
    repo: 'acme/recipes',
    branch: 'main',
    root: 'ct-studio',
    alwaysPr: false,
    pushOnPublish: true,
    setBy: 'admin',
    setAt: '2026-10-01T00:00:00.000Z',
  };
  const sync = (
    over: Partial<VersionSync> & { version: number; state: VersionSync['state'] },
  ): VersionSync => ({
    commit: null,
    commitUrl: null,
    prNumber: null,
    prUrl: null,
    pushedBy: null,
    pushedAt: null,
    ...over,
  });
  const linked = (
    versions: VersionSync[],
    extra: Partial<{ canPush: boolean; reason: string | null }> = {},
  ) => ({ link, versions, canPush: true, reason: null, ...extra });
  const four = [
    item({ version: 4, status: 'draft', publishedAt: null }),
    item({ version: 3 }),
    item({ version: 2 }),
    item({ version: 1 }),
  ];
  const panel = (api: Api, props: Partial<Parameters<typeof VersionsPanel>[0]> = {}) => (
    <VersionsPanel
      api={api}
      templateId="invoice"
      openVersion={4}
      openUpdatedAt="2026-10-03T00:00:00.000Z"
      dirty={false}
      retired={null}
      refreshKey={0}
      admin
      onRestored={vi.fn()}
      onStarted={vi.fn()}
      {...props}
    />
  );

  function withSync(
    status: ReturnType<typeof linked>,
    props: Partial<Parameters<typeof VersionsPanel>[0]> = {},
    apiOver: Partial<Api> = {},
  ) {
    const api = fakeApi({
      listVersions: vi.fn(async () => four),
      getGitHubSync: vi.fn(async () => status),
      ...apiOver,
    });
    render(panel(api, props));
    return api;
  }

  it('offers admins Link to GitHub… on an unlinked type, and other users nothing', async () => {
    const api = fakeApi({ listVersions: vi.fn(async () => four) });
    const { rerender } = render(panel(api));
    expect(await screen.findByRole('button', { name: 'Link to GitHub…' })).toBeInTheDocument();
    rerender(panel(api, { admin: false }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Link to GitHub…' })).not.toBeInTheDocument(),
    );
  });

  it('shows the folder, Pull from GitHub… and Change… for a linked type', async () => {
    const api = withSync(linked([sync({ version: 3, state: 'absent' })]));
    expect(
      await screen.findByText('GitHub: acme/recipes · main · ct-studio/production/invoice/'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pull from GitHub…' }));
    expect(await screen.findByRole('dialog', { name: 'Pull from GitHub' })).toBeInTheDocument();
    expect(api.listGitHubRemote).toHaveBeenCalledWith('invoice');
    expect(screen.getByRole('button', { name: 'Change…' })).toBeInTheDocument();
  });

  it('shows non-admins Pull but not Change… or the instance', async () => {
    const api = withSync(linked([sync({ version: 3, state: 'absent' })]), { admin: false });
    expect(await screen.findByText('GitHub: acme/recipes · main · ct-studio/')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull from GitHub…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change…' })).not.toBeInTheDocument();
    expect(api.getGitHubSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['on', 'On GitHub'],
    ['label', 'Label changed since push'],
    ['absent', 'Not on GitHub'],
    ['differs', 'Different on GitHub'],
  ] as const)('shows the %s chip', async (state, text) => {
    withSync(linked([sync({ version: 3, state })]));
    const row = await screen.findByRole('listitem', { name: 'v3 · Published' });
    expect(within(row).getByText(text)).toBeInTheDocument();
  });

  it('shows an open pull request as a link', async () => {
    withSync(linked([sync({ version: 3, state: 'pr', prNumber: 42, prUrl: 'https://gh/pr/42' })]));
    const row = await screen.findByRole('listitem', { name: 'v3 · Published' });
    expect(within(row).getByRole('link', { name: 'PR #42 open' })).toHaveAttribute(
      'href',
      'https://gh/pr/42',
    );
  });

  it('links the commit of a version that is on GitHub', async () => {
    withSync(
      linked([
        sync({
          version: 3,
          state: 'on',
          commit: 'a1b2c3d4e5f6',
          commitUrl: 'https://gh/c/a1b2c3d',
        }),
      ]),
    );
    const row = await screen.findByRole('listitem', { name: 'v3 · Published' });
    expect(within(row).getByRole('link', { name: 'a1b2c3d' })).toHaveAttribute(
      'href',
      'https://gh/c/a1b2c3d',
    );
  });

  it('says drafts stay in CT Studio', async () => {
    withSync(linked([]));
    const row = await screen.findByRole('listitem', { name: 'v4 · Draft' });
    expect(row).toHaveTextContent('Drafts stay in CT Studio. Publish to push it.');
  });

  it('pushes a version and shows the commit link', async () => {
    const pushVersion = vi.fn(async () => ({
      kind: 'pushed' as const,
      commit: 'a1b2c3d4e5f6',
      commitUrl: 'https://gh/c/a1b2c3d',
    }));
    // The reload after the push reads what the server now holds.
    const getGitHubSync = vi
      .fn()
      .mockResolvedValueOnce(linked([sync({ version: 1, state: 'absent' })]))
      .mockResolvedValue(
        linked([
          sync({
            version: 1,
            state: 'on',
            commit: 'a1b2c3d4e5f6',
            commitUrl: 'https://gh/c/a1b2c3d',
          }),
        ]),
      );
    const api = withSync(linked([]), {}, { pushVersion, getGitHubSync });
    const row = await screen.findByRole('listitem', { name: 'v1 · Published' });
    await userEvent.click(within(row).getByRole('button', { name: 'Push v1' }));
    expect(api.pushVersion).toHaveBeenCalledWith('invoice', 1);
    expect(await within(row).findByRole('link', { name: 'a1b2c3d' })).toHaveAttribute(
      'href',
      'https://gh/c/a1b2c3d',
    );
    await waitFor(() => expect(api.getGitHubSync).toHaveBeenCalledTimes(2));
  });

  it('labels the button Push label when only the label changed', async () => {
    withSync(linked([sync({ version: 1, state: 'label' })]));
    const row = await screen.findByRole('listitem', { name: 'v1 · Published' });
    expect(within(row).getByRole('button', { name: 'Push label' })).toBeEnabled();
  });

  it('shows a pull request outcome as PR #n open', async () => {
    const pushVersion = vi.fn(async () => ({
      kind: 'pr' as const,
      prNumber: 42,
      prUrl: 'https://gh/pr/42',
    }));
    const getGitHubSync = vi
      .fn()
      .mockResolvedValueOnce(linked([sync({ version: 1, state: 'absent' })]))
      .mockResolvedValue(
        linked([sync({ version: 1, state: 'pr', prNumber: 42, prUrl: 'https://gh/pr/42' })]),
      );
    withSync(linked([]), {}, { pushVersion, getGitHubSync });
    const row = await screen.findByRole('listitem', { name: 'v1 · Published' });
    await userEvent.click(within(row).getByRole('button', { name: 'Push v1' }));
    // The push reloads the panel, which may render a new row: look the row up again (CI's
    // coverage run is slow enough to catch the old one detached).
    await waitFor(
      () =>
        expect(
          within(screen.getByRole('listitem', { name: 'v1 · Published' })).getByRole('link', {
            name: 'PR #42 open',
          }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it('shows a refused push as an alert', async () => {
    const pushVersion = vi.fn(async () => {
      throw new Error('changed on GitHub: pull first');
    });
    withSync(linked([sync({ version: 1, state: 'absent' })]), {}, { pushVersion });
    const row = await screen.findByRole('listitem', { name: 'v1 · Published' });
    await userEvent.click(within(row).getByRole('button', { name: 'Push v1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed on GitHub: pull first');
  });

  it('disables pushing with the reason as the description', async () => {
    withSync(
      linked([sync({ version: 1, state: 'absent' })], {
        canPush: false,
        reason: 'Link your GitHub account in Profile to push.',
      }),
    );
    const row = await screen.findByRole('listitem', { name: 'v1 · Published' });
    const push = within(row).getByRole('button', { name: 'Push v1' });
    expect(push).toBeDisabled();
    expect(push).toHaveAccessibleDescription('Link your GitHub account in Profile to push.');
  });

  it('says once, in plain sight, why pushing is off', async () => {
    withSync(
      linked([sync({ version: 3, state: 'absent' }), sync({ version: 1, state: 'absent' })], {
        canPush: false,
        reason: 'Link your GitHub account in Profile to push.',
      }),
    );
    const shown = await screen.findAllByText('Link your GitHub account in Profile to push.');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBeVisible();
    expect(shown[0]).not.toHaveClass('visually-hidden');
    for (const name of ['v3 · Published', 'v1 · Published']) {
      const row = screen.getByRole('listitem', { name });
      expect(within(row).queryByText('Link your GitHub account in Profile to push.')).toBeNull();
    }
  });

  it('keeps a failed push answer beside its row after the reload it causes', async () => {
    const pushVersion = vi.fn(async () => ({
      kind: 'failed' as const,
      reason: 'GitHub is slow: check Versions for the result.',
    }));
    const api = withSync(linked([sync({ version: 1, state: 'absent' })]), {}, { pushVersion });
    const row = await screen.findByRole('listitem', { name: 'v1 · Published' });
    await userEvent.click(within(row).getByRole('button', { name: 'Push v1' }));
    await waitFor(() => expect(api.getGitHubSync).toHaveBeenCalledTimes(2));
    expect(
      await within(row).findByText('GitHub is slow: check Versions for the result.'),
    ).toBeInTheDocument();
  });

  it('shows the live state once the sync view reloads, not the last push answer', async () => {
    const pushVersion = vi.fn(async () => ({
      kind: 'pushed' as const,
      commit: 'a1b2c3d4e5f6',
      commitUrl: 'https://gh/c/a1b2c3d',
    }));
    const getGitHubSync = vi
      .fn()
      .mockResolvedValueOnce(linked([sync({ version: 1, state: 'absent' })]))
      .mockResolvedValue(linked([sync({ version: 1, state: 'label' })]));
    withSync(linked([]), {}, { pushVersion, getGitHubSync });
    const row = await screen.findByRole('listitem', { name: 'v1 · Published' });
    await userEvent.click(await within(row).findByRole('button', { name: 'Push v1' }));
    expect(await within(row).findByRole('button', { name: 'Push label' })).toBeInTheDocument();
    expect(within(row).getByText('Label changed since push')).toBeInTheDocument();
  });
  it('takes the label, reloads the versions and sync, and hands the version on', async () => {
    const remote = {
      versions: [
        {
          instance: 'production',
          typeId: 'invoice',
          version: 3,
          label: 'Signed off',
          note: null,
          publishedBy: 'Ken',
          publishedAt: '2026-10-01T09:00:00.000Z',
          definitionSha256: 'abc',
          name: 'Invoice',
          commit: 'deadbeefcafe',
          path: 'ct-studio/production/invoice/v3.yaml',
          mine: true,
          compare: 'label' as const,
        },
      ],
      skipped: [],
    };
    const api = withSync(
      linked([sync({ version: 3, state: 'label' })]),
      {},
      {
        listGitHubRemote: vi.fn(async () => remote),
      },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Pull from GitHub…' }));
    await userEvent.click(await screen.findByRole('button', { name: "Take GitHub's label" }));
    await waitFor(() =>
      expect(api.takeGitHubLabel).toHaveBeenCalledWith('invoice', 3, 'deadbeefcafe'),
    );
    await waitFor(() => expect(api.getGitHubSync).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listVersions).toHaveBeenCalledTimes(2));
  });
});

describe('GitHub sync help', () => {
  it('opens from its button', async () => {
    setup(withDraft);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Help: How GitHub sync works' }),
    );
    expect(screen.getByRole('dialog', { name: 'How GitHub sync works' })).toHaveTextContent(
      'On GitHub',
    );
  });
});
