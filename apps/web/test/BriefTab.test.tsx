import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { BriefTab } from '../src/workbench/BriefTab.js';
import { fakeApi } from './fake-api.js';

describe('BriefTab', () => {
  it('saves the brief as a new version', async () => {
    const saved = {
      projectId: 'letter',
      version: 3,
      body: { ...EMPTY_BRIEF, purpose: 'QA batch records' },
      createdAt: '',
    };
    const onSaved = vi.fn();
    const api = fakeApi({ saveBrief: vi.fn(async () => saved) });
    render(<BriefTab api={api} projectId="letter" brief={null} onSaved={onSaved} />);
    const save = screen.getByRole('button', { name: 'Save brief' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Purpose'), 'QA batch records');
    await userEvent.click(save);
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...EMPTY_BRIEF, purpose: 'QA batch records' });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(await screen.findByRole('status')).toHaveTextContent('Saved as version 3');
  });

  it('starts from the latest version', () => {
    render(
      <BriefTab
        api={fakeApi()}
        projectId="letter"
        brief={{ projectId: 'letter', version: 2, body: { ...EMPTY_BRIEF, rules: 'Dates are DMY' }, createdAt: '' }}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Rules')).toHaveValue('Dates are DMY');
    expect(screen.getByText('Version 2')).toBeInTheDocument();
  });
});
