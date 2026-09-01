// Keep the existing reference-worker CI job authoritative for all Bun worker contracts.
// The vector worker is a separate process/capability but intentionally reuses the same lifecycle runtime.
import "../../vector-bun/tests/vector-handler.test";
