import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi, job } from './fake-api.js';

describe('App', () => {
  it('shows an empty state when there are no jobs', async () => {
    render(<App api={fakeApi()} pollMs={0} />);
    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument();
  });

  it('renders jobs and offers retry only for failed ones', async () => {
    const api = fakeApi({
      listJobs: async () => [
        job({ filename: 'ok.pdf', status: 'succeeded' }),
        job({ id: 'f', filename: 'bad.pdf', status: 'failed', error: 'schema mismatch' }),
      ],
    });
    render(<App api={api} pollMs={0} />);

    expect(await screen.findByText('bad.pdf')).toBeInTheDocument();
    expect(screen.getByText('schema mismatch')).toBeInTheDocument();
    const retry = screen.getAllByRole('button', { name: 'Retry' });
    expect(retry).toHaveLength(1);

    await userEvent.click(retry[0]!);
    expect(api.retryJob).toHaveBeenCalledWith('f');
  });

  it('surfaces API errors', async () => {
    render(
      <App
        api={fakeApi({
          listJobs: async () => {
            throw new Error('503 Service Unavailable');
          },
        })}
        pollMs={0}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('503');
  });
});
