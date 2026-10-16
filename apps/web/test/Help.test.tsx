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
