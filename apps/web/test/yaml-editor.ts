import { EditorView } from '@codemirror/view';
import { act, screen } from '@testing-library/react';

/** Replace the whole document as a user edit would (jsdom can't type into CodeMirror). */
export function setYaml(label: string, text: string) {
  const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: label }));
  if (!view) throw new Error(`no editor labelled ${label}`);
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}
