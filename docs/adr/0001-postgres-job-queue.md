# 0001 — Postgres table as the job queue

**Status:** accepted · 2026-10-09

## Context
The API must hand PDF-processing jobs to Python workers and expose status, retries and history.
Options considered: Postgres queue table, Redis queue + Postgres metadata, S3 event-driven.

## Decision
Use a `jobs` table in Postgres. Workers claim with `SELECT … FOR UPDATE SKIP LOCKED`; retries
use `run_after` backoff; stale locks are reaped.

## Consequences
- One fewer service; enqueue is transactional with the `documents` insert; status, history and
  audit are plain SQL.
- Throughput is bounded by Postgres (comfortably thousands of jobs/min — far beyond LLM-bound
  processing rates). Revisit if we need sub-second fan-out or very high volumes.
- Workers poll (`POLL_INTERVAL_S`); `LISTEN/NOTIFY` can be added later to cut latency.
