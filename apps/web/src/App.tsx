import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from './api/client.js';
import { JobsTable } from './components/JobsTable.js';
import { UploadForm } from './components/UploadForm.js';
import { ResultDetailView } from './results/ResultDetail.js';
import { ResultsPage } from './results/ResultsPage.js';
import { ReviewPage } from './review/ReviewPage.js';
import { navigate, useHashRoute } from './router.js';
import { TemplateEditor } from './templates/TemplateEditor.js';
import { TemplatesPage } from './templates/TemplatesPage.js';

export function App({ api, pollMs = 3000 }: { api: Api; pollMs?: number }) {
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
      </nav>
      {page}
    </main>
  );
}

function JobsView({ api, pollMs }: { api: Api; pollMs: number }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

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
      <UploadForm api={api} onUploaded={refresh} />
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      <JobsTable api={api} jobs={jobs} onChanged={refresh} />
    </>
  );
}
