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
    ['general', 'General recipe settings', ['Preamble', 'Review', 'OCR', 'Delivered formats']],
    ['outputs', 'Outputs: fields and tables', ['Type', 'Description', 'exactly one step']],
    ['pipeline', 'How the pipeline runs', ['Extract steps', 'Check steps', 'Pages per call']],
    ['mapping', 'Mapping outputs to an ontology', ['literal', 'entity', 'concept', 'Shapes']],
    ['yaml', 'Editing the recipe as YAML', ['Apply YAML']],
    ['quality', 'Reading the Quality tab', ['Review rate', 'Avg attempts']],
    ['versions', 'Versions, labels and drafts', ['Replace draft', 'Label']],
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

describe('help topics for the operator pages', () => {
  it.each([
    ['home', 'Using the Home screen', ['Document type', 'Model', 'Latest job', 'Awaiting review']],
    ['jobs', 'Using the Jobs page', ['Needs attention', 'My jobs', 'Copy link', 'Clean up']],
    ['results', 'Using the Results page', ['Published', 'Issues', 'ZIP']],
  ] as const)('%s: %s', async (topic, title, mentions) => {
    render(<HelpButton topic={topic} />);
    await userEvent.click(screen.getByRole('button', { name: `Help: ${title}` }));
    const dialog = screen.getByRole('dialog', { name: title });
    for (const m of mentions) expect(dialog).toHaveTextContent(m);
  });
});

describe('help topics for the library and Workbench pages', () => {
  it.each([
    ['templates', 'Using the Document types page', ['New document type', 'Retire', 'Test run']],
    ['result', 'Reading a published result', ['edited', 'Checks', 'Issues', 'Target']],
    [
      'ontologies',
      'The ontology library',
      ['Import ontology', 'One ontology per file', 'Local only'],
    ],
    ['ontology', 'An ontology and its versions', ['Version', 'Imports', 'Delete version']],
    ['ontologyClasses', 'Classes', ['Parents', 'Children']],
    ['ontologyProperties', 'Properties', ['Domain', 'Range']],
    ['ontologyConcepts', 'Concepts and schemes', ['scheme', 'enum']],
    ['ontologyShapes', 'Shapes', ['SHACL', 'review']],
    ['workbench', 'Using the Workbench', ['New project', 'Needs you', 'Pinned', 'Import bundle']],
  ] as const)('%s: %s', async (topic, title, mentions) => {
    render(<HelpButton topic={topic} />);
    await userEvent.click(screen.getByRole('button', { name: `Help: ${title}` }));
    const dialog = screen.getByRole('dialog', { name: title });
    for (const m of mentions) expect(dialog).toHaveTextContent(m);
  });
});

describe('help topics for the Workbench tabs and Review', () => {
  it.each([
    ['wbOverview', 'The project overview', ['Next', 'Reset project']],
    ['wbSamples', 'Samples', ['dev', 'holdout', 'prepare']],
    ['wbBrief', 'The brief', ['version']],
    ['wbSurvey', 'The survey', ['Candidates', 'Ontologies', 'Pin']],
    ['wbOutputs', 'Proposing outputs', ['Accept', 'Delivered outputs']],
    ['wbSections', 'Finding section anchors', ['anchor', 'Repeats']],
    ['wbSteps', 'Proposing extraction steps', ['coverage']],
    ['wbMapping', 'Proposing a mapping', ['RDF', 'vocabulary']],
    ['wbReferences', 'References: the right answers', ['Save as reference', 'Re-verify']],
    ['wbEvaluate', 'Evaluating the recipe', ['holdout', 'threshold', 'Compare']],
    ['wbRevise', 'Revising from feedback', ['feedback', 'Not sent']],
    ['wbRecipe', 'The Recipe tab', ['Try on', 'Publish']],
    ['wbRuns', 'Test runs', ['batch']],
    ['review', 'Reviewing a document', ['Approve', 'Reject', 'Re-run', 'evidence']],
  ] as const)('%s: %s', async (topic, title, mentions) => {
    render(<HelpButton topic={topic} />);
    await userEvent.click(screen.getByRole('button', { name: `Help: ${title}` }));
    const dialog = screen.getByRole('dialog', { name: title });
    for (const m of mentions) expect(dialog).toHaveTextContent(m);
  });
});
