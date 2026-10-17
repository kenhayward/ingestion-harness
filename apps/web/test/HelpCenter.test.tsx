import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HelpCenter } from '../src/help/HelpCenter.js';
import { HELP_INDEX, helpEntries } from '../src/help/index.js';
import { HELP_TOPICS } from '../src/help/topics.js';
import { HelpButton, HelpCenterContext } from '../src/ui/Help.js';

describe('help index', () => {
  it('lists every help topic exactly once, Introduction first', () => {
    const listed = helpEntries().map((e) => e.topic);
    expect([...listed].sort()).toEqual(Object.keys(HELP_TOPICS).sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(HELP_INDEX[0]!.topic).toBe('introduction');
  });

  it('nests the Workbench tabs under Workbench and Review under Jobs', () => {
    const wb = HELP_INDEX.find((e) => e.topic === 'workbench')!;
    expect(wb.children?.map((c) => c.topic)).toEqual([
      'wbOverview',
      'wbSamples',
      'wbBrief',
      'wbSurvey',
      'wbOutputs',
      'wbSections',
      'wbSteps',
      'wbMapping',
      'wbReferences',
      'wbEvaluate',
      'wbRevise',
      'wbRecipe',
      'wbRuns',
    ]);
    const jobs = HELP_INDEX.find((e) => e.topic === 'jobs')!;
    expect(jobs.children?.map((c) => c.topic)).toEqual(['review']);
  });

  it('gathers the administration topics under Administration, last', () => {
    const admin = HELP_INDEX.at(-1)!;
    expect(admin.topic).toBe('administration');
    expect(admin.children?.map((c) => c.topic)).toEqual([
      'adminModels',
      'adminLinkedData',
      'published-outputs',
      'adminUsers',
      'github-sync',
      'backup',
    ]);
  });

  it('nests the parts of a screen under it', () => {
    const types = HELP_INDEX.find((e) => e.topic === 'templates')!;
    expect(types.children?.map((c) => c.topic)).toEqual([
      'general',
      'sections',
      'outputs',
      'pipeline',
      'mapping',
      'yaml',
      'quality',
      'versions',
    ]);
    const ontologies = HELP_INDEX.find((e) => e.topic === 'ontologies')!;
    expect(ontologies.children?.map((c) => c.topic)).toEqual([
      'ontology',
      'ontologyClasses',
      'ontologyProperties',
      'ontologyConcepts',
      'ontologyShapes',
    ]);
  });
});

describe('HelpCenter', () => {
  it('opens on the introduction, beside the app mark and the help menu', () => {
    render(<HelpCenter onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Help' });
    expect(within(dialog).getByText('CT Studio')).toBeInTheDocument();
    expect(dialog.querySelector('.help-center-side svg')).not.toBeNull();
    const menu = within(dialog).getByRole('navigation', { name: 'Help topics' });
    expect(within(menu).getByRole('button', { name: 'Introduction' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(dialog).getByRole('heading', { level: 3, name: 'What CT Studio does' }),
    ).toBeInTheDocument();
  });

  it('lists only the main topics until one is opened', async () => {
    render(<HelpCenter onClose={vi.fn()} />);
    const menu = screen.getByRole('navigation', { name: 'Help topics' });
    expect(
      within(menu)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(HELP_INDEX.map((e) => e.label));
    const types = within(menu).getByRole('button', { name: 'Document types' });
    expect(types).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(types);
    expect(types).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('/ Using the Document types page')).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Pipeline' })).toBeInTheDocument();
    // Opening another main topic closes the first one's list.
    await userEvent.click(within(menu).getByRole('button', { name: 'Administration' }));
    expect(within(menu).queryByRole('button', { name: 'Pipeline' })).toBeNull();
    expect(within(menu).getByRole('button', { name: 'Users' })).toBeInTheDocument();
  });

  it('opens with the list of the topic it starts on', () => {
    render(<HelpCenter topic="pipeline" onClose={vi.fn()} />);
    const menu = screen.getByRole('navigation', { name: 'Help topics' });
    expect(within(menu).getByRole('button', { name: 'Pipeline' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(menu).getByRole('button', { name: 'Document types' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(menu).queryByRole('button', { name: 'Overview' })).toBeNull();
  });

  it('moves through the open menu with the arrow keys', async () => {
    render(<HelpCenter topic="results" onClose={vi.fn()} />);
    const menu = screen.getByRole('navigation', { name: 'Help topics' });
    within(menu).getByRole('button', { name: 'Results' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('button', { name: 'A published result' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    // The next main topic: its list opens and the Results list closes.
    expect(within(menu).getByRole('button', { name: 'Document types' })).toHaveFocus();
    expect(within(menu).queryByRole('button', { name: 'A published result' })).toBeNull();
  });

  it('shows the topic picked in the menu, nested items included', async () => {
    render(<HelpCenter onClose={vi.fn()} />);
    const menu = screen.getByRole('navigation', { name: 'Help topics' });
    await userEvent.click(within(menu).getByRole('button', { name: 'Document types' }));
    await userEvent.click(within(menu).getByRole('button', { name: 'Sections' }));
    expect(within(menu).getByRole('button', { name: 'Sections' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('/ How sections work')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Key from' })).toBeInTheDocument();
  });

  it('opens on a given topic', () => {
    render(<HelpCenter topic="pipeline" onClose={vi.fn()} />);
    expect(screen.getByText('/ How the pipeline runs')).toBeInTheDocument();
  });

  it('closes with Close and with Escape', async () => {
    const onClose = vi.fn();
    render(<HelpCenter onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Open in Help', () => {
  it('a ? dialog opens its topic in the Help dialog', async () => {
    const openHelp = vi.fn();
    render(
      <HelpCenterContext.Provider value={openHelp}>
        <HelpButton topic="sections" />
      </HelpCenterContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Help: How sections work' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open in Help' }));
    expect(openHelp).toHaveBeenCalledWith('sections');
    expect(screen.queryByRole('dialog', { name: 'How sections work' })).not.toBeInTheDocument();
  });

  it('is not offered where there is no Help dialog', async () => {
    render(<HelpButton topic="sections" />);
    await userEvent.click(screen.getByRole('button', { name: 'Help: How sections work' }));
    expect(screen.queryByRole('button', { name: 'Open in Help' })).not.toBeInTheDocument();
  });
});
