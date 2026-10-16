import { randomBytes } from 'node:crypto';
import {
  GitHubRepoBodySchema,
  GitHubRepoSchema,
  ProfileBodySchema,
  ProfileSchema,
  type GitHubLinkResult,
  type Profile,
} from '@ih/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessRepo, SessionInfo } from '../access/repo.js';
import { sha256 } from '../access/tokens.js';
import { decryptSecret, encryptSecret } from '../llm/secrets.js';
import { error, md, noContent, redirect, res } from '../openapi/zod.js';
import { GitHubError } from './github.js';
import { LINK_STATE_MS, type StoredProfile } from './repo.js';

export const GITHUB_STATE_COOKIE = 'ih_github_state';
const STATE_PATH = '/api/profile/github';
const CALLBACK_PATH = `${STATE_PATH}/callback`;
const NO_PROFILE = 'the admin from the API log has no profile';
const UNAVAILABLE =
  'GitHub linking is not set up: an admin sets GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and LLM_SECRETS_KEY';
const NOT_LINKED = 'link a GitHub account first';
const TAGS = ['Profile'];

const CallbackQuery = z.object({
  code: z.string().max(200).optional().describe('From GitHub: the code for the token.'),
  state: z.string().max(200).optional().describe('From GitHub: the state Connect sent.'),
  error: z.string().max(200).optional().describe('From GitHub, when the user said no.'),
});

/** Where the app opens after the GitHub link: the Profile dialog's GitHub section. */
const backToApp = (result: GitHubLinkResult) => `/#/account/profile/github?github=${result}`;

/**
 * The signed-in user's own profile (docs/design/profile.md): details, a linked GitHub account
 * (OAuth web flow) and the repository recipe YAML will go to. Registered by `registerAccess`, so
 * only with access control on; the admin from the API log has none (409).
 */
