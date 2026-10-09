import { useCallback, useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from './api/client.js';
import { JobsTable } from './components/JobsTable.js';
import { UploadForm } from './components/UploadForm.js';

export function App({ api, pollMs = 3000 }: { api: Api; pollMs?: number }) {
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
