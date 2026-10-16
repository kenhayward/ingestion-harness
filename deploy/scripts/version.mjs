#!/usr/bin/env node
// Calendar versions (ADR 0014): every merge to main is tagged YYYY.MM.DD.N by CI, and the deploy
// scripts bake the build's version into the images. Node builtins only, so a deploy host needs
// Node but no `npm ci`. Tests: apps/api/test/deploy-version.test.ts.
//
//   node deploy/scripts/version.mjs tag                 CI: tag HEAD with the next calendar tag
//   node deploy/scripts/version.mjs resolve [--untagged] deploy: print APP_VERSION, APP_VERSION_PREVIOUS,
//                                                      APP_COMMIT and IMAGE_TAG lines
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CALENDAR_TAG = /^(\d{4})\.(\d{2})\.(\d{2})\.([1-9]\d*)$/;
const DESCRIBE_MATCH = '[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].*';

export function isCalendarTag(tag) {
  return CALENDAR_TAG.test(tag);
}

/** Orders calendar tags by date, then build number (numerically). */
export function compareCalendarTags(a, b) {
  const [, ay, am, ad, an] = CALENDAR_TAG.exec(a);
  const [, by, bm, bd, bn] = CALENDAR_TAG.exec(b);
  return `${ay}${am}${ad}`.localeCompare(`${by}${bm}${bd}`) || Number(an) - Number(bn);
}

/** The next tag for `now`'s UTC date: one past that day's highest build number. */
export function nextCalendarTag(now, tags) {
  const day = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('.');
  let highest = 0;
  for (const tag of tags) {
    if (isCalendarTag(tag) && tag.startsWith(`${day}.`)) {
      highest = Math.max(highest, Number(tag.slice(day.length + 1)));
    }
  }
  return `${day}.${highest + 1}`;
}

/** The build's version from what git says about HEAD. */
export function resolveVersion({ headTag, nearestTag, previousTag, commit, dirty }) {
  if (headTag) {
    return {
      version: dirty ? `${headTag}+dirty` : headTag,
      previous: previousTag ?? '',
      commit,
      imageTag: dirty ? commit : headTag,
    };
  }
  const build = dirty ? `${commit}.dirty` : commit;
  return {
    version: `${nearestTag ?? 'dev'}+${build}`,
    previous: nearestTag ?? '',
    commit,
    imageTag: commit,
  };
}

/** Wait for CI's tag only for an untagged commit on main, unless the deploy says not to. */
export function shouldWait({ headTag, onMain, untagged }) {
  return !headTag && onMain && !untagged;
}

/** Checks every `intervalMs` until `check` finds a tag; null after `timeoutMs`. */
export async function waitForTag({ check, sleep, now, intervalMs = 30_000, timeoutMs = 900_000 }) {
  const start = now();
  for (;;) {
    const tag = await check();
    if (tag) return tag;
    if (now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

// ---- git -------------------------------------------------------------------------------------

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

function calendarTagsAt(rev) {
  return (tryGit('tag', '--points-at', rev) ?? '')
    .split('\n')
    .filter(isCalendarTag)
    .sort(compareCalendarTags);
}

function headTag() {
  return calendarTagsAt('HEAD').at(-1) ?? null;
}

function nearestTag(rev) {
  const tag = tryGit('describe', '--tags', '--abbrev=0', '--match', DESCRIBE_MATCH, rev);
  return tag && isCalendarTag(tag) ? tag : null;
}

function warn(message) {
  process.stderr.write(`${message}\n`);
}

function tag() {
  git('fetch', '--tags', 'origin');
  const existing = headTag();
  if (existing) {
    console.log(existing);
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const next = nextCalendarTag(new Date(), git('tag', '--list').split('\n'));
    git('tag', next, 'HEAD');
    try {
      git('push', 'origin', `refs/tags/${next}`);
      console.log(next);
      return;
    } catch (err) {
      warn(`push of ${next} refused (attempt ${attempt}): ${err.message.split('\n')[0]}`);
      tryGit('tag', '-d', next);
      git('fetch', '--tags', 'origin');
    }
  }
  throw new Error('could not push a calendar tag after 5 attempts');
}

async function resolve(untagged) {
  if (tryGit('fetch', '--tags', 'origin', 'main') === null) {
    warn('warning: git fetch failed; the version comes from the tags already here');
  }
  const commit = git('rev-parse', '--short', 'HEAD');
  let head = headTag();
  const onMain = tryGit('merge-base', '--is-ancestor', 'HEAD', 'origin/main') !== null;
  if (shouldWait({ headTag: head, onMain, untagged })) {
    warn(`waiting for CI to tag ${commit} (checking every 30 s for up to 15 minutes)…`);
    head = await waitForTag({
      check: async () => {
        tryGit('fetch', '--tags', 'origin');
        return headTag();
      },
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      now: Date.now,
    });
    if (!head) {
      warn(`no tag for ${commit} after 15 minutes: wait for CI or deploy with -Untagged`);
      process.exit(1);
    }
  }
  const v = resolveVersion({
    headTag: head,
    nearestTag: head ?? nearestTag('HEAD'),
    previousTag: head ? nearestTag('HEAD^') : nearestTag('HEAD'),
    commit,
    dirty: (tryGit('status', '--porcelain', '--untracked-files=no') ?? '') !== '',
  });
  console.log(`APP_VERSION=${v.version}`);
  console.log(`APP_VERSION_PREVIOUS=${v.previous}`);
  console.log(`APP_COMMIT=${v.commit}`);
  console.log(`IMAGE_TAG=${v.imageTag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'tag') tag();
  else if (cmd === 'resolve') await resolve(rest.includes('--untagged'));
  else {
    warn('usage: version.mjs tag | resolve [--untagged]');
    process.exit(2);
  }
}
