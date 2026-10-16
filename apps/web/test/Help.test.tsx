import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HELP_TOPICS } from '../src/help/topics.js';
import { HelpButton } from '../src/ui/Help.js';

describe('HelpButton', () => {
  it('opens its topic in a dialog and gives focus back on Close', async () => {
    render(<HelpButton topic="sections" />);
    const button = screen.getByRole('button', { name: 'Help: How sections work' });
    await userEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'How sections work' });
    expect(dialog).toHaveTextContent('Key from');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes on Escape', async () => {
    render(<HelpButton topic="sections" />);
    await userEvent.click(screen.getByRole('button', { name: 'Help: How sections work' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('every topic has a title and content', () => {
    for (const topic of Object.values(HELP_TOPICS)) {
      expect(topic.title.length).toBeGreaterThan(0);
      expect(topic.body).toBeTruthy();
    }
  });
});

describe('Sections help', () => {
  it('explains each setting and how they interact', async () => {
    render(<HelpButton topic="sections" />);
    await userEvent.click(screen.getByRole('button', { name: 'Help: How sections work' }));
    const dialog = screen.getByRole('dialog', { name: 'How sections work' });
    for (const heading of ['Anchor', 'Required', 'Repeats', 'Key', 'Key from', 'Key column']) {
      expect(screen.getByRole('heading', { name: heading, level: 3 })).toBeInTheDocument();
    }
    expect(dialog).toHaveTextContent('runs to the next section');
    expect(dialog).toHaveTextContent('Its own Key wins');
    expect(dialog).toHaveTextContent('needs review');
  });
});

describe('GitHub sync help', () => {
  it('covers the folder layout, drafts, the chips and who links', async () => {
    render(<HelpButton topic="github-sync" />);
    await userEvent.click(screen.getByRole('button', { name: 'Help: How GitHub sync works' }));
    const dialog = screen.getByRole('dialog', { name: 'How GitHub sync works' });
    for (const text of [
      'ct-studio/<deployment>/<document type>/v<N>.yaml',
      'On GitHub',
      'Label changed since push',
      'Not on GitHub',
      'PR #n open',
      'Different on GitHub',
      'Take GitHub',
      'Use as draft',
      'Drafts stay in CT Studio',
      'Only admins',
      'never blocks publishing',
    ]) {
      expect(dialog).toHaveTextContent(text);
    }
    expect(dialog).not.toHaveTextContent(/template/i);
  });
});

describe('help topics for the recipe tabs', () => {
  it.each([
    [
      'general',
      'General recipe settings',
      ['Preamble', 'Review', 'OCR', 'Delivered formats', 'Publish to'],
    ],
    ['outputs', 'Outputs: fields and tables', ['Type', 'Description', 'exactly one step']],
    ['pipeline', 'How the pipeline runs', ['Extract steps', 'Check steps', 'Pages per call']],
    ['mapping', 'Mapping outputs to an ontology', ['literal', 'entity', 'concept', 'Shapes']],
    ['yaml', 'Editing the recipe as YAML', ['Apply YAML']],
    ['quality', 'Reading the Quality tab', ['Review rate', 'Avg attempts']],
    ['versions', 'Versions, labels and drafts', ['Replace draft', 'Label']],
    [
      'published-outputs',
      'How publishing targets work',
      ['Internal', 'External', 'default', 'new version', 'locked', 'S3 keys'],
    ],
  ] as const)('%s: %s', async (topic, title, mentions) => {
    render(<HelpButton topic={topic} />);
    await userEvent.click(screen.getByRole('button', { name: `Help: ${title}` }));
    const dialog = screen.getByRole('dialog', { name: title });
    for (const m of mentions) expect(dialog).toHaveTextContent(m);
  });

  it('opens in the wider help dialog', async () => {
    render(<HelpButton topic="sections" />);
    await userEvent.click(screen.getByRole('button', { name: 'Help: How sections work' }));
    expect(screen.getByRole('dialog')).toHaveClass('help-dialog');
  });
});
