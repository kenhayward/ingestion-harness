import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TabHeader, TabHelpTopic } from '../src/workbench/TabHeader.js';

describe('TabHeader', () => {
  it('shows the title, the status in words and the note', () => {
    render(
      <TabHeader
        title="Extraction steps"
        item={{ stage: 'steps', state: 'proposed', status: 'Needs your decision', metrics: [] }}
        note="Runs on local models; holdout samples are never sent."
        actions={<button type="button">Propose again</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Extraction steps' })).toBeInTheDocument();
    expect(screen.getByText('Needs your decision')).toBeInTheDocument();
    expect(
      screen.getByText('Runs on local models; holdout samples are never sent.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeInTheDocument();
  });

  it('has only the title while the overview is loading', () => {
    const { container } = render(<TabHeader title="Samples" item={null} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Samples' })).toBeInTheDocument();
    expect(container.querySelector('.tab-status')).toBeNull();
  });

  it('has no status line for a tab without status', () => {
    const { container } = render(
      <TabHeader
        title="Template"
        item={{ stage: 'template', state: 'none', status: 'Draft v2', metrics: [] }}
      />,
    );
    expect(container.querySelector('.tab-status')).toBeNull();
  });

  it('says what the tab does above the policy note', () => {
    render(
      <TabHeader
        title="Outputs"
        item={null}
        description="The fields and tables every document of this type produces."
        note="Runs on local models; holdout samples are never sent."
      />,
    );
    const [description, note] = Array.from(document.querySelectorAll('.tab-note'));
    expect(description).toHaveTextContent(
      'The fields and tables every document of this type produces.',
    );
    expect(note).toHaveTextContent('Runs on local models; holdout samples are never sent.');
  });
});

describe('TabHeader help', () => {
  it("puts the tab's help after its actions, at the right", () => {
    render(
      <TabHelpTopic.Provider value="wbSteps">
        <TabHeader
          title="Extraction steps"
          item={null}
          actions={<button type="button">Propose again</button>}
        />
      </TabHelpTopic.Provider>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Propose again',
      'Help: Proposing extraction steps',
    ]);
  });

  it('has no help outside a project tab', () => {
    render(<TabHeader title="Samples" item={null} />);
    expect(screen.queryByRole('button', { name: /^Help:/ })).toBeNull();
  });
});
