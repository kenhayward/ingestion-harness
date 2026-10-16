import { useId, useState, type FormEvent } from 'react';
import { ROLE_LABELS } from '@ih/shared';
import type { User } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';

type Role = User['role'];
const ROLE_OPTIONS: readonly { value: Role; label: string }[] = (
  ['operator', 'designer', 'admin'] as const
).map((value) => ({ value, label: ROLE_LABELS[value] }));

/** What each role may do, under the role buttons. */
const ROLE_NOTES: Record<Role, string> = {
  operator:
    'Operators upload documents, follow and review jobs, and read results. No document types, ontologies or Workbench.',
  designer: 'Designers also build and test document types in the Workbench.',
  admin: 'Admins have full access, including adding and disabling users.',
};
export interface UserFields {
  name: string;
  email: string;
  role: Role;
}

/** Good enough to send: the API checks the address properly. */
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/**
 * Add a user (`user` absent) or edit one (ADR 0013). `onSave` gets every field when adding and
 * only the changed ones when editing; a rejection stays in the dialog as an alert.
 */
export function UserDialog({
  user,
  self = false,
  onSave,
  onClose,
}: {
  user?: User;
  /** Editing your own user: the role cannot be changed. */
  self?: boolean;
  onSave: (fields: Partial<UserFields>) => Promise<void>;
  onClose: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'designer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = user !== undefined;
  const title = editing ? `Edit ${user.name}` : 'Add user';

  const changes = (): Partial<UserFields> => {
    const all = { name: name.trim(), email: email.trim(), role };
    if (!editing) return all;
    const out: Partial<UserFields> = {};
    if (all.name !== user.name) out.name = all.name;
    if (all.email !== user.email) out.email = all.email;
    if (all.role !== user.role) out.role = all.role;
    return out;
  };
  const ready =
    name.trim().length > 0 &&
    looksLikeEmail(email) &&
    (!editing || Object.keys(changes()).length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(changes());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      icon={<Icon name={editing ? 'pencil' : 'plus'} size={20} />}
      description={
        editing
          ? 'A role change applies to their open sessions at once.'
          : 'They get a one-time password, shown once, to sign in and choose their own.'
      }
      actions={
        <button type="submit" form={formId} className="primary" disabled={busy || !ready}>
          {editing ? 'Save' : 'Add user'}
        </button>
      }
    >
      <form id={formId} className="dialog-form" onSubmit={(e) => void submit(e)}>
        <label>
          Name
          <input
            value={name}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>
        <label>
          Email address
          <input
            type="email"
            value={email}
            maxLength={254}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
        </label>
        <div className="field">
          <span className="field-label">Role</span>
          <Segmented
            label="Role"
            options={ROLE_OPTIONS}
            value={role}
            onChange={setRole}
            disabled={self}
            title={self ? 'You cannot change your own role' : undefined}
          />
        </div>
        {!self && (
          <p role="note" className="field-note">
            {ROLE_NOTES[role]}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
