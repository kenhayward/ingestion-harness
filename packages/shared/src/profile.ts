import { z } from 'zod';

/**
 * A user's own profile (the account menu's Profile, [design](../../../docs/design/profile.md)):
 * details they edit themselves and a linked GitHub account. TS only: the worker never reads it.
 */

/** The name in `linkedin.com/in/<name>`: letters, digits and dashes. */
const LINKEDIN_NAME = /^[A-Za-z0-9-]{3,100}$/;
const LINKEDIN_URL =
  /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)\/?(?:[?#].*)?$/i;

/**
 * The LinkedIn name of what was typed: the name itself (an `@` in front is dropped) or a profile
 * URL (`https://www.linkedin.com/in/<name>/`). null when it is neither.
 */
export function linkedinName(input: string): string | null {
  const text = input.trim().replace(/^@/, '');
  const name = LINKEDIN_URL.exec(text)?.[1] ?? text;
  return LINKEDIN_NAME.test(name) ? name : null;
}

/** `owner/name`, as GitHub allows them. */
const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Why a repository name is refused; null when it reads as `owner/name`. */
export function githubRepoProblem(repo: string): string | null {
  return GITHUB_REPO.test(repo) ? null : 'name the repository as owner/name';
}

/** Blank text is null; anything else is trimmed. */
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(max).nullable(),
  );

/** What `PUT /api/profile` takes: every detail at once (email is changed by an admin). */
export const ProfileBodySchema = z.object({
  name: z.string().trim().min(1).max(100).describe('Unique, whatever the case.'),
  jobTitle: optionalText(100).describe('Blank: none.'),
  company: optionalText(100).describe('Blank: none.'),
  linkedin: optionalText(200)
    .transform((v, ctx) => {
      if (v === null) return null;
      const name = linkedinName(v);
      if (name === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'give the LinkedIn name in linkedin.com/in/<name>, or that address',
        });
        return z.NEVER;
      }
      return name;
    })
    .describe('The name in `linkedin.com/in/<name>`, or that address. Blank: none.'),
});
export type ProfileBody = z.infer<typeof ProfileBodySchema>;

/** What `PUT /api/profile/github/repo` takes. */
export const GitHubRepoBodySchema = z.object({
  repo: z
    .string()
    .trim()
    .refine((v) => githubRepoProblem(v) === null, 'name the repository as owner/name')
    .nullable()
    .describe('`owner/name` of a repository the linked account can push to; null: none.'),
});

export const GitHubLinkSchema = z.object({
  login: z.string().describe('The GitHub user name.'),
  avatarUrl: z.string().url().describe("The account's picture: the user's picture in the app."),
  linkedAt: z.string().datetime(),
  repo: z
    .string()
    .nullable()
    .describe('`owner/name` of the repository recipe YAML will be stored in; null: not chosen.'),
});
export type GitHubLink = z.infer<typeof GitHubLinkSchema>;

export const ProfileSchema = z.object({
  name: z.string(),
  email: z.string().nullable().describe('Changed by an admin under Administration > Access.'),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  linkedin: z.string().nullable().describe('The name in `linkedin.com/in/<name>`.'),
  github: GitHubLinkSchema.nullable().describe('null: no GitHub account linked.'),
  githubAvailable: z
    .boolean()
    .describe('Whether this deployment can link GitHub accounts (an OAuth app is configured).'),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const GitHubRepoSchema = z.object({
  fullName: z.string().describe('`owner/name`.'),
  private: z.boolean(),
});
export type GitHubRepo = z.infer<typeof GitHubRepoSchema>;

/** How the GitHub link ended: the `github` value of the address the app opens afterwards. */
export const GITHUB_LINK_RESULTS = ['linked', 'denied', 'expired', 'taken', 'failed'] as const;
export type GitHubLinkResult = (typeof GITHUB_LINK_RESULTS)[number];
