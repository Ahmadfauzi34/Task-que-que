export interface TaskPolicy {
  queueKind: string;
  maxPayloadBytes: number;
  minPriority: number;
  maxPriority: number;
  maxRetries: number;
}

export type TaskRegistry = Readonly<Record<string, TaskPolicy>>;

export const TASK_REGISTRY: TaskRegistry = Object.freeze({
  "document.process": Object.freeze({
    queueKind: "cpu",
    maxPayloadBytes: 256 * 1024,
    minPriority: -1_000,
    maxPriority: 1_000,
    maxRetries: 10,
  }),
  "hash.compute": Object.freeze({
    queueKind: "cpu",
    maxPayloadBytes: 256 * 1024,
    minPriority: -1_000,
    maxPriority: 1_000,
    maxRetries: 10,
  }),
  "vector.dot": Object.freeze({
    queueKind: "vector",
    maxPayloadBytes: 256 * 1024,
    minPriority: -1_000,
    maxPriority: 1_000,
    maxRetries: 10,
  }),
  "agent.invoke": Object.freeze({
    queueKind: "remote-agent",
    maxPayloadBytes: 256 * 1024,
    minPriority: -1_000,
    maxPriority: 1_000,
    maxRetries: 10,
  }),
});

export function getTaskPolicy(
  registry: TaskRegistry,
  taskType: string,
): TaskPolicy | null {
  return Object.prototype.hasOwnProperty.call(registry, taskType)
    ? registry[taskType] ?? null
    : null;
}
