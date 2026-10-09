import { useCallback, useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from './api/client.js';
import { JobsTable } from './components/JobsTable.js';
import { UploadForm } from './components/UploadForm.js';
import { ReviewPage } from './review/ReviewPage.js';
import { navigate, useHashRoute } from './router.js';

export function App({ api, pollMs = 3000 }: { api: Api; pollMs?: number }) {
  const route = useHashRoute();
  if (route.name === 'review') {
    return (
      <main className="wide">
        <ReviewPage api={api} jobId={route.jobId} onDone={() => navigate('#/')} />
      </main>
    );
  }
  return <JobsView api={api} pollMs={pollMs} />;
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
    <main>
      <h1>Ingestion Harness</h1>
      <UploadForm api={api} onUploaded={refresh} />
      {error && <p role="alert">Failed to load jobs: {error}</p>}
      <JobsTable api={api} jobs={jobs} onChanged={refresh} />
    </main>
  );
}
