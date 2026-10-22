import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Api } from '../api/client.js';
import { loadTheme, themeAttr } from '../theme.js';
import { useModalFocus } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { connectionsModal, pageMessage, useConnectionsModal } from './connections.js';

/**
 * The delivery bridge's connections page in a modal (ADR 0017): the page, on its own origin, in
 * a sandboxed frame, so CT Studio's scripts never reach what is typed into it. The page tells
 * CT Studio when connections changed (its lists re-read) or its session ended (Reopen mints a
 * new link). Only Close closes it, or Escape while focus is out of the frame: never a click
 * outside, so nothing typed is lost to a stray click.
 */
export function ConnectionsDialog({ api }: { api: Api }) {
  const { link, ended } = useConnectionsModal();
  if (!link) return null;
  return <Open api={api} ended={ended} />;
}

function Open({ api, ended }: { api: Api; ended: boolean }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const trapTab = useModalFocus(box);
  const { link } = useConnectionsModal();
  const [reopening, setReopening] = useState<string | null>(null);

  useEffect(() => {
    if (!link) return;
    const onMessage = (e: MessageEvent) => {
      const said = pageMessage(e, link, frame.current?.contentWindow ?? null);
      if (said === 'connections-changed') connectionsModal.changed();
      else if (said === 'session-ended') connectionsModal.ended();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [link]);

  const reopen = async () => {
    setReopening(null);
    try {
      const theme = themeAttr(loadTheme());
      connectionsModal.show(await api.connectionsLink(theme ?? undefined));
    } catch (err) {
      setReopening((err as Error).message);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') connectionsModal.close();
    else trapTab(e);
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={box}
        className="dialog dialog-rich connections-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="connections-dialog-header">
          <Icon name="plug" size={18} />
          <h2 id={titleId}>Connections</h2>
          <button type="button" onClick={() => connectionsModal.close()}>
            Close
          </button>
        </div>
        {ended || !link ? (
          <div className="connections-dialog-ended">
            <p>Your session ended</p>
            <p className="muted">Open the page again to go on.</p>
            {reopening && (
              <p role="alert" className="field-error">
                <Icon name="alert" />
                {reopening}
              </p>
            )}
            <button type="button" className="primary" onClick={() => void reopen()}>
              Reopen
            </button>
          </div>
        ) : (
          <iframe
            ref={frame}
            key={link.url}
            className="connections-frame"
            title="Connections"
            src={link.url}
            sandbox="allow-forms allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}
