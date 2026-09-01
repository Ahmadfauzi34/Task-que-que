# Bun reference worker handler registry

The Bun reference worker separates queue lifecycle from task-specific execution.

```text
Rust worker capability
        |
        v
WorkerHandlerRegistry
        |
        +-- exact task-name lookup
        |
        v
allowlisted handler
```

The registry is an application-level allowlist, not a plugin loader and not a generic executor.

Current production registration:

- hard Rust capability: `cpu`
- handler: `document.process`

Adding another Bun handler requires explicit source registration and tests. A handler whose `taskType` differs from the registry's hard capability is rejected at construction time. Duplicate task names are rejected. Unknown task names resolve to no handler and the worker fails the claimed task as `unsupported_task`.

The registry intentionally does not load modules from task payloads, filesystem paths, environment-provided code, package names, URLs, or shell commands.

Other worker implementations (Python, WASM, model inference, etc.) may implement the same Rust worker protocol independently; they do not need to share this Bun registry implementation.
