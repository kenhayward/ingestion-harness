# Profile

Every user with an email address (everyone but the admin from the API log) opens **Profile**
from the account menu. It is a modal with a ledger of tabs on the left (the user's picture and
name above them) and the open tab on the right, under a `Profile / <tab>` header. Each tab saves
on its own. Only **Close** closes it: a click outside or Escape does not, so typed details are
never lost by a stray click.

| Tab | Icon | What it does |
| --- | --- | --- |
| Personal details | `user` | Name, email (read-only: an admin changes it on the Access page), job title, company, LinkedIn name; the GitHub account and the YAML repository |
| Change password | `lock` | The existing password change (`ChangePassword` `mode="embedded"`) |

The old Change password menu item is gone; `#/account/password` still opens that page.

## Storage

`user_profiles` (migration 0044), one row per user who saved a detail or linked GitHub (none = an
empty profile), `ON DELETE CASCADE` from `users`. The name stays on `users` and is changed through
`AccessRepo.updateUser` (unique whatever the case: 409 `a user with this name already exists`).
LinkedIn is stored as the name in `linkedin.com/in/<name>`; the form takes the name or the address
(`linkedinName` in `packages/shared/src/profile.ts`). `ProfileRepo`
(`apps/api/src/profile/repo.ts`, `MemoryProfileRepo` / `PgProfileRepo`) is held in step by
`apps/api/test/profile-contract.ts` (memory always; Postgres with `IH_TEST_DATABASE_URL`).
TS only: the worker never reads it.

## Linking GitHub

An OAuth app (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, both or neither; `GITHUB_REDIRECT_URL`
when the callback address cannot be read from the request) and `LLM_SECRETS_KEY` (the token is
stored AES-256-GCM encrypted, like endpoint keys) turn it on; without them `githubAvailable` is
false and the dialog says linking is not set up.

1. **Link GitHub account** is a plain link to `GET /api/profile/github/connect` (hidden while the
   details have unsaved edits: the trip to GitHub would lose them). The API stores the hash of a
   random `state` with the user in `github_link_states`, sets it in the `ih_github_state` cookie
   (HttpOnly, `SameSite=Lax`, path `/api/profile/github`, 10 minutes) and redirects to GitHub with
   scope `repo read:user` (`repo`: the YAML feature will push, private repositories too).
2. GitHub sends the browser to `GET /api/profile/github/callback`. That route is public: GitHub's
   redirect is a cross-site navigation, so the `SameSite=Strict` session cookie does not come with
   it. The query `state` must equal the cookie (this browser) and be a stored, unused state under
   10 minutes old (`takeLink` deletes it): that names the user. The API exchanges the code, reads
   the GitHub user and stores id, login, avatar and the encrypted token. One GitHub account
   belongs to one user (unique `github_id`); relinking the same account keeps the chosen
   repository, another account clears it.
3. It redirects to `/#/account/profile/github?github=<result>` (`linked`, `denied`, `expired`,
   `taken`, `failed`; `GITHUB_LINK_RESULTS`). The app opens Profile over Home with the result,
   re-reads `GET /api/auth/me`, and replaces the address with `#/` so a reload or Back does not
   open it again.

When an account is linked, its picture is the user's picture: `me.avatarUrl` (login and me),
shown small beside the name in the account menu's trigger and large in the dialog (`Avatar`,
`apps/web/src/shell/Avatar.tsx`; initials otherwise). **Unlink** (`DELETE /api/profile/github`)
forgets the account and repository and asks GitHub to revoke the token; a failed revoke is
logged and the account is still unlinked. A link refused as `taken` revokes nothing: GitHub may
have handed back the token the other user's link still uses.

## The YAML repository

`GET /api/profile/github/repos` lists the repositories the account can push to (owner,
collaborator and organisation ones, at most 10 pages of 100, by name). `PUT
/api/profile/github/repo` keeps one (`owner/name`, any case, stored as GitHub spells it) after
checking that list, or none (`null`). Nothing writes to it yet: the feature that stores recipe
YAML there is still to come.
