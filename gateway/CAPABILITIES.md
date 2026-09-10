# Capability depth and authority contract

This document defines the pre-MCP capability model for the Task-que-que reference machine.

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

A capability is usable only when all three dimensions pass:

```text
grant.depth     >= capability.minDepth
grant.authority >= capability.minAuthority
required scopes are covered by grant scopes
```

The capability registry is own-property checked. Prototype-looking names must never become capabilities by inheritance.

## Current inventory

The canonical runtime inventory is `gateway/src/capabilities.ts`.

It currently describes only capabilities supported by the existing reference machine, including:

- gateway health and readiness
- public task submit/inspect surfaces
- public workflow submit/inspect/result/cancel surfaces
- registered `document.process`
- registered `hash.compute`
- registered `vector.dot`
- registered `agent.invoke`
- registered `workflow.run`

`agent.invoke` is described as a D5 delegated-system capability because it crosses into a remote-agent provider. Runtime availability is a separate fact: if the remote-agent worker is disabled, registration does not imply that an executor is currently online.

The inventory deliberately does **not** claim that filesystem, package installation, arbitrary process execution, Git mutation, or general outbound networking already exist. Those become new providers only after their own implementation and proof gates.

## Compatibility state

The existing public gateway behavior is preserved by `LEGACY_COMPAT_GRANT`:

```text
D6 / A4 / scope=*
```

That is a compatibility reference, not the intended final MCP session policy. Existing task/workflow routes continue to be governed by their current authentication, registry/admission, exact routing, lease fencing, cancellation and declared-result invariants.

The next MCP/session layer should derive a `CapabilityGrant` from trusted server-side authentication/policy. A client must never be able to self-assert a deeper grant by sending a header or request field.

## MCP projection target

The MCP adapter should consume the capability registry rather than maintain a second hardcoded tool list:

```text
reference machine providers
          ↓
canonical capability registry
          ↓
depth + authority + scopes
          ↓
agent-facing projection
          ↓
MCP adapter
```

A low-depth agent may still discover that a deeper capability exists, but the projection marks it inaccessible and explains whether the blocker is depth, authority, or scope. This lets the agent reason about what the reference machine can do without silently converting discovery into execution authority.

## Proof obligations before privileged providers

Before D5/D6 gains filesystem, package, process, network, Git or machine-control providers, each provider should prove at minimum:

```text
exact capability identity
        ↓
server-side grant decision
        ↓
bounded/scoped input
        ↓
admission
        ↓
exact worker/provider routing
        ↓
lease/session authority
        ↓
cancellable execution where applicable
        ↓
fenced completion
        ↓
declared output
```

This keeps Task-que-que useful as a capability portability layer without turning MCP into unrestricted shell passthrough.
