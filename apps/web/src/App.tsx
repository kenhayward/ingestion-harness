import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api, Me } from './api/client.js';
import { AccessPage } from './access/AccessPage.js';
import { AuthLayout, SignIn } from './access/SignIn.js';
import { JobCleanup } from './components/JobCleanup.js';
import { JobsTable } from './components/JobsTable.js';
import { UploadStrip } from './jobs/UploadStrip.js';
import { ResultDetailView } from './results/ResultDetail.js';
import { ResultsPage } from './results/ResultsPage.js';
import { ReviewPage } from './review/ReviewPage.js';
import { navigate, useHashRoute } from './router.js';
import { AppShell } from './shell/AppShell.js';
import { matchesQuery, sectionOf } from './shell/derive.js';
import { useJobs } from './shell/useJobs.js';
import { TemplateEditor } from './templates/TemplateEditor.js';
import { TemplatesPage } from './templates/TemplatesPage.js';

/** Sign-in gate (ADR 0006): the app renders only for a valid session. */
export function App({ api, pollMs = 3000 }: { api: Api; pollMs?: number }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [ended, setEnded] = useState(false);
  /** The session check failed for another reason (API restarting, proxy error): not "signed out". */
  const [unreachable, setUnreachable] = useState<string | null>(null);

  const check = useCallback(() => {
    setUnreachable(null);
    api.me().then(setMe, (err: Error) => setUnreachable(err.message));
  }, [api]);

  useEffect(() => {
    check();
    return api.onUnauthorized(() => {
      setMe(null);
      setEnded(true);
    });
  }, [api, check]);

  if (unreachable !== null) {
    return (
      <AuthLayout>
        <div className="card auth-card">
          <p role="alert" className="field-error">
            Can't reach the server ({unreachable}).
          </p>
          <button type="button" className="primary block" onClick={check}>
            Retry
          </button>
        </div>
      </AuthLayout>
    );
  }
  if (me === undefined) {
    return (
      <AuthLayout>
        <p className="auth-hint">Loading…</p>
      </AuthLayout>
    );
  }
  if (me === null) {
    return (
      <SignIn
        api={api}
        ended={ended}
        onSignedIn={(signedIn) => {
          setEnded(false);
          setMe(signedIn);
        }}
      />
    );
  }
  return (
    <SignedInApp
      api={api}
      pollMs={pollMs}
      me={me}
      onSignOut={() => {
        void api.logout().finally(() => setMe(null));
      }}
    />
  );
}

function SignedInApp({
  api,
  pollMs,
  me,
  onSignOut,
}: {
  api: Api;
  pollMs: number;
  me: Me;
  onSignOut: () => void;
}) {
  const route = useHashRoute();
  const { jobs, error, refresh } = useJobs(api, pollMs);
  const [query, setQuery] = useState('');
  // The search filters the current section's list: moving to another section starts afresh,
  // so a leftover query never hides rows somewhere else.
  const section = sectionOf(route);
  const [querySection, setQuerySection] = useState(section);
  if (querySection !== section) {
    setQuerySection(section);
    setQuery('');
  }
  /** Upload PDF was pressed: the Jobs page opens the file picker once, then clears this. */
  const [pickPending, setPickPending] = useState(false);
  let page: ReactNode;
  if (route.name === 'review') {
    page = <ReviewPage api={api} jobId={route.jobId} onDone={() => navigate('#/')} />;
  } else if (route.name === 'results') {
    page = <ResultsPage api={api} query={query} />;
  } else if (route.name === 'result') {
    page = <ResultDetailView key={route.jobId} api={api} jobId={route.jobId} />;
  } else if (route.name === 'access') {
    page = <AccessPage api={api} me={me} query={query} />;
  } else if (route.name === 'templates') {
    page = <TemplatesPage api={api} onNavigate={navigate} query={query} />;
  } else if (route.name === 'template') {
    page = (
      <TemplateEditor
        key={`${route.templateId}@${route.version}`}
        api={api}
        templateId={route.templateId}
        version={route.version}
        onNavigate={navigate}
      />
    );
  } else {
    page = (
      <JobsView
        api={api}
        jobs={jobs}
        error={error}
        refresh={refresh}
        query={query}
        pickPending={pickPending}
        onPicked={() => setPickPending(false)}
      />
    );
  }
  return (
    <AppShell
      me={me}
      route={route}
      jobs={jobs}
      query={query}
      onQuery={setQuery}
      onUpload={() => {
        navigate('#/');
        setPickPending(true);
      }}
      onSignOut={onSignOut}
    >
      {page}
    </AppShell>
  );
}

function JobsView({
  api,
  jobs,
  error,
  refresh,
  query,
  pickPending,
  onPicked,
}: {
  api: Api;
  jobs: JobSummary[];
  error: string | null;
  refresh: () => Promise<void>;
  query: string;
  pickPending: boolean;
  onPicked: () => void;
}) {
  /** The upload form's Model selection; Retry uses it too. */
  const [retryModel, setRetryModel] = useState('');
  const shown = jobs.filter((j) =>
    matchesQuery(query, j.filename, j.specId, j.modelOverride, j.status, ...j.modelsUsed),
  );

  return (
    <>
      <UploadStrip
        api={api}
        onUploaded={refresh}
        onModelChange={setRetryModel}
        pickPending={pickPending}
        onPicked={onPicked}
      />
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      {jobs.length > 0 && shown.length === 0 ? (
        <p>No jobs match “{query.trim()}”.</p>
      ) : (
        <JobsTable api={api} jobs={shown} onChanged={refresh} retryModel={retryModel} />
      )}
      <JobCleanup api={api} onChanged={refresh} />
    </>
  );
}
