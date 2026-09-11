# Capability depth and authority contract

This document defines the capability model for the Task-que-que reference machine and its MCP projection.

The model is intentionally not a conventional `user/admin` permission ladder. It separates two independent questions:

1. **Depth** — how deep an agent may reason about or interact with the machine.
2. **Authority** — what class of action the agent may actually perform.

A deep view never implies write authority, and high authority never bypasses an insufficient depth or missing scope.

## Depth levels

| Level | Name | Meaning |
| --- | --- | --- |
| D0 | discover | Discover machine capabilities, liveness and readiness. |
| D1 | inspect | Read bounded task/workflow state and provenance projections. |
| D2 | reason | Reserved for planning, compatibility checks and dry-run reasoning surfaces. |
| D3 | execute | Invoke registered capabilities through the admitted execution path. |
| D4 | orchestrate | Compose bounded workflows and multi-specialist execution. |
| D5 | delegated-system | Delegate work to server-controlled external/system capability providers. |
| D6 | operator | Control reference-machine lifecycle and administrative capability registration. |

D5 is an **authorized delegation boundary**, not a sandbox escape primitive. An agent in a restricted environment can ask Task-que-que to perform an action only when the Task-que-que side owns that capability and grants the required authority.

## Authority levels

| Level | Name | Meaning |
| --- | --- | --- |
| A0 | observe | Read non-mutating projections. |
| A1 | invoke | Invoke a registered bounded operation. |
| A2 | compose | Create bounded compositions/workflows. |
| A3 | mutate-scoped | Mutate explicitly scoped server resources or delegated providers. |
| A4 | privileged-delegated | Perform privileged delegated/operator-class actions that are explicitly granted. |

## Scope proof

A capability is authorized only when all three dimensions pass:

```text
grant.depth     >= capability.minDepth
grant.authority >= capability.minAuthority
required scopes are covered by grant scopes
```

Runtime executability is a separate proof:

```text
authorized && provider_available => executable
```

The capability registry is own-property checked. Prototype-looking names must never become capabilities by inheritance.

## Current inventory

The canonical runtime inventory is `gateway/src/capabilities.ts`.

It includes:

- gateway health and readiness
- public task submit/inspect surfaces
- public workflow submit/inspect/result/cancel surfaces
- registered `document.process`
- registered `hash.compute`
- registered `vector.dot`
- registered `agent.invoke`
- registered `workflow.run`
- delegated read-only `filesystem.list`
- delegated read-only `filesystem.stat`
- delegated read-only `filesystem.read`
- delegated mutation `filesystem.write`
- delegated mutation `filesystem.mkdir`

`agent.invoke` is a D5 delegated-system capability because it crosses into a remote-agent provider. Runtime availability is separate: if the remote-agent worker is disabled, registration and authorization do not imply that an executor is online.

The filesystem provider is the first host-system D5 provider. It is disabled unless the operator configures `GATEWAY_FILESYSTEM_ROOT`. The configured root is server-owned policy: callers receive only relative-path operations and cannot override the root.

Read-only filesystem capabilities remain Bun-native and A0:

```text
filesystem.list  -> D5 / A0 / filesystem.inspect
filesystem.stat  -> D5 / A0 / filesystem.inspect
filesystem.read  -> D5 / A0 / filesystem.read
```

Mutation capabilities are separate A3 surfaces:

```text
filesystem.write -> D5 / A3 / filesystem.write
filesystem.mkdir -> D5 / A3 / filesystem.mkdir
```

They are available only when both `GATEWAY_FILESYSTEM_ROOT` and the server-owned `GATEWAY_FILESYSTEM_MUTATOR_BIN` are configured and the Rust mutator's `probe` succeeds. Bun performs authentication, signed depth/authority/scope proof and bounded request validation, but does not implement filesystem mutation. The actual write/mkdir operation is delegated to the PR #44 fd-relative Rust substrate.

`filesystem.write` accepts bounded UTF-8 content only in this version. The Rust substrate performs exact relative-path validation, fd-relative traversal, temp-file + same-directory atomic replacement, file/parent durability sync, and symlink-safe mutation. `filesystem.mkdir` uses the same fd-relative root/parent proof and `mkdirat` boundary.

The mutation result model preserves proof state rather than guessing from transport behavior. A Rust `committed_durability_unknown` result is explicitly reported as committed with unknown durability and `retry_safe=false`. A timeout, unrecognized subprocess exit, or other loss of the final mutator proof is reported as `committed="unknown"`, `durability="unknown"`, and `retry_safe=false`, because the subprocess may have crossed the commit point before the gateway lost its result. Only the Rust substrate's explicit pre-commit `mutation_io_error` may be projected as `committed=false`.

Filesystem delete, arbitrary rename, package installation, arbitrary process execution, Git mutation, and general outbound networking are still **not** capabilities. They require separate providers and proof gates.

## Compatibility state

The existing public gateway behavior is preserved by `LEGACY_COMPAT_GRANT`:

```text
D6 / A4 / scope=*
```

That is a compatibility reference, not the intended MCP session policy. Existing task/workflow routes remain governed by authentication, registry/admission, exact routing, lease fencing, cancellation and declared-result invariants.

Signed capability sessions derive `CapabilityGrant` from trusted server-side authority. A client cannot self-assert a deeper grant through request headers or tool arguments.

## MCP projection

The MCP adapter consumes the canonical capability registry rather than maintaining a second execution-authority list:

```text
reference machine providers
          ↓
canonical capability registry
          ↓
signed depth + authority + scopes
          +
runtime provider availability
          ↓
agent-facing executable projection
          ↓
MCP tools/list
```

A low-depth agent can still inspect registered deeper capabilities through `system.capabilities`, while `tools/list` advertises only capabilities that are both authorized and available.

For read-only filesystem tools, availability requires the server-configured delegated root to resolve to a readable directory. For mutation tools, availability additionally requires a successful Rust mutator `probe`. The absolute root and mutator binary path are never part of MCP tool arguments or public result projection.

## Proof obligations for privileged providers

Every D5/D6 provider should prove at minimum:

```text
exact capability identity
        ↓
server-side grant decision
        ↓
bounded/scoped input
        ↓
runtime provider availability
        ↓
exact provider routing
        ↓
revocable authority where applicable
        ↓
bounded declared output
```

Mutating or asynchronous providers additionally need the relevant admission, cancellation, fencing and durable-result proofs.

This keeps Task-que-que useful as a capability portability layer without turning MCP into unrestricted shell passthrough.
