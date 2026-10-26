import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { operatorMayOpen, type GitHubLinkResult, type MaintenanceNotice } from '@ih/shared';
import { maintenanceOf, type Api, type Me } from './api/client.js';
import { OntologiesPage } from './ontologies/OntologiesPage.js';
import { OntologyPage } from './ontologies/OntologyPage.js';
import { AdminDialog } from './access/AdminDialog.js';
import { ChangePassword } from './access/ChangePassword.js';
import { FailedSignInsNotice, type FailedSignIns } from './access/FailedSignInsNotice.js';
import { MaintenanceBanner } from './access/MaintenanceBanner.js';
import { ProfileDialog, type ProfileTab } from './access/ProfileDialog.js';
import { ConnectionsDialog } from './access/ConnectionsDialog.js';
import { AuthLayout, SignIn } from './access/SignIn.js';
import { HomePage } from './home/HomePage.js';
import { ConversionPage } from './conversion/ConversionPage.js';
import { JobsPage } from './jobs/JobsPage.js';
import { ResultDetailView } from './results/ResultDetail.js';
import { ResultsPage } from './results/ResultsPage.js';
import { ReviewPage } from './review/ReviewPage.js';
import { installPrompt as appInstallPrompt, type InstallPrompt } from './pwa/install.js';
import { launchedFiles, type LaunchedFiles } from './pwa/launch.js';
import { navigate, parseHash, useHashRoute } from './router.js';
import { AppShell } from './shell/AppShell.js';
import { useAppBadge } from './pwa/badge.js';
import { useJobNotifications, useNotifySetting } from './pwa/notify.js';
import { attentionCount, routeTitle, sectionOf } from './shell/derive.js';
import { useDocumentTitle } from './shell/useDocumentTitle.js';
import { useJobs } from './shell/useJobs.js';
import { TemplateEditor } from './templates/TemplateEditor.js';
import { TemplatesPage } from './templates/TemplatesPage.js';
import { ProjectPage } from './workbench/ProjectPage.js';
import { WorkbenchPage } from './workbench/WorkbenchPage.js';
import { Icon } from './ui/Icon.js';
import { AboutDialog } from './about/AboutDialog.js';
import { HelpCenter } from './help/HelpCenter.js';
import { helpTopicOf } from './help/index.js';
import type { HelpTopicId } from './help/topics.js';
import { HelpCenterContext } from './ui/Help.js';
import { BUILD_VERSION } from './version.js';

/**
 * Sign-in gate (ADR 0013): the app renders only for a valid session, and a session opened with a
 * one-time password gets the password change first. During maintenance (migration 0046) the
 * sign-in page shows the banner, and anyone but an admin gets the maintenance page instead of the
 * app until it is over.
 */
/** The jobs needing someone that the badges and review queue read (the API's maximum). */
const ATTENTION_LIMIT = 500;

export function App({
  api,
  pollMs = 3000,
  launched = launchedFiles,
  install = appInstallPrompt,
}: {
  api: Api;
  pollMs?: number;
  /** Files opened with the installed app (docs/design/pwa.md); they wait for sign-in. */
  launched?: LaunchedFiles;
  /** The browser's offer to install the app (the top bar's Install CT Studio). */
  install?: InstallPrompt;
}) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [ended, setEnded] = useState(false);
  /** Failed sign-ins the last sign-in cleared (D9): shown once, never stored. */
  const [failed, setFailed] = useState<FailedSignIns | null>(null);
  /** The session check failed for another reason (API restarting, proxy error): not "signed out". */
  const [unreachable, setUnreachable] = useState<string | null>(null);
  /** Maintenance mode as last read (the notice, a refusal or an admin's save). */
  const [maintenance, setMaintenance] = useState<MaintenanceNotice | null>(null);
  /** The API refused this session for maintenance: the maintenance page, not the app. */
  const [held, setHeld] = useState(false);

  const check = useCallback(() => {
    setUnreachable(null);
    api.me().then(
      (next) => {
        setHeld(false);
        setMe(next);
      },
      (err: Error) => {
        const notice = maintenanceOf((err as { body?: unknown }).body);
        if (notice) {
          setMaintenance(notice);
          setHeld(true);
        } else setUnreachable(err.message);
      },
    );
  }, [api]);

  useEffect(() => {
    check();
    const offUnauthorized = api.onUnauthorized(() => {
      setMe(null);
      setEnded(true);
    });
    const offMaintenance = api.onMaintenance((notice) => {
      setMaintenance(notice);
      setHeld(true);
    });
    return () => {
      offUnauthorized();
      offMaintenance();
    };
  }, [api, check]);

  // The sign-in page and an admin's strip show the notice: read it whenever who is in changes.
  const signedOut = me === null;
  useEffect(() => {
    api.getMaintenanceNotice().then(setMaintenance, () => {
      // Unreadable: no banner, as before maintenance mode existed.
    });
  }, [api, signedOut]);

  if (held && maintenance) {
    return (
      <AuthLayout title="Under maintenance">
        <MaintenanceBanner notice={maintenance}>
          You are still signed in: check again once it is over.
        </MaintenanceBanner>
        <div className="maintenance-actions">
          <button type="button" className="primary" onClick={check}>
            Check again
          </button>
          <button
            type="button"
            onClick={() =>
              void api.logout().finally(() => {
                setHeld(false);
                setMe(null);
              })
            }
          >
            Sign out
          </button>
        </div>
      </AuthLayout>
    );
  }

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
        maintenance={maintenance}
        onMaintenance={setMaintenance}
        onSignedIn={({ failedSinceLastSignIn, lastFailedAt, ...signedIn }) => {
          setEnded(false);
          setFailed(
            failedSinceLastSignIn > 0 ? { count: failedSinceLastSignIn, lastFailedAt } : null,
          );
          setMe(signedIn);
        }}
      />
    );
  }
  const signOut = () => {
    setFailed(null);
    void api.logout().finally(() => setMe(null));
  };
  const notice = failed && (
    <FailedSignInsNotice failed={failed} onDismiss={() => setFailed(null)} />
  );
  const strip = me.role === 'admin' && maintenance?.enabled && (
    <div
      role="status"
      aria-label="Maintenance mode is on"
      className="callout tone-warn maintenance-strip"
    >
      <Icon name="warning" size={18} />
      <span>
        <strong>Maintenance mode is on</strong>
        <span>
          Only admins can use CT Studio until it is switched off under Administration &gt;
          Maintenance.
        </span>
      </span>
    </div>
  );
  if (me.mustChangePassword) {
    return (
      <AuthLayout title="Choose your password">
        {notice}
        <ChangePassword api={api} me={me} mode="first" onDone={check} onSignOut={signOut} />
      </AuthLayout>
    );
  }
  return (
    <SignedInApp
      api={api}
      pollMs={pollMs}
      me={me}
      launched={launched}
      install={install}
      notice={
        <>
          {strip}
          {notice}
        </>
      }
      onMaintenanceChanged={({ enabled, message, since }) =>
        setMaintenance({ enabled, message, since })
      }
      onMeChanged={check}
      onSignOut={signOut}
    />
  );
}

