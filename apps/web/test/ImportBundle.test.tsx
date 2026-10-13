import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImportBundle } from '../src/workbench/ImportBundle.js';
import { fakeApi, projectView } from './fake-api.js';

describe('ImportBundle', () => {
  it('imports a bundle, optionally under another id', async () => {
    const api = fakeApi({ importBundle: vi.fn(async () => projectView()) });
    const onImported = vi.fn();
    render(<ImportBundle api={api} onImported={onImported} />);
    const file = new File(['zip'], 'b.zip', { type: 'application/zip' });
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    await userEvent.upload(screen.getByLabelText('Bundle (.zip)'), file);
    await userEvent.type(screen.getByLabelText('Project id (optional)'), 'memo2');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(api.importBundle).toHaveBeenCalledWith(file, { id: 'memo2' }));
    expect(onImported).toHaveBeenCalled();
  });

  it('shows the server error', async () => {
    const api = fakeApi({
      importBundle: vi.fn(async () => {
        throw new Error('memo already exists here; import under another id');
      }),
    });
    const onImported = vi.fn();
    render(<ImportBundle api={api} onImported={onImported} />);
    await userEvent.upload(
      screen.getByLabelText('Bundle (.zip)'),
      new File(['zip'], 'b.zip', { type: 'application/zip' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists here');
    expect(onImported).not.toHaveBeenCalled();
  });
});
