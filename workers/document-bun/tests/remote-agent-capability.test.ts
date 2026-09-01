// Keep the existing reference-worker CI job authoritative for all Bun worker contracts.
// The remote agent worker is a separate capability but intentionally reuses the same lifecycle runtime.
import "../../remote-agent-bun/tests/remote-handler.test";
