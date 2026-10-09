# 0003 — Versioned YAML document specs in the repo

**Status:** accepted · 2026-10-09

## Context
Each document type has a known structure and expected contents. The definition (sections,
prompts, schemas, output mapping) must be reviewable, testable and reproducible.

## Decision
`specs/<id>/v<N>/spec.yaml` + Jinja2 prompt templates, validated by Zod (API) and Pydantic
(worker) — both strict, both run against every committed spec in their test suites. Published
versions are immutable; jobs record `spec_id` + `spec_version`.

## Consequences
- Spec changes go through PR review and CI like code.
- Two schema implementations must be kept in sync (enforced by the contract tests and the PR
  template). A generated JSON Schema could replace one side later.
- A UI editor, if wanted later, would write PRs or a DB overlay rather than mutate files.
