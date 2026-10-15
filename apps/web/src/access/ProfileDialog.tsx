import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { GitHubLinkResult, GitHubRepo, Profile } from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { Avatar } from '../shell/Avatar.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { useModalFocus } from '../ui/Dialog.js';
import { ChangePassword } from './ChangePassword.js';

export type ProfileTab = 'details' | 'password';

const TABS: { id: ProfileTab; label: string; icon: IconName }[] = [
  { id: 'details', label: 'Personal details', icon: 'user' },
  { id: 'password', label: 'Change password', icon: 'lock' },
];

/** How the GitHub link ended (`?github=` on the way back from GitHub), as the person reads it. */
const LINK_RESULT: Record<GitHubLinkResult, { ok: boolean; text: string }> = {
  linked: { ok: true, text: 'GitHub account linked.' },
  denied: { ok: false, text: 'GitHub did not link the account: you declined on GitHub.' },
  expired: {
    ok: false,
    text: 'The GitHub link took too long or was started elsewhere: try again.',
  },
  taken: { ok: false, text: 'That GitHub account is linked to another user.' },
  failed: { ok: false, text: 'GitHub could not be reached to link the account: try again.' },
};

/**
 * The account menu's Profile (docs/design/profile.md): a ledger of tabs beside the open tab, each
 * saving on its own. Only Close closes it: not a click outside, not Escape, so typed details are
 * never lost by a stray click.
 */
export function ProfileDialog({
  api,
  me,
  initialTab = 'details',
  githubResult,
  onChanged,
  onClose,
  onSignOut,
}: {
  api: Api;
  me: Me;
  initialTab?: ProfileTab;
  /** Set when the app opened again after GitHub sent the browser back. */
  githubResult?: GitHubLinkResult;
  /** The name or picture may have changed: the app re-reads who is signed in. */
  onChanged: () => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const titleId = useId();
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  const trapTab = useModalFocus(box);
  const tabRefs = useRef(new Map<ProfileTab, HTMLButtonElement>());
  const current = TABS.find((t) => t.id === tab)!;

  const onTabKey = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(current) + step + TABS.length) % TABS.length]!;
    setTab(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={box}
        className="dialog profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
      >
        <aside className="profile-side">
          <div className="profile-id">
            <Avatar name={me.label} url={me.avatarUrl} size="large" />
            <span className="profile-who">{me.label}</span>
          </div>
          <div
            role="tablist"
            aria-label="Profile sections"
            aria-orientation="vertical"
            className="profile-tabs"
            onKeyDown={onTabKey}
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(t.id, el);
                }}
                type="button"
                role="tab"
                id={`${ids}-tab-${t.id}`}
                aria-selected={t.id === tab}
                aria-controls={`${ids}-panel-${t.id}`}
                tabIndex={t.id === tab ? 0 : -1}
                onClick={() => setTab(t.id)}
              >
                <Icon name={t.icon} size={18} />
                {t.label}
              </button>
            ))}
          </div>
        </aside>
        <section className="profile-main">
          <header className="profile-header">
            <h2 id={titleId}>Profile</h2>
            <span className="muted">/ {current.label}</span>
          </header>
          <div
            className="profile-body"
            role="tabpanel"
            id={`${ids}-panel-${tab}`}
            aria-labelledby={`${ids}-tab-${tab}`}
          >
            {tab === 'details' ? (
              <PersonalDetails api={api} githubResult={githubResult} onChanged={onChanged} />
            ) : (
              <ChangePassword
                api={api}
                me={me}
                mode="embedded"
                onDone={() => undefined}
                onSignOut={onSignOut}
              />
            )}
          </div>
          <footer className="profile-footer">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}

interface DetailsForm {
  name: string;
  jobTitle: string;
  company: string;
  linkedin: string;
}

const formOf = (p: Profile): DetailsForm => ({
  name: p.name,
  jobTitle: p.jobTitle ?? '',
  company: p.company ?? '',
  linkedin: p.linkedin ?? '',
});

const same = (a: DetailsForm, b: DetailsForm) =>
  (Object.keys(a) as (keyof DetailsForm)[]).every((k) => a[k].trim() === b[k].trim());

