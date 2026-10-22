import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JobActions } from '../src/jobs/JobActions.js';
import { fakeApi, job, MODEL_CHOICES } from './fake-api.js';

describe('JobActions delete', () => {
  it('names the targets whose content stays after a delete', async () => {
    render(
      <JobActions
        api={fakeApi()}
        job={job({ filename: 'a.pdf', status: 'succeeded' })}
        onChanged={vi.fn()}
        models={MODEL_CHOICES}
        variant="panel"
        staysIn={['Fake target']}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/Delete a\.pdf\?/)).toHaveTextContent(
      'Published outputs and its graph are withdrawn. This content stays in Fake target.',
    );
  });
});
