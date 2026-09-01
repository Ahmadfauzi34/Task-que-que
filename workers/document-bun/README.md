# Reference document worker

This is a deliberately small Bun worker that demonstrates how an external process consumes the loopback worker protocol without SQLite access or arbitrary command execution.

## Contract

The worker registers as `cpu` because the Rust worker protocol partitions by queue kind. It then applies an application-level allowlist and accepts only task name `document.process`.

Input payload:

```json
{"text":"hello world","document_id":"optional-safe-id"}
```

The worker computes deterministic metadata and writes it atomically to `task-<task_id>.json` in the configured output directory:

```json
{
  "schema_version": 1,
  "task_id": 1,
  "document_id": "optional-safe-id",
  "bytes": 11,
  "characters": 11,
  "lines": 1,
  "words": 2,
  "sha256": "..."
}
```

The original document text is not copied into the result artifact. A task is marked complete only after the result file has been written successfully. Reprocessing the same task id replaces the same deterministic result path, so a retry after an uncertain completion acknowledgement does not create an additional output artifact.

Malformed payloads fail with bounded worker error code `invalid_payload`. Unknown CPU task names fail with `unsupported_task`; the worker never interprets a task payload as a command.

## Run

The Rust queue daemon must listen on `127.0.0.1:7331` and the Rust worker broker on `127.0.0.1:7332`.

```sh
DOCUMENT_WORKER_OUTPUT_DIR="$HOME/task-results" \
  bun run workers/document-bun/src/worker.ts
```

Reference configuration:

- `DOCUMENT_WORKER_ORIGIN=http://127.0.0.1:7332`
- `DOCUMENT_WORKER_ID=document-reference-worker`
- `DOCUMENT_WORKER_CAPACITY=1`
- `DOCUMENT_WORKER_POLL_MS=250`
- `DOCUMENT_WORKER_OUTPUT_DIR=./var/document-worker-results`

The broker origin is required to be HTTP loopback. These are reference defaults, not engine limits.
