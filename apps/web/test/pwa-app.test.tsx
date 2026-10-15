import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { InstallPrompt } from '../src/pwa/install.js';
import { LaunchedFiles } from '../src/pwa/launch.js';
import { fakeApi } from './fake-api.js';

const pdf = new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });
const png = new File(['x'], 'photo.png', { type: 'image/png' });
const uploads = async () => within(await screen.findByRole('list', { name: 'Uploads' }));

afterEach(() => {
  window.location.hash = '';
});

describe('files opened with CT Studio (Explorer: Open with)', () => {
  it('waits for sign-in, then lists them in the upload strip on Home', async () => {
    const launched = new LaunchedFiles();
    launched.push([pdf]);
    render(<App api={fakeApi()} pollMs={0} launched={launched} install={new InstallPrompt()} />);
    const list = await uploads();
    expect(list.getByText('invoice.pdf')).toBeInTheDocument();
    expect(list.getByText('Ready')).toBeInTheDocument();
    expect(launched.take()).toEqual([]); // handed over once
  });

  it('goes to Home from another page and marks files it cannot upload', async () => {
    window.location.hash = '#/jobs';
    const launched = new LaunchedFiles();
    render(<App api={fakeApi()} pollMs={0} launched={launched} install={new InstallPrompt()} />);
    await screen.findByText('No jobs yet.');
    act(() => launched.push([pdf, png]));
    const list = await uploads();
    expect(window.location.hash).toBe('#/');
    expect(list.getByText('invoice.pdf')).toBeInTheDocument();
    expect(list.getByText('Not a PDF or Word document')).toBeInTheDocument();
    // The person still picks the document type and presses Upload.
    expect(screen.getByRole('button', { name: 'Upload 1 file' })).toBeEnabled();
  });
});

describe('Upload documents shortcut (#/upload)', () => {
  it('opens Home with the file chooser focused, one key or click away', async () => {
    window.location.hash = '#/upload';
    render(<App api={fakeApi()} pollMs={0} launched={new LaunchedFiles()} />);
    const input = await screen.findByLabelText('PDF or Word files');
    await waitFor(() => expect(input).toHaveFocus());
    expect(document.title).toBe('Home · CT Studio');
  });
});

/** Chromium's beforeinstallprompt event. */
function offer(target: EventTarget) {
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => {}),
    userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('Install CT Studio', () => {
  it('appears in the top bar only while the browser offers install', async () => {
    const target = new EventTarget();
    const install = new InstallPrompt(target);
    render(<App api={fakeApi()} pollMs={0} install={install} launched={new LaunchedFiles()} />);
    const banner = await screen.findByRole('banner');
    expect(within(banner).queryByRole('button', { name: 'Install CT Studio' })).toBeNull();

    const event = offer(target);
    await userEvent.click(within(banner).getByRole('button', { name: 'Install CT Studio' }));
    expect(event.prompt).toHaveBeenCalled();
    await waitFor(() =>
      expect(within(banner).queryByRole('button', { name: 'Install CT Studio' })).toBeNull(),
    );
  });

  it('goes away once the app is installed', async () => {
    const target = new EventTarget();
    const install = new InstallPrompt(target);
    render(<App api={fakeApi()} pollMs={0} install={install} launched={new LaunchedFiles()} />);
    const banner = await screen.findByRole('banner');
    offer(target);
    expect(within(banner).getByRole('button', { name: 'Install CT Studio' })).toBeInTheDocument();
    act(() => {
      target.dispatchEvent(new Event('appinstalled'));
    });
    expect(within(banner).queryByRole('button', { name: 'Install CT Studio' })).toBeNull();
  });

  it("is in an admin's account menu too", async () => {
    const target = new EventTarget();
    const install = new InstallPrompt(target);
    const api = fakeApi({
      me: vi.fn(async () => ({
        role: 'admin' as const,
        label: 'Ken',
        email: null,
        mustChangePassword: false,
        userId: 'u-test',
      })),
    });
    render(<App api={api} pollMs={0} install={install} launched={new LaunchedFiles()} />);
    const banner = await screen.findByRole('banner');
    const event = offer(target);
    await userEvent.click(
      within(banner).getByRole('button', { name: 'Ken (admin): account menu' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Install CT Studio' }));
    expect(event.prompt).toHaveBeenCalled();
  });
});
