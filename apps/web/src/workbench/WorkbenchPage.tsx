import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ID_PATTERN,
  type DataPolicy,
  type OverviewPhase,
  type ProjectListItem,
  type ProjectListPage,
  type ProjectListQuery,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { FilterChips } from '../ui/FilterChips.js';
import { Icon } from '../ui/Icon.js';
import { ImportBundle } from './ImportBundle.js';
import {
  formatCount,
  loadPageSize,
  pagerPages,
  recentProjects,
  savePageSize,
} from './listDerive.js';
import { ProjectCard, ProjectTable } from './ProjectTable.js';

type Filter = ProjectListQuery['filter'];
type Sort = ProjectListQuery['sort'];
type Size = 25 | 50 | 100;

/** What the list asks the server for; '' means "any". */
type ListState = {
  q: string;
  filter: Filter;
  phase: OverviewPhase | '';
  policy: DataPolicy | '';
  sort: Sort;
  page: number;
  size: Size;
};

const SEARCH_DEBOUNCE_MS = 250;
/** The "Pinned and recent" strip shows at most this many cards. */
const MAX_CARDS = 3;
/**
 * Card ids asked for (the API's limit): more than MAX_CARDS, so a pinned or recent project
 * that was deleted or is unknown does not take a card slot from one that exists.
 */
const MAX_CARD_IDS = 20;

const PHASES: readonly [OverviewPhase | '', string][] = [
  ['', 'Any'],
  ['prepare', 'Prepare'],
  ['draft', 'Draft with the model'],
  ['verify', 'Verify and publish'],
  ['published', 'Published, no draft'],
];
const POLICIES: readonly [DataPolicy | '', string][] = [
  ['', 'Any'],
  ['local', 'Local only'],
  ['external', 'External allowed'],
];
const SORTS: readonly [Sort, string][] = [
  ['activity', 'Last activity'],
  ['name', 'Name A–Z'],
  ['score', 'Holdout score, lowest first'],
  ['samples', 'Fewest samples'],
];
const SIZES: readonly Size[] = [25, 50, 100];

/** Progress strip segment colours, as the footer legend explains them. */
const LEGEND: readonly [string, string][] = [
  ['accepted', 'Done'],
  ['proposed', 'Needs you'],
  ['running', 'Running'],
  ['stale', 'Stale'],
  ['skipped', 'Skipped'],
  ['ready', 'Ready'],
  ['locked', 'Locked'],
  ['pending', 'Not started'],
];

const NO_MATCH = 'No document types match. Clear the search or pick another filter.';

function request(s: ListState): Parameters<Api['listProjectPage']>[0] {
  return {
    ...(s.q ? { q: s.q } : {}),
    filter: s.filter,
    ...(s.phase ? { phase: s.phase } : {}),
    ...(s.policy ? { policy: s.policy } : {}),
    sort: s.sort,
    page: s.page,
    size: s.size,
  };
}

