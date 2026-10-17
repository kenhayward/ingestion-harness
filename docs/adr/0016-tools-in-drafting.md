# 0016: Tools for Workbench drafting models, and a model log

**Status:** accepted · 2026-10-17

## Context
Every model call was a single reply: the worker put everything into one prompt, checked the JSON
answer and asked again with the errors (`extract.run_extraction`). Three drafting stages suffered:

- **Sections** wrote anchor regexes blind; the worker tested them afterwards and gave one round of
  feedback (`drafting.anchor_check`).
- **Mapping** could only choose from a shortlist fixed before the call (at most 300 terms); a term
  retrieval missed could not be chosen.
- **Revise** saw at most 8 dev samples, each cut at 40,000 characters, so it often could not read
  the pages behind a failure.

The prompts and replies were written to the runs bucket but nothing in the app showed them.

## Decision
- **Tools for drafting only.** `tool_loop.run_tool_extraction` holds a conversation: the model may
  call the stage's tools, then answers by calling `submit`, whose arguments are the stage's JSON
  (validated as before; a rejected answer goes back as the submit call's error result, up to
  `DRAFT_ATTEMPTS`). Turns (12) and tool calls (20) are capped; the last turn offers only
  `submit`. Production extraction, OCR and the survey, outputs and steps stages never call it:
  they still make single replies, so the step cache, regression scores and OCR cache are untouched.
- **The tools** read only what drafting may already see:
  - `test_anchors` (sections, revise): applies proposed section changes to the draft and segments
    the dev samples with the anchor preview's capped code.
  - `read_sample_pages` (revise): pages of any dev sample of the project (5 a call, 60,000
    characters a run), never a holdout one; each read for an external model is an
    `external model call` event.
  - `search_terms` and `term_detail` (mapping): retrieval over the pinned ontology versions and a
    term by IRI (`OntologyStore.term`). A term either returns may be chosen like a shortlisted one.
- **Providers** gain an optional `converse` (`llm.base.ToolCapable`): Anthropic tool use (the
  reply's content blocks sent back as they came, so thinking survives), OpenAI chat functions
  (streamed argument deltas assembled by index; the whole-reply fallback as before) and Responses
  function calls (output items sent back). `complete_json` is unchanged.
- **Per-endpoint switch.** `llm_endpoints.tool_calls` (migration 202610172040, default on;
  Administration > Models, *Tool calls*): off, drafting makes single replies as before. A stage
  uses tools when the endpoint allows them and its adapter can (`ModelRegistry.supports_tools`).
- **Progress.** The model phase's `drafting progress` events of a conversation carry the running
  tool (`tool: {name, summary}`, null between tools) and `toolCalls`; the Workbench shows the
  tool on the same line as the token count. The mapping stage now reports its phases too.
- **Model log.** Every drafting run writes `{job}/draft-log.json` (`draftLogKey`, `DraftLogSchema`)
  after each round, whatever its outcome: prompt, replies, tool calls and results, rejected answers
  and the error that ended it. It replaces drafting's per-attempt audit files.
  `GET /api/workbench/projects/:id/proposals/:pid/log` returns it (older runs rebuilt from their
  attempt files, `legacy`), shown as each proposal's *Model log*.

## Consequences
- A tool run costs more model input: the conversation is resent every turn.
- A model that answers in text instead of calling `submit` still works: a valid JSON reply is taken.
- Some OpenAI-compatible servers mishandle tools; the endpoint switch is the remedy.
