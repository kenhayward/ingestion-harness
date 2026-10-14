import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Api, Me } from './api/client.js';
import { ModelsPage } from './models/ModelsPage.js';
import { AccessPage } from './access/AccessPage.js';
import { AuthLayout, SignIn } from './access/SignIn.js';
import { HomePage } from './home/HomePage.js';
import { JobsPage } from './jobs/JobsPage.js';
import { ResultDetailView } from './results/ResultDetail.js';
import { ResultsPage } from './results/ResultsPage.js';
import { ReviewPage } from './review/ReviewPage.js';
import { navigate, useHashRoute } from './router.js';
import { AppShell } from './shell/AppShell.js';
import { routeTitle, sectionOf } from './shell/derive.js';
import { useDocumentTitle } from './shell/useDocumentTitle.js';
import { useJobs } from './shell/useJobs.js';
import { TemplateEditor } from './templates/TemplateEditor.js';
import { TemplatesPage } from './templates/TemplatesPage.js';
import { ProjectPage } from './workbench/ProjectPage.js';
import { WorkbenchPage } from './workbench/WorkbenchPage.js';

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
  useDocumentTitle(routeTitle(route));
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
  /** Upload document was pressed: Home opens the file picker once, then clears this. */
  const [pickPending, setPickPending] = useState(false);
  let page: ReactNode;
  if (route.name === 'review') {
    // Keyed: Next document must start fresh (no reason, note or page carried over).
    page = (
      <ReviewPage
        key={route.jobId}
        api={api}
        jobId={route.jobId}
        jobs={jobs}
        onDone={() => navigate('#/jobs')}
      />
    );
  } else if (route.name === 'results') {
    page = <ResultsPage api={api} query={query} />;
  } else if (route.name === 'result') {
    page = <ResultDetailView key={route.jobId} api={api} jobId={route.jobId} />;
  } else if (route.name === 'access') {
    page = <AccessPage api={api} me={me} query={query} />;
  } else if (route.name === 'models') {
    page = <ModelsPage api={api} me={me} />;
  } else if (route.name === 'templates') {
    page = <TemplatesPage api={api} onNavigate={navigate} query={query} role={me.role} />;
  } else if (route.name === 'template') {
    page = (
      <TemplateEditor
        key={`${route.templateId}@${route.version}`}
        api={api}
        templateId={route.templateId}
        version={route.version}
        onNavigate={navigate}
        jobs={jobs}
      />
    );
  } else if (route.name === 'workbench') {
    page = <WorkbenchPage api={api} onNavigate={navigate} query={query} />;
  } else if (route.name === 'project') {
    page = (
      <ProjectPage
        key={route.projectId}
        api={api}
        projectId={route.projectId}
        tab={route.tab}
        onNavigate={navigate}
        pollMs={pollMs}
        role={me.role}
      />
    );
  } else if (route.name === 'jobs') {
    page = (
      <JobsPage
        api={api}
        jobs={jobs}
        error={error}
        refresh={refresh}
        query={query}
        pollMs={pollMs}
      />
    );
  } else {
    page = (
      <HomePage
        api={api}
        me={me.label}
        jobs={jobs}
        error={error}
        refresh={refresh}
        pollMs={pollMs}
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
