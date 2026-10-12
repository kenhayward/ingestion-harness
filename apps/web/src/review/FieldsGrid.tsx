import type { EditRequest } from '@ih/shared';
import type { ReviewData } from '../api/client.js';
import { EditableValue } from './EditableValue.js';
import { display, type EffectiveView } from './effective.js';

/**
 * Fields tab (UI handoff §2): the field name selects it (and finds its page), the value sits in a
 * box that shows its flag or edit, the evidence links to its page.
 */
export function FieldsGrid({
  template,
  view,
  editable,
  selected,
  onSelect,
  onPage,
  onSave,
}: {
  template: ReviewData['template'];
  view: EffectiveView;
  editable: boolean;
  selected: string | null;
  onSelect: (field: string) => void;
  onPage: (page: number) => void;
  onSave: (edit: EditRequest) => Promise<void>;
}) {
  return (
    <table aria-label="fields" className="fields-grid">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {template.outputs.fields.map((def) => {
          const f = view.fields[def.id]!;
          const name = def.name ?? def.id;
          const state = f.flags.length ? 'flagged' : f.edit ? 'edited' : '';
          return (
            <tr
              key={def.id}
              id={`flag-field:${def.id}`}
              tabIndex={-1}
              className={selected === def.id ? 'selected' : undefined}
            >
              <th scope="row" title={def.description}>
                <button
                  type="button"
                  className="field-name"
                  aria-pressed={selected === def.id}
                  onClick={() => {
                    onSelect(def.id);
                    if (f.page !== null) onPage(f.page);
                  }}
                >
                  {name}
                  <small className="mono">
                    {def.id} · {def.type}
                  </small>
                </button>
              </th>
              <td>
                <EditableValue
                  def={def}
                  value={f.value}
                  editable={editable}
                  variant="boxed"
                  state={state}
                  editLabel={`Edit ${name}`}
                  inputLabel={`New value for ${def.id}`}
                  onSave={(value) => onSave({ field: def.id, value })}
                />
                {f.flags.length > 0 && <small className="flag-text">{f.flags.join('; ')}</small>}
                {f.edit && (
                  <small className="edit-text">
                    {`Edited${f.edit.editor ? ` by ${f.edit.editor}` : ''} · was ${display(f.edit.oldValue)}`}
                  </small>
                )}
              </td>
              <td className="evidence">
                {f.evidence && <q>{f.evidence}</q>}{' '}
                {f.page !== null && (
                  <button type="button" className="link" onClick={() => onPage(f.page!)}>
                    p. {f.page}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
