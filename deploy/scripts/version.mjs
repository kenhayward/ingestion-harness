#!/usr/bin/env node
// Calendar versions (ADR 0014): every merge to main is tagged YYYY.MM.DD.N by CI, and the deploy
// scripts bake the build's version into the images. Node builtins only, so a deploy host needs
// Node but no `npm ci`. Tests: apps/api/test/deploy-version.test.ts.
//
//   node deploy/scripts/version.mjs tag                 CI: tag HEAD with the next calendar tag
//   node deploy/scripts/version.mjs resolve [--untagged] deploy: print APP_VERSION, APP_VERSION_PREVIOUS,
//                                                      APP_COMMIT and IMAGE_TAG lines
//   node deploy/scripts/version.mjs image-tag           rollback (--no-build): the image tag a clean
//                                                      build of HEAD was given
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

/**
 * Wait for CI's tag only for an untagged commit on main's first-parent line (the commits CI tags)
 * that no tag contains yet (else CI passed something newer and will never tag it), and only when
 * the fetch worked (offline, no tag can arrive), unless the deploy says not to.
 */
export function shouldWait({ headTag, onMain, taggedLater, fetched, untagged }) {
  return !headTag && onMain && !taggedLater && fetched && !untagged;
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

// ---- git (every lookup takes the repository's directory, for the tests) ----------------------

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

const lines = (text) => (text ?? '').split('\n').filter(Boolean);

function headTag(cwd) {
  return (
    lines(tryGit(cwd, 'tag', '--points-at', 'HEAD'))
      .filter(isCalendarTag)
      .sort(compareCalendarTags)
      .at(-1) ?? null
  );
}

/** The nearest calendar tag in `rev`'s history, skipping look-alikes such as `2026.10.17.x`. */
export function nearestCalendarTag(rev, cwd = process.cwd()) {
  const excluded = [];
  for (let i = 0; i < 20; i++) {
    const exclude = excluded.flatMap((t) => ['--exclude', t]);
    const found = tryGit(
      cwd,
      'describe',
      '--tags',
      '--abbrev=0',
      '--match',
      DESCRIBE_MATCH,
      ...exclude,
      rev,
    );
    if (!found || isCalendarTag(found)) return found;
    excluded.push(found);
  }
  return null;
}

/** Whether `rev` is on `branch`'s first-parent line: the merges CI tags, not a PR's own commits. */
export function onFirstParent(rev, branch, cwd = process.cwd()) {
  const sha = tryGit(cwd, 'rev-parse', '--verify', `${rev}^{commit}`);
  return sha !== null && lines(tryGit(cwd, 'rev-list', '--first-parent', branch)).includes(sha);
}

/** Whether a calendar tag already contains `rev` (on it or on a later commit). */
export function containedByCalendarTag(rev, cwd = process.cwd()) {
  return lines(tryGit(cwd, 'tag', '--contains', rev, '--list', DESCRIBE_MATCH)).some(isCalendarTag);
}

/** A rollback's image tag: what a clean build of HEAD was tagged (its calendar tag, else the hash). */
export function noBuildImageTag(cwd = process.cwd()) {
  return headTag(cwd) ?? git(cwd, 'rev-parse', '--short', 'HEAD');
}

function warn(message) {
  process.stderr.write(`${message}\n`);
}

function tag(cwd) {
  git(cwd, 'fetch', '--tags', 'origin');
  const existing = headTag(cwd);
  if (existing) {
    console.log(existing);
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const next = nextCalendarTag(new Date(), lines(git(cwd, 'tag', '--list')));
    git(cwd, 'tag', next, 'HEAD');
    try {
      git(cwd, 'push', 'origin', `refs/tags/${next}`);
      console.log(next);
      return;
    } catch (err) {
      warn(`push of ${next} refused (attempt ${attempt}): ${err.message.split('\n')[0]}`);
      tryGit(cwd, 'tag', '-d', next);
      git(cwd, 'fetch', '--tags', 'origin');
    }
  }
  throw new Error('could not push a calendar tag after 5 attempts');
}

async function resolve(untagged, cwd) {
  const fetched = tryGit(cwd, 'fetch', '--tags', 'origin', 'main') !== null;
  if (!fetched) warn('warning: git fetch failed; the version comes from the tags already here');
  const commit = git(cwd, 'rev-parse', '--short', 'HEAD');
  let head = headTag(cwd);
  const wait = shouldWait({
    headTag: head,
    onMain: onFirstParent('HEAD', 'origin/main', cwd),
    taggedLater: containedByCalendarTag('HEAD', cwd),
    fetched,
    untagged,
  });
  if (wait) {
    warn(`waiting for CI to tag ${commit} (checking every 30 s for up to 15 minutes)…`);
    head = await waitForTag({
      check: async () => {
        tryGit(cwd, 'fetch', '--tags', 'origin');
        return headTag(cwd);
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
    nearestTag: head ?? nearestCalendarTag('HEAD', cwd),
    previousTag: head ? nearestCalendarTag('HEAD^', cwd) : nearestCalendarTag('HEAD', cwd),
    commit,
    dirty: (tryGit(cwd, 'status', '--porcelain', '--untracked-files=no') ?? '') !== '',
  });
  console.log(`APP_VERSION=${v.version}`);
  console.log(`APP_VERSION_PREVIOUS=${v.previous}`);
  console.log(`APP_COMMIT=${v.commit}`);
  console.log(`IMAGE_TAG=${v.imageTag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();
  if (cmd === 'tag') tag(cwd);
  else if (cmd === 'resolve') await resolve(rest.includes('--untagged'), cwd);
  else if (cmd === 'image-tag') console.log(noBuildImageTag(cwd));
  else {
    warn('usage: version.mjs tag | resolve [--untagged] | image-tag');
    process.exit(2);
  }
}
