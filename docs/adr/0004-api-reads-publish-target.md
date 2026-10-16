# 0004 — The API reads the publish target for the Results page

**Status:** accepted · 2026-10-11

**Update (migration 0050):** the single `TARGET_S3_*` target became admin-managed publishing
targets chosen per recipe (`delivery.publishTo`); the API reads each output through the target
recorded on `job_outputs.target_id`. `TARGET_S3_*` only seeds `default`.

## Context
Published outputs go to a deployment-wide final target (`TARGET_S3_*`), which may be a
different S3 endpoint from the internal SeaweedFS. The Results page must show what was actually
delivered.

## Decision
The API resolves the same `TARGET_S3_*` variables as the worker (falling back to `S3_*`) and
holds a second `ObjectStore` for the target. Every read of a `job_outputs` object picks the
store by `stage` (`storeFor`): draft → outputs bucket, published → target.

## Consequences
- Results show exactly what was delivered. Objects later deleted from the target are reported as
  missing rather than reconstructed.
- The API now holds target credentials, so give it read access to the target (write access is
  only needed by the worker).
- No schema or worker change: `job_outputs` already records bucket, prefixed key and publish time.
