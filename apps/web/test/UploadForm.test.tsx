import { render, screen, waitFor } from '@testing-library/react';
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

describe('UploadForm remembers the model', () => {
  const opus = {
    ref: 'anthropic/claude-opus-5-5',
    provider: 'anthropic',
    providerKind: 'anthropic' as const,
    modelId: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    enabled: true,
    discoveredAt: '',
  };
  const api = () => fakeApi({ listModels: async () => [opus] });

  it('saves the selection, and forgets it for spec default', async () => {
    render(<UploadForm api={api()} onUploaded={() => {}} />);
    await screen.findByRole('option', { name: /Claude Opus 5.5/ });
    await userEvent.selectOptions(screen.getByLabelText('Model'), opus.ref);
    expect(localStorage.getItem('ih.uploadModel')).toBe(opus.ref);
    await userEvent.selectOptions(screen.getByLabelText('Model'), '');
    expect(localStorage.getItem('ih.uploadModel')).toBeNull();
  });

  it('restores it on the next visit and reports it (for Retry)', async () => {
    localStorage.setItem('ih.uploadModel', opus.ref);
    const onModelChange = vi.fn();
    render(<UploadForm api={api()} onUploaded={() => {}} onModelChange={onModelChange} />);
    await screen.findByRole('option', { name: /Claude Opus 5.5/ });
    expect(screen.getByLabelText('Model')).toHaveValue(opus.ref);
    expect(onModelChange).toHaveBeenCalledWith(opus.ref);
  });

  it('keeps it across uploads', async () => {
    const a = api();
    render(<UploadForm api={a} onUploaded={() => {}} />);
    await screen.findByRole('option', { name: /Claude Opus 5.5/ });
    await userEvent.selectOptions(screen.getByLabelText('Model'), opus.ref);
    const file = new File(['%PDF-1.7'], 'inv.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('PDF'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText(/Queued job/)).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveValue(opus.ref);
  });

  it('falls back to spec default when the saved model is gone or disabled', async () => {
    localStorage.setItem('ih.uploadModel', 'anthropic/retired');
    const onModelChange = vi.fn();
    render(
      <UploadForm
        api={fakeApi({ listModels: async () => [{ ...opus, ref: 'local/x', enabled: false }] })}
        onUploaded={() => {}}
        onModelChange={onModelChange}
      />,
    );
    await waitFor(() => expect(localStorage.getItem('ih.uploadModel')).toBeNull());
    expect(screen.getByLabelText('Model')).toHaveValue('');
    expect(onModelChange).not.toHaveBeenCalledWith('anthropic/retired');
  });

  it('works when storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      render(<UploadForm api={api()} onUploaded={() => {}} />);
      await screen.findByRole('option', { name: /Claude Opus 5.5/ });
      await userEvent.selectOptions(screen.getByLabelText('Model'), opus.ref);
      expect(screen.getByLabelText('Model')).toHaveValue(opus.ref);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
