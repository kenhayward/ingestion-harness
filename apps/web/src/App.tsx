import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api, Me } from './api/client.js';
import { SignIn } from './access/SignIn.js';
import { JobCleanup } from './components/JobCleanup.js';
import { JobsTable } from './components/JobsTable.js';
import { UploadForm } from './components/UploadForm.js';
import { ResultDetailView } from './results/ResultDetail.js';
import { ResultsPage } from './results/ResultsPage.js';
import { ReviewPage } from './review/ReviewPage.js';
import { navigate, useHashRoute } from './router.js';
import { TemplateEditor } from './templates/TemplateEditor.js';
import { TemplatesPage } from './templates/TemplatesPage.js';

/** Sign-in gate (ADR 0006): the app renders only for a valid session. */
export function App({ api, pollMs = 3000 }: { api: Api; pollMs?: number }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    api.me().then(setMe, () => setMe(null));
    return api.onUnauthorized(() => {
      setMe(null);
      setEnded(true);
    });
  }, [api]);

  if (me === undefined) return <p>Loading…</p>;
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
  let page: ReactNode;
  if (route.name === 'review') {
    page = <ReviewPage api={api} jobId={route.jobId} onDone={() => navigate('#/')} />;
  } else if (route.name === 'results') {
    page = <ResultsPage api={api} />;
  } else if (route.name === 'result') {
    page = <ResultDetailView key={route.jobId} api={api} jobId={route.jobId} />;
  } else if (route.name === 'templates') {
    page = <TemplatesPage api={api} onNavigate={navigate} />;
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
    page = <JobsView api={api} pollMs={pollMs} />;
  }
  return (
    <main className={route.name === 'jobs' ? undefined : 'wide'}>
      <nav className="top-nav" aria-label="Main">
        <strong>Ingestion Harness</strong>
        <a
          href="#/"
          aria-current={route.name === 'jobs' || route.name === 'review' ? 'page' : undefined}
        >
          Jobs
        </a>
        <a
          href="#/results"
          aria-current={route.name === 'results' || route.name === 'result' ? 'page' : undefined}
        >
          Results
        </a>
        <a
          href="#/templates"
          aria-current={
            route.name === 'templates' || route.name === 'template' ? 'page' : undefined
          }
        >
          Document types
        </a>
        {me.role === 'admin' && <a href="#/access">Access</a>}
        <span className="identity">
          {me.label} · {me.role}
        </span>
        <button type="button" className="link" onClick={onSignOut}>
          Sign out
        </button>
      </nav>
      {page}
    </main>
  );
}

function JobsView({ api, pollMs }: { api: Api; pollMs: number }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The upload form's Model selection; Retry uses it too. */
  const [retryModel, setRetryModel] = useState('');

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.listJobs());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return (
    <>
      <UploadForm api={api} onUploaded={refresh} onModelChange={setRetryModel} />
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      <JobsTable api={api} jobs={jobs} onChanged={refresh} retryModel={retryModel} />
      <JobCleanup api={api} onChanged={refresh} />
    </>
  );
}