/** The Workbench: every project (one per document type), paged on the server. */
export function WorkbenchPage({
  api,
  onNavigate,
  query = '',
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  /** The top bar's search: seeds and follows the page's search box. */
  query?: string;
}) {
  const [state, setState] = useState<ListState>(() => ({
    q: query.trim(),
    filter: 'all',
    phase: '',
    policy: '',
    sort: 'activity',
    page: 1,
    size: loadPageSize(),
  }));
  /** Any change but paging starts again at page 1 (the old page may no longer exist). */
  const change = (patch: Partial<Omit<ListState, 'page'>>) =>
    setState((s) => ({ ...s, ...patch, page: 1 }));

  const [text, setText] = useState(query);
  useEffect(() => setText(query), [query]);
  useEffect(() => {
    const q = text.trim();
    if (q === state.q) return;
    const timer = setTimeout(() => setState((s) => ({ ...s, q, page: 1 })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, state.q]);

  const [list, setList] = useState<ProjectListPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Numbers each list request, so an older response never replaces a newer one. */
  const listRequest = useRef(0);
  useEffect(() => {
    const seq = ++listRequest.current;
    api.listProjectPage(request(state)).then(
      (p) => {
        if (seq !== listRequest.current) return;
        setList(p);
        setError(null);
      },
      (err: Error) => {
        if (seq === listRequest.current) setError(err.message);
      },
    );
  }, [api, state]);

  // Pins: loaded once, then toggled optimistically.
  const [pins, setPins] = useState<string[] | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  useEffect(() => {
    api.listPins().then(setPins, () => setPins([]));
  }, [api]);
  const pinned = useMemo(() => new Set(pins ?? []), [pins]);
  const [recents] = useState(recentProjects);
  const cardIds = useMemo(
    () => (pins === null ? [] : [...new Set([...pins, ...recents])].slice(0, MAX_CARD_IDS)),
    [pins, recents],
  );
  const cardKey = cardIds.join(',');

  const [cards, setCards] = useState<ProjectListItem[]>([]);
  const cardsRequest = useRef(0);
  useEffect(() => {
    const seq = ++cardsRequest.current;
    const ids = cardKey ? cardKey.split(',') : [];
    if (ids.length === 0) {
      setCards([]);
      return;
    }
    api.listProjectPage({ ids }).then(
      (p) => {
        if (seq !== cardsRequest.current) return;
        // Pinned first, then most recently opened: the order of `ids`, not the server's.
        setCards(
          [...p.items]
            .filter((i) => ids.includes(i.id))
            .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
            .slice(0, MAX_CARDS),
        );
      },
      () => {
        // The cards are a shortcut; the list below still shows every project.
        if (seq === cardsRequest.current) setCards([]);
      },
    );
  }, [api, cardKey]);

  const togglePin = async (id: string) => {
    const was = pinned.has(id);
    const flip = (on: boolean) =>
      setPins((ps) => {
        const rest = (ps ?? []).filter((p) => p !== id);
        return on ? [id, ...rest] : rest;
      });
    flip(!was);
    setPinError(null);
    try {
      await (was ? api.unpin(id) : api.pin(id));
    } catch (err) {
      flip(was);
      setPinError(`Could not ${was ? 'unpin' : 'pin'} ${id}: ${(err as Error).message}`);
    }
  };

  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  const now = Date.now();

  const facets = list?.facets;
  const count = (f: Filter) => (facets ? formatCount(facets[f]) : undefined);
  const total = list?.total ?? 0;
  const items = list?.items ?? [];
  const from = (state.page - 1) * state.size + 1;
  const range =
    items.length === 0
      ? `Showing 0 of ${formatCount(total)}`
      : `Showing ${formatCount(from)}–${formatCount(from + items.length - 1)} of ${formatCount(total)}`;
  const lastPage = Math.max(1, Math.ceil(total / state.size));
  const goTo = (page: number) => setState((s) => ({ ...s, page }));

  return (
    <section className="workbench workbench-list">
      <div className="page-header">
        <div>
          <h1>Workbench</h1>
          <p className="muted">
            Build a document type from sample documents: prepare their text, describe what you need,
            and test the draft on the samples.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" onClick={() => setDialog('import')}>
            Import bundle
          </button>
          <button type="button" className="primary" onClick={() => setDialog('new')}>
            New project
          </button>
        </div>
      </div>

      {pinError && <p role="alert">{pinError}</p>}

      {cards.length > 0 && (
        <section aria-label="Pinned and recent" className="pinned-recent">
          <h2 className="eyebrow">Pinned and recent</h2>
          <div className="pinned-cards">
            {cards.map((item) => (
              <ProjectCard
                key={item.id}
                item={item}
                pinned={pinned.has(item.id)}
                onTogglePin={() => void togglePin(item.id)}
                now={now}
              />
            ))}
          </div>
        </section>
      )}

      <FilterChips<Filter>
        label="Filter projects"
        value={state.filter}
        onChange={(filter) => change({ filter })}
        chips={[
          { value: 'all', label: 'All', count: count('all') },
          { value: 'attention', label: 'Needs you', count: count('attention'), tone: 'warn' },
          { value: 'running', label: 'Running', count: count('running') },
          { value: 'ready', label: 'Ready to publish', count: count('ready') },
          { value: 'progress', label: 'In progress', count: count('progress') },
          { value: 'published', label: 'Published, no draft', count: count('published') },
        ]}
      />

      <div className="list-toolbar">
        <input
          type="search"
          className="filter-field list-search"
          aria-label="Search projects by name or id"
          placeholder="Search name or id"
          maxLength={100}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <label className="inline list-select">
          Phase
          <select
            value={state.phase}
            onChange={(e) => change({ phase: e.target.value as ListState['phase'] })}
          >
            {PHASES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline list-select">
          Models
          <select
            value={state.policy}
            onChange={(e) => change({ policy: e.target.value as ListState['policy'] })}
          >
            {POLICIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline list-select">
          Sort
          <select value={state.sort} onChange={(e) => change({ sort: e.target.value as Sort })}>
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="muted list-range">{list ? range : ''}</span>
      </div>

      {error && <p role="alert">Failed to load projects: {error}</p>}
      {list === null ? (
        !error && <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>{NO_MATCH}</p>
      ) : (
        <ProjectTable
          items={items}
          pinned={pinned}
          onTogglePin={(id) => void togglePin(id)}
          now={now}
        />
      )}

      <div className="list-footer projects-footer">
        <label className="inline list-select">
          Rows per page
          <select
            value={state.size}
            onChange={(e) => {
              const size = Number(e.target.value) as Size;
              savePageSize(size);
              change({ size });
            }}
          >
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <ul className="list-legend">
          {LEGEND.map(([seg, label]) => (
            <li key={seg}>
              <span className="progress-strip" aria-hidden="true">
                <span className={`seg seg-${seg}`} />
              </span>
              {label}
            </li>
          ))}
          <li>
            <span className="legend-tick" aria-hidden="true" />
            Score tick = publish threshold
          </li>
        </ul>
        <nav aria-label="Pages" className="pager">
          <button
            type="button"
            aria-label="Previous page"
            disabled={state.page <= 1}
            onClick={() => goTo(state.page - 1)}
          >
            ‹
          </button>
          {pagerPages(Math.min(state.page, lastPage), lastPage).map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="pager-gap">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                aria-current={p === state.page ? 'page' : undefined}
                onClick={() => goTo(p)}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            aria-label="Next page"
            disabled={state.page >= lastPage}
            onClick={() => goTo(state.page + 1)}
          >
            ›
          </button>
        </nav>
      </div>

      {dialog === 'new' && (
        <NewProjectDialog api={api} onNavigate={onNavigate} onClose={() => setDialog(null)} />
      )}
      {dialog === 'import' && (
        <Dialog title="Import bundle" onClose={() => setDialog(null)}>
          <ImportBundle api={api} onImported={(p) => onNavigate(`#/workbench/${p.project.id}`)} />
        </Dialog>
      )}
    </section>
  );
}

/** What the API accepts as a project (document type) id, said in words. */
const ID_RULE = 'Use lowercase letters, digits, hyphens and underscores, starting with a letter.';

/**
 * New project (Workbench dialog handoff): a required Id, checked as typed against the API's rule
 * so a refused id is explained before anything is sent, and an optional Name (empty opens an
 * existing document type).
 */
function NewProjectDialog({
  api,
  onNavigate,
  onClose,
}: {
  api: Api;
  onNavigate: (hash: string) => void;
  onClose: () => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idField = useId();
  const idProblem = useId();
  const nameField = useId();
  const nameHint = useId();

  const wanted = id.trim();
  const invalid = wanted !== '' && !ID_PATTERN.test(wanted);
  const blocked = !wanted ? 'Enter an id first' : invalid ? 'Fix the id first' : undefined;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(wanted, name.trim() || undefined);
      onNavigate(`#/workbench/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New project"
      icon={<Icon name="workbench" size={36} strokeWidth={1.6} />}
      description="A Workbench project drafts a document type with the model, step by step."
      onClose={onClose}
      actions={
        <button
          type="submit"
          form="new-project"
          className="primary"
          disabled={blocked !== undefined || busy}
          title={blocked}
        >
          <Icon name="plus" />
          Create project
        </button>
      }
    >
      <form
        id="new-project"
        onSubmit={(e) => void create(e)}
        className="new-project-form"
        noValidate
      >
        <div className="np-field">
          <div className="np-label-row">
            <label htmlFor={idField}>Id</label>
            <span className="np-tag" aria-hidden="true">
              Required
            </span>
          </div>
          <input
            id={idField}
            className="np-input mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. supplier-invoice"
            autoComplete="off"
            spellCheck={false}
            required
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? idProblem : undefined}
          />
          {invalid && (
            <p id={idProblem} className="np-problem">
              {ID_RULE}
            </p>
          )}
        </div>
        <div className="np-field">
          <div className="np-label-row">
            <label htmlFor={nameField}>Name</label>
            <span className="np-tag" aria-hidden="true">
              Optional
            </span>
          </div>
          <input
            id={nameField}
            className="np-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Supplier invoice"
            aria-describedby={nameHint}
          />
          <p id={nameHint} className="np-hint">
            <Icon name="info" size={14} />
            Leave the name empty to open an existing document type.
          </p>
        </div>
        {error && (
          <p role="alert" className="np-problem">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
