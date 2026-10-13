# 0010: LLM endpoints and curated models live in the database; .env seeds them

**Status:** accepted · 2026-10-13 · phase 1 of 4 implemented

## Context
Content Transformation Studio (CT Studio) had one local LLM endpoint (`LOCAL_LLM_BASE_URL`) next
to the foundation providers (Anthropic, OpenAI), all defined in `config/llm-providers.yaml`. The
worker read the file once at startup. Discovery listed every model each endpoint served and every
one appeared in the model pickers.

People run several model servers (a GPU box per model family, a vision box for OCR). They want a
set of endpoints, each offering only the models chosen for it, managed by an admin from the app
rather than by editing files and restarting workers.

## Decision
- **Three tables (migration 0024):**
  - **`llm_endpoints`:** one row per endpoint. Its name is the model-ref prefix
    (`endpoint/model-id`, so today's `local/…`, `anthropic/…` and `openai/…` refs keep working).
    It holds the kind, base URL, data-policy `location`, key, options and enabled flag.
  - **`llm_models.curated`:** the models offered in the pickers. Discovered models stay
    suggestions until curated.
  - **`llm_aliases`:** `default`, `fast`, `draft` and `ocr` (the OCR model).
- **.env seeds; the UI wins.** On start the worker seeds the config file's providers (with their
  `${VAR}` values) and the endpoints in `LLM_ENDPOINTS`. It writes with insert-or-update, never
  touching a row an admin edited (`edited_at`) or added (`source = 'ui'`).
  - An env-seeded row that has left `.env` is removed.
  - A model an admin curated or removed (`curated_edited_at`) stays as they chose.
  - An unchanged `.env` changes nothing, so the version doesn't move.
- **Variables:**
  - **Model lists:** `ANTHROPIC_MODELS`, `OPENAI_MODELS`, `LOCAL_LLM_MODELS` (comma-separated).
  - **Aliases:** `DEFAULT_MODEL`, `FAST_MODEL`, `DRAFT_MODEL`, `OCR_MODEL`.
  - **More endpoints:** `LLM_ENDPOINTS=name=baseUrl|model1,model2[|local|external[|kind]]`
    (`;`-separated), with their keys in `LLM_ENDPOINT_KEYS=name=key;…`.
  - **Why fixed names:** the worker's compose service passes variables by name, so per-endpoint
    variable names would never reach it.
  - **Options:** an extra endpoint starts with the request options of the shipped provider of the
    same kind and location.
- **The worker builds its registry from the database and reloads it.**
  - A trigger moves `llm_config_state.version` (and `NOTIFY ih_llm_config`) on every change to
    endpoints, aliases, curation or enabling. Discovery's routine upserts don't move it.
  - Every few seconds (`CONFIG_CHECK_S`) the worker compares versions and rebuilds the registry
    and the OCR model. Running jobs keep the registry they started with.
  - Every stored endpoint is optional: one without a usable key is skipped with a warning,
    never a crash.
- **Keys entered in the UI are stored encrypted (phase 3).**
  - **Cipher:** AES-256-GCM with a master key from `.env` (`LLM_SECRETS_KEY`, 32 bytes, base64),
    as `v1:base64(nonce‖ciphertext‖tag)` in a new `llm_endpoints.api_key_enc` column.
  - **Who encrypts and decrypts:** the API encrypts on write and never returns a key, only
    whether one is set. The worker decrypts, and a stored key wins over `api_key_env`.
  - **Fixture:** a shared test fixture holds TypeScript and Python in step.
  - **Without the master key:** setting a key in the UI is refused (409), and endpoints with an
    encrypted key are skipped by the worker.
  - **Rotation:** `LLM_SECRETS_KEY_PREVIOUS` decrypts during a rotation.
- **The API keeps no LLM logic.** The admin routes (phase 3) only write the tables. Discovery
  for an endpoint is a document-less `discover` job the worker runs (phase 4).

## Phases
1. Tables, seeding, the registry from the database and reload. No visible change: the pickers
   still list every model the worker discovered.
2. Pickers list curated, enabled models only; discovery becomes suggestions.
3. Admin API and the Models page (the admin's name menu, top right), with encrypted keys.
4. Aliases and the OCR model in the UI; the `discover` job.

## Consequences
- **The database is now the source of truth for models.** The config file and `.env` describe
  defaults, not the running state. Removing an endpoint from `.env` removes it only if no admin
  edited it.
- **Templates and jobs naming a model on a removed endpoint fail resolution as before.** That's
  a config error, so the job goes to `needs_review` with a `ModelResolutionError`. Phase 3 refuses
  to delete an endpoint or model that an alias names.
- **An admin can change an endpoint's `location`, which changes what the data policy allows.**
  The change is recorded (`updated_by`, `edited_at`). OCR pointed elsewhere with `OCR_BASE_URL`
  still inherits the named endpoint's location.
- **The step cache key already includes each endpoint's kind, base URL and options**
  (`cache_fingerprint`), so edits invalidate cached steps as they should.
- **Python only in phase 1.** The seeding and the store are worker code. The TypeScript side
  joins in phase 3, with the admin API.
