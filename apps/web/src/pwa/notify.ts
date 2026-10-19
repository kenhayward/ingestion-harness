import { useCallback, useEffect, useRef, useState } from 'react';
import { isMine, type Creator, type JobStatus, type JobSummary } from '@ih/shared';
import { navigate } from '../router.js';

/**
 * Toasts for your own jobs (docs/design/pwa.md): when one you queued finishes while the app is
 * in the background, Windows shows a notification (as "CT Studio" for the installed app).
 */
export type JobNotice = { tag: string; title: string; body: string; href: string };

type Outcome = 'review' | 'attention' | 'done';
const OUTCOME: Partial<Record<JobStatus, Outcome>> = {
  awaiting_review: 'review',
  needs_review: 'attention',
  failed: 'attention',
  succeeded: 'done',
};
const ACTIVE: readonly JobStatus[] = ['queued', 'running', 'delivering'];

function notice(job: JobSummary, outcome: Outcome): JobNotice {
  const tag = `ct-job-${job.id}`;
  if (outcome === 'review') {
    return { tag, title: 'Ready for review', body: job.filename, href: `#/review/${job.id}` };
  }
  if (outcome === 'attention') {
    const body = job.error ? `${job.filename}: ${job.error}` : job.filename;
    return { tag, title: 'Needs attention', body, href: '#/jobs' };
  }
  // Test runs are never delivered, so they have no published result to open.
  return {
    tag,
    title: 'Done',
    body: job.filename,
    href: job.test ? '#/jobs' : `#/results/${job.id}`,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What to announce between two job lists: `me`'s jobs that were queued or running (or not
 * listed yet: started and finished between polls) and now await review, need attention or are
 * done. Several at once become one summary, so a batch of test runs is one toast.
 */
export function jobNotices(
  previous: readonly JobSummary[],
  next: readonly JobSummary[],
  me: Creator,
): JobNotice[] {
  const before = new Map(previous.map((j) => [j.id, j.status]));
  const finished: [JobSummary, Outcome][] = [];
  for (const job of next) {
    if (!isMine(job, me)) continue;
    const outcome = OUTCOME[job.status];
    const was = before.get(job.id);
    if (outcome && (was === undefined || ACTIVE.includes(was))) finished.push([job, outcome]);
  }
  if (finished.length <= 1) return finished.map(([job, outcome]) => notice(job, outcome));
  const count = (o: Outcome) => finished.filter(([, outcome]) => outcome === o).length;
  const parts = [
    count('review') && plural(count('review'), 'ready for review', 'ready for review'),
    count('attention') && plural(count('attention'), 'needs attention', 'need attention'),
    count('done') && plural(count('done'), 'done', 'done'),
  ].filter(Boolean);
  return [
    {
      tag: 'ct-jobs-summary',
      title: `${finished.length} of your jobs finished`,
      body: parts.join(' · '),
      href: '#/jobs',
    },
  ];
}

/** The browser's notifications, or null where there are none. */
const notifications = (): typeof Notification | null =>
  typeof Notification === 'function' ? Notification : null;

function show(n: JobNotice) {
  const N = notifications();
  if (!N) return;
  const toast = new N(n.title, { body: n.body, tag: n.tag, icon: '/icon-192.png' });
  toast.onclick = () => {
    window.focus();
    navigate(n.href);
    toast.close();
  };
}

/** Someone is looking at the app: Home and the Jobs page already show what changed. */
const watching = () => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Shows `jobNotices` for each new jobs list while `enabled` and the app is in the background.
 * The first loaded list is only a baseline, and lists seen while off or watched are absorbed, so
 * turning it on never announces old news.
 */
export function useJobNotifications({
  jobs,
  loaded,
  me,
  enabled,
}: {
  jobs: readonly JobSummary[];
  /** The list has loaded at least once (before that it is empty, not "no jobs"). */
  loaded: boolean;
  /** The signed-in user; keep it stable across renders (useMemo). */
  me: Creator;
  enabled: boolean;
}): void {
  const previous = useRef<readonly JobSummary[] | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const before = previous.current;
    previous.current = jobs;
    if (!before || !enabled || watching()) return;
    for (const n of jobNotices(before, jobs, me)) show(n);
  }, [jobs, loaded, me, enabled]);
}

/** The bell: notifications on, off, refused in the browser, or not supported at all. */
export type NotifyState = 'on' | 'off' | 'blocked' | 'unsupported';
export type NotifySetting = { state: NotifyState; toggle: () => Promise<void> };

/** Turned on per browser ('1'); the browser's permission must still stand for it to count. */
const NOTIFY_KEY = 'ih.notify';
function loadOn(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false; // storage blocked: off until turned on for this visit
  }
}
function saveOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(NOTIFY_KEY, '1');
    else localStorage.removeItem(NOTIFY_KEY);
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
}

function currentState(on: boolean): NotifyState {
  const N = notifications();
  if (!N) return 'unsupported';
  if (N.permission === 'denied') return 'blocked';
  return on && N.permission === 'granted' ? 'on' : 'off';
}

/**
 * The person's choice. Turning it on asks the browser's permission first (browsers only ask
 * after a click). The permission is re-read when the window regains focus, since it can be
 * changed in the browser's site settings meanwhile.
 */
export function useNotifySetting(): NotifySetting {
  const [on, setOn] = useState(loadOn);
  const [state, setState] = useState(() => currentState(on));
  useEffect(() => {
    const reread = () => setState(currentState(on));
    reread();
    window.addEventListener('focus', reread);
    return () => window.removeEventListener('focus', reread);
  }, [on]);
  const toggle = useCallback(async () => {
    const N = notifications();
    if (!N) return;
    if (on && N.permission === 'granted') {
      saveOn(false);
      setOn(false);
      return;
    }
    const permission = N.permission === 'granted' ? 'granted' : await N.requestPermission();
    saveOn(permission === 'granted');
    setOn(permission === 'granted');
    setState(currentState(permission === 'granted'));
  }, [on]);
  return { state, toggle };
}
