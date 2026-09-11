# Registered process provider contract

The registered process provider is a D5 delegated-system provider for **operator-registered fixed operations**. It does **not** expose a general process launcher, a shell, caller-selected executable paths, caller-selected argv, caller-selected environment, or caller-selected cwd. MCP exposure remains absent in PR #50.

## Registry schema

The operator owns the registry file. Schema version 2 requires every command to declare its execution identity and its authorization class:

```json
{
  "version": 2,
  "commands": [
    {
      "name": "example.inspect",
      "binary": "/absolute/canonical/native-elf",
      "args": ["fixed", "server-owned", "arguments"],
      "cwd": "/absolute/canonical/cwd",
      "timeout_ms": 2000,
      "max_output_bytes": 16384,
      "authority": "invoke",
      "required_scope": "process.command.example.inspect",
      "mutates_state": false
    }
  ]
}
```

The registry, executable, cwd, and Rust process helper are server-owned control-plane objects. They must remain outside a generic delegated writable filesystem root.

## Authority classes

Registered process execution is never A0. Starting a registered operation consumes execution authority even when the target is logically read-only.

```text
read-only registered command
  D5 / A1 INVOKE / process.command.<exact-name>

state-mutating registered command
  D5 / A3 MUTATE_SCOPED / process.command.<exact-name>
```

The schema rejects contradictory declarations. `authority=invoke` requires `mutates_state=false`; `authority=mutate_scoped` requires `mutates_state=true`.

The required scope is deterministic and unique to the registered command. A descriptor named `example.inspect` must use exactly:

```text
process.command.example.inspect
```

A command name alone is not authorization. The signed `CapabilityGrant` must independently satisfy depth, authority, and scope.

## Execution boundary

Authorization is evaluated inside `runRegisteredProcess` before helper validation or spawn:

```text
registered command name
        ↓
operator registry lookup
        ↓
signed grant proof
  depth >= D5
  authority >= command class
  exact scope covered
        ↓
server-owned Rust helper
        ↓
fd-bound executable + cwd
        ↓
execveat(..., AT_EMPTY_PATH)
        ↓
bounded stdout/stderr + timeout/cancel fencing
```

The Rust helper binds executable and cwd identity by file descriptor. Bun launches the helper as a detached process-group leader. Timeout, output overflow, and `AbortSignal` cancellation kill the entire process group.

## Fixed HTTP projection

PR #50 adds an agent-facing HTTP projection for commands that already exist in the operator registry. It does not create a generic execution endpoint.

For a registry command named `example.inspect`, the projected capability and route are fixed:

```text
capability: process.command.example.inspect
route:      POST /v1/process/example.inspect
input:      no query parameters, no request body
```

The gateway derives the executable, fixed argv, cwd, timeout, output ceiling, authority class, and scope from the validated registry. None of those control-plane values are accepted from the caller.

`system.capabilities` builds ephemeral process capability descriptors from the live validated registry. The static `CAPABILITY_REGISTRY` is not modified, so the operator registry remains the single source of truth. A process capability is runtime-available only while both the registry and the configured native Rust helper validate.

The public capability projection contains the capability name, D5/A1-or-A3 requirement, exact scope, mutation/cancellation flags, and fixed route. It does not disclose the executable path, registry argv, or cwd.

## Security invariants

The provider currently enforces these invariants:

- registry path is bounded, canonical, regular, and non-symlink
- registered executable is a canonical regular native ELF executable
- registered cwd is canonical and non-symlink
- registry, executable, cwd, and helper remain outside generic writable filesystem delegation
- argv is fixed by the operator registry
- target environment is minimal and scrubbed
- shell execution is absent
- unknown commands fail before provider execution
- insufficient depth fails before provider execution
- insufficient authority fails before provider execution
- missing command scope fails before provider execution
- an A1 grant cannot execute an A3 mutating command
- public fixed-operation routes reject query parameters and request bodies before execution
- dynamic discovery does not disclose executable, argv, or cwd
- timeout, cancellation, and output overflow kill the process group
- MCP process tools remain absent

## MCP gate

PR #50 deliberately stops at fixed HTTP projection plus `system.capabilities` discovery. MCP exposure requires a separate review and proof gate. Until then, MCP `tools/list` and `tools/call` do not project registered process commands.

Any future MCP layer must consume the same live registry-derived descriptors and must not introduce a second authorization registry or any caller-controlled executable, argv, environment, cwd, or shell text.