export function registerProfileRoutes(app: FastifyInstance, access: AccessRepo): void {
  const { profiles } = app.deps;
  const github = app.deps.github ?? null;
  const secrets = app.deps.llmSecrets;
  const available = github !== null && secrets !== null;

  const view = (auth: SessionInfo, stored: StoredProfile): Profile => ({
    name: auth.label,
    email: auth.email,
    jobTitle: stored.jobTitle,
    company: stored.company,
    linkedin: stored.linkedin,
    github: stored.github && {
      login: stored.github.login,
      avatarUrl: stored.github.avatarUrl,
      linkedAt: stored.github.linkedAt,
      repo: stored.github.repo,
    },
    githubAvailable: available,
  });

  /** The signed-in user, unless it is the admin from the log (answered 409 here). */
  const owner = (req: FastifyRequest, reply: FastifyReply): SessionInfo | null => {
    const auth = req.auth!;
    if (auth.email === null) {
      void reply.code(409).send({ error: NO_PROFILE });
      return null;
    }
    return auth;
  };

  const redirectUri = (req: FastifyRequest) =>
    app.deps.githubRedirectUrl ?? `${req.protocol}://${req.host}${CALLBACK_PATH}`;

  /** The linked account's token, or null after answering 409 (none linked). */
  const tokenOf = async (userId: string, reply: FastifyReply) => {
    const stored = (await profiles.get(userId)).github;
    if (!stored || !secrets) {
      void reply.code(409).send({ error: NOT_LINKED });
      return null;
    }
    return { token: decryptSecret(stored.tokenEnc, secrets), login: stored.login };
  };

  const gitHubFailure = (reply: FastifyReply, err: unknown) => {
    if (err instanceof GitHubError) return reply.code(502).send({ error: err.message });
    throw err;
  };

  app.get(
    '/api/profile',
    {
      schema: {
        tags: TAGS,
        operationId: 'getProfile',
        summary: 'Get your profile',
        description: md`
          Your name, email address, job title, company and LinkedIn name, and the GitHub account
          you linked with the repository recipe YAML will be stored in. \`githubAvailable\` says
          whether this deployment can link GitHub accounts.
        `,
        response: {
          200: res('Your profile.', ProfileSchema),
          409: error(`\`${NO_PROFILE}\`.`),
        },
      },
    },
    async (req, reply) => {
      const auth = owner(req, reply);
      if (!auth) return reply;
      return view(auth, await profiles.get(auth.userId));
    },
  );

  app.put(
    '/api/profile',
    {
      schema: {
        tags: TAGS,
        operationId: 'updateProfile',
        summary: 'Save your details',
        description: md`
          Saves your name, job title, company and LinkedIn name (the name in
          \`linkedin.com/in/<name>\`, or that address). Blank details are cleared. Your name is
          what jobs and changes you make record. An admin changes your email address.
        `,
        body: ProfileBodySchema,
        response: {
          200: res('Your profile, saved.', ProfileSchema),
          400: error('Why a detail is refused.'),
          409: error(`\`a user with this name already exists\`, or \`${NO_PROFILE}\`.`),
        },
      },
    },
    async (req, reply) => {
      const auth = owner(req, reply);
      if (!auth) return reply;
      const body = ProfileBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { name, ...details } = body.data;
      if (name !== auth.label) {
        const renamed = await access.updateUser(auth.userId, { name });
        if (renamed === 'name_taken') {
          return reply.code(409).send({ error: 'a user with this name already exists' });
        }
        if (typeof renamed === 'string') return reply.code(409).send({ error: NO_PROFILE });
      }
      const stored = await profiles.update(auth.userId, details);
      return view({ ...auth, label: name }, stored);
    },
  );

  app.get(
    '/api/profile/github/connect',
    {
      schema: {
        tags: TAGS,
        operationId: 'connectGitHub',
        summary: 'Start linking a GitHub account',
        description: md`
          A browser navigation: redirects to GitHub, which asks you to let CT Studio read your
          profile and your repositories (scope \`repo read:user\`; the repository will receive
          recipe YAML). GitHub then sends you to the callback. Linking again replaces the
          account. The link must finish within ${LINK_STATE_MS / 60_000} minutes, in the same
          browser.
        `,
        response: {
          302: redirect('To GitHub.'),
          409: error(`\`${UNAVAILABLE}\`, or \`${NO_PROFILE}\`.`),
        },
      },
    },
    async (req, reply) => {
      const auth = owner(req, reply);
      if (!auth) return reply;
      if (!github || !available) return reply.code(409).send({ error: UNAVAILABLE });
      const state = randomBytes(32).toString('base64url');
      await profiles.startLink(auth.userId, sha256(state));
      // Lax, unlike the session cookie: it must come back with GitHub's redirect to the callback.
      void reply.setCookie(GITHUB_STATE_COOKIE, state, {
        httpOnly: true,
        path: STATE_PATH,
        sameSite: 'lax',
        secure: req.protocol === 'https',
        maxAge: LINK_STATE_MS / 1000,
      });
      return reply.redirect(github.authorizeUrl(state, redirectUri(req)), 302);
    },
  );

  app.get(
    '/api/profile/github/callback',
    {
      // GitHub's redirect is a cross-site navigation: the SameSite=Strict session cookie does not
      // come with it. The user is the one who started this link (its state), in this browser
      // (the state cookie).
      config: { public: true },
      schema: {
        tags: TAGS,
        operationId: 'gitHubCallback',
        summary: 'Finish linking a GitHub account',
        description: md`
          Where GitHub sends the browser back to. It needs no session: the \`state\` must be the
          one Connect issued to this browser in the last ${LINK_STATE_MS / 60_000} minutes, and
          it works once. Redirects to the app's Profile dialog with \`github=\` \`linked\`,
          \`denied\` (you said no on GitHub), \`expired\` (the state is unknown, used or not
          this browser's), \`taken\` (another user linked that GitHub account) or \`failed\`.
        `,
        querystring: CallbackQuery,
        response: { 302: redirect("To the app's Profile dialog.") },
      },
    },
    async (req, reply) => {
      const query = CallbackQuery.safeParse(req.query ?? {});
      const cookie = req.cookies[GITHUB_STATE_COOKIE];
      void reply.clearCookie(GITHUB_STATE_COOKIE, { path: STATE_PATH });
      const back = (result: GitHubLinkResult) => reply.redirect(backToApp(result), 302);
      const state = query.success ? query.data.state : undefined;
      if (!state || state !== cookie) return back('expired');
      const userId = await profiles.takeLink(sha256(state));
      if (!userId) return back('expired');
      if (query.data!.error) return back('denied');
      if (!github || !secrets || !query.data!.code) return back('failed');
      try {
        const token = await github.exchange(query.data!.code, redirectUri(req));
        const user = await github.user(token);
        const linked = await profiles.linkGitHub(userId, {
          ...user,
          tokenEnc: encryptSecret(token, secrets),
        });
        if (linked === 'taken') return back('taken');
        req.log.info({ userId, github: user.login }, 'GitHub account linked');
        return back('linked');
      } catch (err) {
        req.log.warn({ err, userId }, 'GitHub link failed');
        return back('failed');
      }
    },
  );

  app.delete(
    '/api/profile/github',
    {
      schema: {
        tags: TAGS,
        operationId: 'unlinkGitHub',
        summary: 'Unlink your GitHub account',
        description: md`
          Forgets the linked account and its chosen repository, and asks GitHub to revoke the
          token (if GitHub cannot, the account is still unlinked here; revoke CT Studio under
          your GitHub settings' Applications). Your picture goes back to your initials.
        `,
        response: {
          204: noContent('Unlinked (also when nothing was linked).'),
          409: error(`\`${NO_PROFILE}\`.`),
        },
      },
    },
    async (req, reply) => {
      const auth = owner(req, reply);
      if (!auth) return reply;
      const tokenEnc = await profiles.unlinkGitHub(auth.userId);
      if (tokenEnc && github && secrets) {
        try {
          await github.revoke(decryptSecret(tokenEnc, secrets));
        } catch (err) {
          req.log.warn({ err, userId: auth.userId }, 'GitHub token not revoked');
        }
      }
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/profile/github/repos',
    {
      schema: {
        tags: TAGS,
        operationId: 'listGitHubRepos',
        summary: 'List repositories you can push to',
        description: md`
          The repositories the linked GitHub account can push to (owned, collaborator and
          organisation ones, at most 1,000), by name: the choices for the YAML repository.
        `,
        response: {
          200: res('The repositories.', z.array(GitHubRepoSchema)),
          409: error(`\`${NOT_LINKED}\`, or \`${NO_PROFILE}\`.`),
          502: error('What GitHub said, e.g. that it no longer accepts the link.'),
        },
      },
    },
    async (req, reply) => {
      const auth = owner(req, reply);
      if (!auth) return reply;
      const link = await tokenOf(auth.userId, reply);
      if (!link) return reply;
      try {
        return await github!.repos(link.token);
      } catch (err) {
        return gitHubFailure(reply, err);
      }
    },
  );

  app.put(
    '/api/profile/github/repo',
    {
      schema: {
        tags: TAGS,
        operationId: 'setGitHubRepo',
        summary: 'Choose the repository for recipe YAML',
        description: md`
          Chooses the repository recipe YAML will be stored in (\`owner/name\`, any case; kept
          as GitHub spells it), or none (\`null\`). The linked account must be able to push to
          it.
        `,
        body: GitHubRepoBodySchema,
        response: {
          200: res('Your profile, saved.', ProfileSchema),
          400: error('`<login> cannot push to <owner/name> on GitHub`, or a malformed name.'),
          409: error(`\`${NOT_LINKED}\`, or \`${NO_PROFILE}\`.`),
          502: error('What GitHub said, e.g. that it no longer accepts the link.'),
        },
      },
    },
    async (req, reply) => {
      const auth = owner(req, reply);
      if (!auth) return reply;
      const body = GitHubRepoBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const link = await tokenOf(auth.userId, reply);
      if (!link) return reply;
      let repo: string | null = null;
      if (body.data.repo !== null) {
        const wanted = body.data.repo.toLowerCase();
        let repos;
        try {
          repos = await github!.repos(link.token);
        } catch (err) {
          return gitHubFailure(reply, err);
        }
        repo = repos.find((r) => r.fullName.toLowerCase() === wanted)?.fullName ?? null;
        if (repo === null) {
          return reply
            .code(400)
            .send({ error: `${link.login} cannot push to ${body.data.repo} on GitHub` });
        }
      }
      const stored = await profiles.setGitHubRepo(auth.userId, repo);
      if (stored === 'not_linked') return reply.code(409).send({ error: NOT_LINKED });
      return view(auth, stored);
    },
  );
}
