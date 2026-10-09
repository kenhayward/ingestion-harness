import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UploadForm } from '../src/components/UploadForm.js';
import { fakeApi } from './fake-api.js';

describe('UploadForm', () => {
  it('disables upload until a file is chosen', async () => {
    render(<UploadForm api={fakeApi()} onUploaded={() => {}} />);
    expect(
      await screen.findByRole('option', { name: /Process Validation Protocol/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('uploads with the selected spec and model, then notifies the parent', async () => {
    const api = fakeApi({
      listModels: async () => [
        {
          ref: 'anthropic/claude-opus-5-5',
          provider: 'anthropic',
          providerKind: 'anthropic',
          modelId: 'claude-opus-5-5',
          displayName: 'Claude Opus 5.5',
          enabled: true,
          discoveredAt: '',
        },
      ],
    });
    const onUploaded = vi.fn();
    render(<UploadForm api={api} onUploaded={onUploaded} />);

    await screen.findByRole('option', { name: /Claude Opus 5.5/ });
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'anthropic/claude-opus-5-5');
    const file = new File(['%PDF-1.7'], 'inv.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('PDF'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));

    expect(api.upload).toHaveBeenCalledWith({
      file,
      specId: 'process-validation-protocol',
      specVersion: 1,
      model: 'anthropic/claude-opus-5-5',
    });
    expect(onUploaded).toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Queued job');
  });
});
