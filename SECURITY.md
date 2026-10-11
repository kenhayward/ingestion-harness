# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report them privately through GitHub instead:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Include steps to reproduce, the affected component (`apps/api`, `apps/web`, `worker`,
`deploy/`) and its impact.

You should get an acknowledgement within a few days. We'll keep you updated while we work on a
fix and credit you in the advisory unless you'd rather we didn't.

## Supported versions

Only the latest `main` is supported. Fixes are not backported.

## Scope notes

- The stack is designed to run on a trusted network. Put the API behind your own
  authentication and TLS before exposing it publicly.
- Uploaded PDFs and their extracted text are sent to the LLM providers configured in
  `config/llm-providers.yaml`. Choose providers that suit your data.
- Never commit secrets. Keep them in `deploy/.env` locally (git-ignored) and in
  `/etc/ingestion-harness/<env>.env` on deploy hosts.