/** One labelled text input of the details form. */
function Field({
  label,
  value,
  onChange,
  hint,
  readOnly = false,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  hint?: string;
  readOnly?: boolean;
  autoComplete?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        readOnly={readOnly}
        autoComplete={autoComplete}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {hint && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
    </div>
  );
}

function PersonalDetails({
  api,
  githubResult,
  onChanged,
}: {
  api: Api;
  githubResult?: GitHubLinkResult;
  onChanged: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState<DetailsForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    api.getProfile().then(
      (p) => {
        if (!live) return;
        setProfile(p);
        setForm(formOf(p));
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (!profile || !form) {
    return error ? (
      <p role="alert" className="field-error">
        <Icon name="alert" />
        {error}
      </p>
    ) : (
      <p className="muted">Loading…</p>
    );
  }

  const dirty = !same(form, formOf(profile));
  const edit = (key: keyof DetailsForm) => (value: string) => {
    setForm({ ...form, [key]: value });
    setSaved(false);
    setError(null);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateProfile({
        name: form!.name.trim(),
        jobTitle: form!.jobTitle.trim() || null,
        company: form!.company.trim() || null,
        linkedin: form!.linkedin.trim() || null,
      });
      setProfile(next);
      setForm(formOf(next));
      setSaved(true);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="profile-details">
      <form className="profile-form" onSubmit={save}>
        <Field label="Name" value={form.name} onChange={edit('name')} autoComplete="name" />
        <Field
          label="Email"
          value={profile.email ?? ''}
          readOnly
          hint="An admin changes your email address."
        />
        <Field
          label="Job title"
          value={form.jobTitle}
          onChange={edit('jobTitle')}
          autoComplete="organization-title"
        />
        <Field
          label="Company"
          value={form.company}
          onChange={edit('company')}
          autoComplete="organization"
        />
        <Field
          label="LinkedIn"
          value={form.linkedin}
          onChange={edit('linkedin')}
          hint="Your name in linkedin.com/in/<name>, or that address."
        />
        {error && (
          <p role="alert" className="field-error">
            <Icon name="alert" />
            {error}
          </p>
        )}
        <div className="profile-actions">
          <button type="submit" className="primary" disabled={busy || !dirty || !form.name.trim()}>
            Save
          </button>
          {saved && (
            <span role="status" className="muted">
              Saved.
            </span>
          )}
        </div>
      </form>
      <GitHubSection
        api={api}
        profile={profile}
        dirty={dirty}
        result={githubResult}
        onProfile={setProfile}
        onChanged={onChanged}
      />
    </div>
  );
}

function GitHubSection({
  api,
  profile,
  dirty,
  result,
  onProfile,
  onChanged,
}: {
  api: Api;
  profile: Profile;
  /** Unsaved details would be lost by the trip to GitHub. */
  dirty: boolean;
  result?: GitHubLinkResult;
  onProfile: (profile: Profile) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const github = profile.github;
  const outcome = result && LINK_RESULT[result];

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await api.unlinkGitHub();
      onProfile({ ...profile, github: null });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="profile-github">
      <legend>GitHub</legend>
      {outcome &&
        (outcome.ok ? (
          <p role="status" className="callout tone-ok">
            <Icon name="check" size={18} />
            {outcome.text}
          </p>
        ) : (
          <p role="alert" className="field-error">
            <Icon name="alert" />
            {outcome.text}
          </p>
        ))}
      {github ? (
        <>
          <div className="github-account">
            <Avatar name={github.login} url={github.avatarUrl} />
            <span>
              Linked as <strong>{github.login}</strong>
            </span>
            <button type="button" disabled={busy} onClick={() => void unlink()}>
              Unlink
            </button>
          </div>
          <RepoPicker api={api} profile={profile} onProfile={onProfile} />
        </>
      ) : profile.githubAvailable ? (
        <>
          <p className="muted">
            Link your GitHub account: its picture becomes yours in CT Studio, and recipe YAML will
            be stored in one of its repositories.
          </p>
          {dirty ? (
            <p className="muted">Save your details before linking GitHub.</p>
          ) : (
            <a className="button" href={api.gitHubConnectUrl()}>
              <Icon name="gitBranch" />
              Link GitHub account
            </a>
          )}
        </>
      ) : (
        <p className="muted">GitHub linking is not set up on this server.</p>
      )}
      {error && (
        <p role="alert" className="field-error">
          <Icon name="alert" />
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** The repository recipe YAML will be stored in (the feature that writes it is still to come). */
function RepoPicker({
  api,
  profile,
  onProfile,
}: {
  api: Api;
  profile: Profile;
  onProfile: (profile: Profile) => void;
}) {
  const id = useId();
  const chosen = profile.github?.repo ?? null;
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [pick, setPick] = useState(chosen ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.listGitHubRepos().then(
      (list) => live && setRepos(list),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [api]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onProfile(await api.setGitHubRepo(pick || null));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field github-repo">
      <label htmlFor={id}>YAML repository</label>
      <small className="muted">
        Recipe YAML will be stored in this repository (coming soon).
        {chosen && (
          <>
            {' '}
            Chosen: <span className="mono">{chosen}</span>
          </>
        )}
      </small>
      {repos && (
        <div className="profile-actions">
          <select
            id={id}
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
              setSaved(false);
            }}
          >
            <option value="">None chosen</option>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.private ? `${r.fullName} (private)` : r.fullName}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || pick === (chosen ?? '')}
            onClick={() => void save()}
          >
            Save repository
          </button>
          {saved && (
            <span role="status" className="muted">
              Repository saved.
            </span>
          )}
        </div>
      )}
      {!repos && !error && <small className="muted">Loading repositories…</small>}
      {error && (
        <p role="alert" className="field-error">
          <Icon name="alert" />
          {error}
        </p>
      )}
    </div>
  );
}
