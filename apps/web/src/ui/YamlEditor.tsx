import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

/**
 * Colour-coded YAML editor (CodeMirror 6). Tokens get stable `tok-*` classes, coloured from the
 * design tokens in styles.css, so it follows the light/dark theme without a CodeMirror theme.
 */
export function YamlEditor({
  label,
  value,
  onChange,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  /** Latest callback, read by the update listener (created once). */
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          yaml(),
          syntaxHighlighting(classHighlighter),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
          editable.current.of(readOnlyExtensions(readOnly)),
          EditorView.updateListener.of((u) => {
            // Only user edits: a value pushed in from props is not an edit.
            if (u.docChanged && !u.transactions.some((t) => t.annotation(External)))
              changed.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; value and readOnly changes are pushed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      annotations: External.of(true),
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(readOnlyExtensions(readOnly)),
    });
  }, [readOnly]);

  return <div ref={host} className="yaml-editor" />;
}

/** Marks a transaction that mirrors the `value` prop rather than a user edit. */
const External = Annotation.define<boolean>();

const readOnlyExtensions = (readOnly: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
  EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
];