function SignedInApp({
  api,
  pollMs,
  me,
  launched,
  install,
  notice,
  onMaintenanceChanged,
  onMeChanged,
  onSignOut,
}: {
  api: Api;
  pollMs: number;
  me: Me;
  launched: LaunchedFiles;
  install: InstallPrompt;
  /** Shown above every page until dismissed (the failed sign-ins notice). */
  notice: ReactNode;
  /** An admin saved maintenance mode (Administration > Maintenance). */
  onMaintenanceChanged: (view: MaintenanceNotice) => void;
  /** The name or picture may have changed (Profile): re-read who is signed in. */
  onMeChanged: () => void;
  onSignOut: () => void;
}) {
  const route = useHashRoute();
  /** The Profile dialog, over whatever page is open (docs/design/profile.md). */
  const [profile, setProfile] = useState<{
    tab: ProfileTab;
    github?: GitHubLinkResult;
  } | null>(null);
  /** Administration (admins): Models, Linked data and Access, over whatever page is open. */
  const [admin, setAdmin] = useState(false);
  /** Help (everyone): every help topic in one dialog, at this topic, over whatever page is open. */
  const [help, setHelp] = useState<HelpTopicId | null>(null);
  // A link to #/help[/<topic>]: open Help over Home (an unknown topic opens the introduction),
  // and leave the address as Profile does.
  useEffect(() => {
    if (route.name !== 'help') return;
    setHelp(helpTopicOf(route.topic) ?? 'introduction');
    window.history.replaceState(null, '', '#/');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [route]);
  /** About (everyone): the version and the release notes, at this note (else the latest). */
  const [about, setAbout] = useState<{ note?: string } | null>(null);
  // A link to #/about[/<date>]: open About over Home, and leave the address as Help does.
  useEffect(() => {
    if (route.name !== 'about') return;
    setAbout(route.note ? { note: route.note } : {});
    window.history.replaceState(null, '', '#/');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [route]);
  // Back from GitHub (or a link to #/account/profile): open the dialog over Home, and leave the
  // address so a reload or Back does not open it again.
  useEffect(() => {
    if (route.name !== 'profile') return;
    setProfile({ tab: route.tab, ...(route.github ? { github: route.github } : {}) });
    if (route.github) onMeChanged();
    window.history.replaceState(null, '', '#/');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [route, onMeChanged]);
  // Opened files are uploaded from Home: go there from any other page.
  useEffect(() => {
    const toHome = () => {
      if (launched.waiting && parseHash(window.location.hash).name !== 'home') navigate('#/');
    };
    toHome();
    return launched.subscribe(toHome);
  }, [launched]);
  /** Each visit to #/upload (a hashchange gives a new route) focuses the upload strip again. */
  const [uploadFocus, setUploadFocus] = useState(0);
  useEffect(() => {
    if (route.name === 'home' && route.focusUpload) setUploadFocus((n) => n + 1);
  }, [route]);
  useDocumentTitle(routeTitle(route));
  const { jobs, error, refresh, loaded } = useJobs(api, pollMs);
  // Every job needing someone, however old: the badges and the review queue count these, so a
  // job awaiting review is never missed behind the newest jobs listed.
  const { jobs: attentionJobs } = useJobs(api, pollMs, {
    group: 'attention',
    limit: ATTENTION_LIMIT,
  });
  // The installed app (docs/design/pwa.md): the taskbar badge and toasts for your own jobs.
  useAppBadge(attentionCount(attentionJobs));
  const notify = useNotifySetting();
  const creator = useMemo(() => ({ name: me.label, userId: me.userId }), [me.label, me.userId]);
  useJobNotifications({ jobs, loaded, me: creator, enabled: notify.state === 'on' });
  const [query, setQuery] = useState('');
  // The search filters the current section's list: moving to another section starts afresh,
  // so a leftover query never hides rows somewhere else.
  const section = sectionOf(route);
  const [querySection, setQuerySection] = useState(section);
  if (querySection !== section) {
    setQuerySection(section);
    setQuery('');
  }
  let page: ReactNode;
  if (me.role === 'operator' && !operatorMayOpen(route.name)) {
    // Document types, Ontologies and the Workbench are for designers (the API refuses them too).
    page = (
      <section className="card not-for-operators">
        <h1>Not available to operators</h1>
        <p>
          Operators upload documents, follow and review jobs, read results and convert documents.
        </p>
        <a href="#/">Go to Home</a>
      </section>
    );
  } else if (route.name === 'review') {
    // Keyed: Next document must start fresh (no reason, note or page carried over).
    page = (
      <ReviewPage
        key={route.jobId}
        api={api}
        jobId={route.jobId}
        jobs={attentionJobs}
        role={me.role}
        onDone={() => navigate('#/jobs')}
      />
    );
  } else if (route.name === 'results') {
    page = <ResultsPage api={api} query={query} />;
  } else if (route.name === 'result') {
    page = <ResultDetailView key={route.jobId} api={api} jobId={route.jobId} />;
  } else if (route.name === 'password') {
    page = (
      <div className="password-page">
        <ChangePassword
          api={api}
          me={me}
          mode="account"
          onDone={() => window.history.back()}
          onSignOut={onSignOut}
        />
      </div>
    );
  } else if (route.name === 'ontologies') {
    page = <OntologiesPage api={api} role={me.role} />;
  } else if (route.name === 'ontology') {
    page = (
      <OntologyPage
        key={`${route.ontologyId}/${route.version ?? ''}/${route.term ?? ''}`}
        api={api}
        role={me.role}
        ontologyId={route.ontologyId}
        {...(route.version !== undefined ? { version: route.version } : {})}
        {...(route.term !== undefined ? { term: route.term } : {})}
      />
    );
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
  } else if (route.name === 'conversion') {
    page = (
      <ConversionPage
        key={route.batchId ?? ''}
        api={api}
        {...(route.batchId ? { batchId: route.batchId } : {})}
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
        surveyView={route.tab === 'survey' ? route.view : undefined}
        onNavigate={navigate}
        pollMs={pollMs}
        role={me.role}
      />
    );
  } else if (route.name === 'jobs') {
    page = (
      <JobsPage
        api={api}
        {...(route.jobId ? { jobId: route.jobId } : {})}
        refresh={refresh}
        query={query}
        pollMs={pollMs}
      />
    );
  } else {
    page = (
      <HomePage
        api={api}
        me={creator}
        jobs={jobs}
        error={error}
        refresh={refresh}
        pollMs={pollMs}
        launched={launched}
        focusUpload={uploadFocus}
      />
    );
  }
  return (
    <AppShell
      me={me}
      route={route}
      jobs={attentionJobs}
      query={query}
      onQuery={setQuery}
      install={install}
      notify={notify}
      onAdmin={() => setAdmin(true)}
      onProfile={() => setProfile({ tab: 'details' })}
      // A failure to open the page (the bridge down) has nowhere to show from a menu: logged.
      onConnections={() => void api.openConnections().catch((err: unknown) => console.warn(err))}
      onHelp={() => setHelp('introduction')}
      onAbout={() => setAbout({})}
      onSignOut={onSignOut}
    >
      {notice}
      <HelpCenterContext.Provider value={setHelp}>{page}</HelpCenterContext.Provider>
      {help && <HelpCenter key={help} topic={help} onClose={() => setHelp(null)} />}
      {about && (
        <AboutDialog
          {...(about.note ? { note: about.note } : {})}
          version={BUILD_VERSION}
          onClose={() => setAbout(null)}
        />
      )}
      {profile && (
        <ProfileDialog
          api={api}
          me={me}
          initialTab={profile.tab}
          githubResult={profile.github}
          onChanged={onMeChanged}
          onClose={() => setProfile(null)}
          onSignOut={onSignOut}
        />
      )}
      {admin && (
        <AdminDialog
          api={api}
          me={me}
          onClose={() => setAdmin(false)}
          onMaintenanceChanged={onMaintenanceChanged}
          onSignOut={onSignOut}
        />
      )}
      <ConnectionsDialog api={api} />
    </AppShell>
  );
}
