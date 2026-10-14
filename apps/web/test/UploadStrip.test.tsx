import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { UploadRequest } from '../src/api/client.js';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UploadStrip } from '../src/jobs/UploadStrip.js';
import { fakeApi, job } from './fake-api.js';

describe('UploadStrip', () => {
  it('disables upload until a file is chosen', async () => {
    render(<UploadStrip api={fakeApi()} onUploaded={() => {}} />);
    expect(
      await screen.findByRole('option', { name: /Process Validation Protocol/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('uploads with the selected spec and model choice, then notifies the parent', async () => {
    const api = fakeApi();
    const onUploaded = vi.fn();
    render(<UploadStrip api={api} onUploaded={onUploaded} />);

    await screen.findByRole('option', { name: /New for testing only/ });
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'test');
    expect(screen.queryByText('ryzen/openai/gpt-oss-20b')).toBeNull();
    const file = new File(['%PDF-1.7'], 'inv.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));

    expect(api.upload).toHaveBeenCalledWith({
      file,
      specId: 'process-validation-protocol',
      specVersion: 1,
      model: 'test',
    });
    expect(onUploaded).toHaveBeenCalled();
    const uploads = await screen.findByRole('list', { name: 'Uploads' });
    expect(await within(uploads).findByText('Queued')).toBeInTheDocument();
  });
});

describe('UploadStrip document types', () => {
  it('offers only the newest version of each document type', async () => {
    const api = fakeApi({
      listSpecs: vi.fn(async () => [
        { id: 'letter', version: 1, title: 'Letter' },
        { id: 'letter', version: 3, title: 'Letter' },
        { id: 'memo', version: 2, title: 'Memo' },
        { id: 'letter', version: 2, title: 'Letter' },
      ]),
    });
    render(<UploadStrip api={api} onUploaded={() => {}} />);
    const select = screen.getByLabelText('Document type');
    await screen.findByRole('option', { name: 'Memo · v2' });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Letter · v3',
      'Memo · v2',
    ]);
  });

  it('never offers a retired document type', async () => {
    const api = fakeApi({
      listSpecs: vi.fn(async () => [
        { id: 'letter', version: 1, title: 'Letter' },
        {
          id: 'memo',
          version: 2,
          title: 'Memo',
          retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: null },
        },
      ]),
    });
    render(<UploadStrip api={api} onUploaded={() => {}} />);
    await screen.findByRole('option', { name: 'Letter · v1' });
    expect(screen.queryByRole('option', { name: 'Memo · v2' })).not.toBeInTheDocument();
    expect(api.listSpecs).toHaveBeenCalledWith();
  });
});

describe("UploadStrip names the document type's model", () => {
  it('shows which choice the selected type runs when no model is picked', async () => {
    const api = fakeApi({
      listSpecs: vi.fn(async () => [
        { id: 'letter', version: 1, title: 'Letter', model: 'test' },
        { id: 'memo', version: 1, title: 'Memo' },
      ]),
    });
    render(<UploadStrip api={api} onUploaded={() => {}} />);
    // The last listed type is selected first.
    expect(
      await screen.findByRole('option', { name: "Document type's model (Main Production Model)" }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Document type'), 'Letter · v1');
    expect(
      screen.getByRole('option', { name: "Document type's model (New for testing only)" }),
    ).toBeInTheDocument();
  });
});

describe('UploadStrip remembers the model', () => {
  const opus = { ref: 'test' }; // the choice "New for testing only"
  const api = () => fakeApi();

  it("saves the selection, and forgets it for the document type's models", async () => {
    render(<UploadStrip api={api()} onUploaded={() => {}} />);
    await screen.findByRole('option', { name: /New for testing only/ });
    await userEvent.selectOptions(screen.getByLabelText('Model'), opus.ref);
    expect(localStorage.getItem('ih.uploadModel')).toBe(opus.ref);
    await userEvent.selectOptions(screen.getByLabelText('Model'), '');
    expect(localStorage.getItem('ih.uploadModel')).toBeNull();
  });

  it('restores it on the next visit', async () => {
    localStorage.setItem('ih.uploadModel', opus.ref);
    render(<UploadStrip api={api()} onUploaded={() => {}} />);
    await screen.findByRole('option', { name: /New for testing only/ });
    expect(screen.getByLabelText('Model')).toHaveValue(opus.ref);
  });

  it('keeps it across uploads', async () => {
    const a = api();
    render(<UploadStrip api={a} onUploaded={() => {}} />);
    await screen.findByRole('option', { name: /New for testing only/ });
    await userEvent.selectOptions(screen.getByLabelText('Model'), opus.ref);
    const file = new File(['%PDF-1.7'], 'inv.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveValue(opus.ref);
  });

  it("falls back to the document type's models when the saved choice is gone", async () => {
    localStorage.setItem('ih.uploadModel', 'anthropic/retired');
    render(<UploadStrip api={fakeApi()} onUploaded={() => {}} />);
    await waitFor(() => expect(localStorage.getItem('ih.uploadModel')).toBeNull());
    expect(screen.getByLabelText('Model')).toHaveValue('');
  });

  it('works when storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      render(<UploadStrip api={api()} onUploaded={() => {}} />);
      await screen.findByRole('option', { name: /New for testing only/ });
      await userEvent.selectOptions(screen.getByLabelText('Model'), opus.ref);
      expect(screen.getByLabelText('Model')).toHaveValue(opus.ref);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('UploadStrip with several files', () => {
  const pdf = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });
  const ready = () => screen.findByRole('option', { name: /Process Validation Protocol/ });

  it('uploads several files, one job each, in order, with a status per file', async () => {
    const upload = vi.fn(async (req: UploadRequest) => job({ filename: req.file.name }));
    const onUploaded = vi.fn();
    render(<UploadStrip api={fakeApi({ upload })} onUploaded={onUploaded} />);
    await ready();
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), [
      pdf('a.pdf'),
      pdf('b.pdf'),
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map((c) => c[0].file.name)).toEqual(['a.pdf', 'b.pdf']);
    const list = screen.getByRole('list', { name: 'Uploads' });
    expect(within(list).getByText('a.pdf')).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByText('Queued')).toHaveLength(2));
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one file fails and keeps the failed file to retry', async () => {
    const upload = vi.fn(async (req: UploadRequest) => {
      if (req.file.name === 'bad.pdf') throw new Error('413 Payload Too Large');
      return job({ filename: req.file.name });
    });
    render(<UploadStrip api={fakeApi({ upload })} onUploaded={vi.fn()} />);
    await ready();
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), [
      pdf('bad.pdf'),
      pdf('ok.pdf'),
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
    const list = screen.getByRole('list', { name: 'Uploads' });
    expect(
      await within(list).findByText('Upload failed: 413 Payload Too Large'),
    ).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Upload 1 file' })).toBeEnabled();
  });

  it('skips dropped files that are not PDFs', async () => {
    const upload = vi.fn(async (req: UploadRequest) => job({ filename: req.file.name }));
    render(<UploadStrip api={fakeApi({ upload })} onUploaded={vi.fn()} />);
    await ready();
    const notes = new File(['x'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByText('Drop PDF or Word files here'), {
      dataTransfer: { files: [pdf('a.pdf'), notes], types: ['Files'] },
    });
    const list = screen.getByRole('list', { name: 'Uploads' });
    expect(within(list).getByText('notes.txt')).toBeInTheDocument();
    expect(within(list).getByText('Not a PDF or Word document')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]![0].file.name).toBe('a.pdf');
  });

  it('takes Word documents, even without a browser type', async () => {
    const upload = vi.fn(async (req: UploadRequest) => job({ filename: req.file.name }));
    render(<UploadStrip api={fakeApi({ upload })} onUploaded={vi.fn()} />);
    await ready();
    const word = new File(['PK'], 'REPORT.DOCX');
    fireEvent.drop(screen.getByText('Drop PDF or Word files here'), {
      dataTransfer: { files: [word], types: ['Files'] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]![0].file.name).toBe('REPORT.DOCX');
  });

  it('keeps in-progress rows when files are added during an upload', async () => {
    let finish!: () => void;
    const upload = vi.fn(
      (req: UploadRequest) =>
        new Promise<ReturnType<typeof job>>((resolve) => {
          finish = () => resolve(job({ filename: req.file.name }));
        }),
    );
    render(<UploadStrip api={fakeApi({ upload })} onUploaded={vi.fn()} />);
    await ready();
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), [pdf('a.pdf')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    await screen.findByText('Uploading…');
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), [pdf('b.pdf')]);
    const list = screen.getByRole('list', { name: 'Uploads' });
    expect(within(list).getByText('a.pdf')).toBeInTheDocument();
    expect(within(list).getByText('b.pdf')).toBeInTheDocument();
    finish();
    expect(await within(list).findByText('Queued')).toBeInTheDocument();
    expect(within(list).getByText('a.pdf')).toBeInTheDocument();
  });

  it('starts a fresh selection after a finished batch', async () => {
    render(<UploadStrip api={fakeApi()} onUploaded={vi.fn()} />);
    await ready();
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), [pdf('a.pdf')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    await screen.findByText('Queued');
    await userEvent.upload(screen.getByLabelText('PDF or Word files'), [pdf('b.pdf')]);
    const list = screen.getByRole('list', { name: 'Uploads' });
    expect(within(list).queryByText('a.pdf')).not.toBeInTheDocument();
    expect(within(list).getByText('b.pdf')).toBeInTheDocument();
  });
});
