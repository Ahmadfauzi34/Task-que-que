# Registered process provider contract

The registered process provider is a D5 delegated-system provider for **operator-registered fixed operations**. It does **not** expose a general process launcher, a shell, caller-selected executable paths, caller-selected argv, caller-selected environment, or caller-selected cwd.

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

For a registry command named `example.inspect`, the projected capability and route are fixed:

```text
capability: process.command.example.inspect
route:      POST /v1/process/example.inspect
input:      no query parameters, no request body
```

The gateway derives the executable, fixed argv, cwd, timeout, output ceiling, authority class, and scope from the validated registry. None of those control-plane values are accepted from the caller.

`system.capabilities` builds ephemeral process capability descriptors from the live validated registry. The static `CAPABILITY_REGISTRY` is not modified, so the operator registry remains the single source of truth. A process capability is runtime-available only while both the registry and the configured native Rust helper validate.

The public capability projection contains the capability name, D5/A1-or-A3 requirement, exact scope, mutation/cancellation flags, and fixed route. It does not disclose the executable path, registry argv, or cwd.

## MCP projection

The MCP layer projects the same live registry-derived descriptors. It does not introduce a second process registry or execution path.

```text
MCP tools/list
      ↓
live registry v2 descriptors
      ↓
signed grant check
      ↓
process.command.<registered-name>

MCP tools/call with {}
      ↓
POST /v1/process/<registered-name>
      ↓
normal gateway router
      ↓
registry v2 authority + exact scope
      ↓
Rust fd-bound helper
```

Each process MCP tool advertises an empty object input schema (`additionalProperties=false`). Caller-selected executable, argv, environment, cwd, query parameters, request bodies, and shell text are not part of the MCP contract.

The existing MCP core still validates protocol version, mirrored method/name headers, origin, request size, JSON-RPC shape, and bearer authentication before the process projection can run. The process adapter only handles a command after the core MCP path has rejected it as unknown from the static registry and the live process registry proves the command exists and the signed grant covers it.

`tools/call` then re-enters the fixed HTTP route with the same bearer token. The HTTP process route remains authoritative and performs the capability check again before the Rust helper can execute.

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
- MCP process tools accept only an empty argument object
- MCP process calls re-enter the fixed HTTP route instead of invoking the Rust helper directly
- timeout, cancellation, and output overflow kill the process group
- malformed gateway result JSON is projected as an MCP tool error

## Proof gate

MCP unit/transport tests are not sufficient for promotion by themselves. Before merge, the exact PR head must also be audited through a real temporary gateway process and the exact-head Android/Termux helper artifact so that the full path is observed on the target environment:

```text
MCP client request
  -> live Bun server
  -> MCP adapter
  -> fixed HTTP route
  -> registry v2 grant check
  -> Rust fd-bound helper
  -> bounded result / process-group fence
```

No future extension should add arbitrary process passthrough, caller-selected executable paths, argv, environment variables, cwd values, or shell source text.