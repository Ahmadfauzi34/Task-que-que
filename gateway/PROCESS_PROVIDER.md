# Registered process provider contract

The registered process provider is an internal D5 delegated-system substrate. It does **not** expose arbitrary process execution, a shell, caller-selected argv, caller-selected environment, caller-selected cwd, or a public MCP tool.

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

Registered process execution is never A0. Starting a process consumes execution authority even when the target is logically read-only.

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
- timeout, cancellation, and output overflow kill the process group
- public process capability and MCP exposure remain absent

## Public exposure gate

This substrate is not itself permission to expose process execution to an agent. A later public provider must separately prove capability discovery, runtime availability, session binding, tool schema, exact registered-command selection, result projection, and physical Android behavior.

No future public layer should accept raw executable paths, arbitrary argv, arbitrary environment variables, arbitrary cwd values, or shell source text.
