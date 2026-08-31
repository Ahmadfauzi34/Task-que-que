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
});

export function getTaskPolicy(
  registry: TaskRegistry,
  taskType: string,
): TaskPolicy | null {
  return Object.prototype.hasOwnProperty.call(registry, taskType)
    ? registry[taskType] ?? null
    : null;
}
