export interface RegistryTask {
  task_id: number;
  task_name: string;
  task_type: string;
  payload: string;
}

export interface WorkerHandlerContext {
  outputDir: string;
}

export type WorkerFailureCode = "invalid_payload" | "processing_failed";

export interface WorkerHandler {
  readonly taskName: string;
  readonly taskType: string;
  handle(task: RegistryTask, context: WorkerHandlerContext): Promise<unknown>;
  classifyError?(error: unknown): WorkerFailureCode;
}

const SAFE_NAME = /^[A-Za-z0-9._:-]{1,128}$/;

function validateName(value: string, label: string): void {
  if (!SAFE_NAME.test(value)) {
    throw new Error(`${label} must be a safe 1-128 character identifier`);
  }
}

export class WorkerHandlerRegistry {
  readonly workerType: string;
  readonly #handlers = new Map<string, WorkerHandler>();

  constructor(workerType: string, handlers: readonly WorkerHandler[]) {
    validateName(workerType, "worker type");
    this.workerType = workerType;

    if (handlers.length === 0) {
      throw new Error("worker registry must contain at least one handler");
    }

    for (const handler of handlers) {
      validateName(handler.taskName, "handler task name");
      validateName(handler.taskType, "handler task type");
      if (handler.taskType !== workerType) {
        throw new Error(
          `handler ${handler.taskName} declares ${handler.taskType}, expected hard capability ${workerType}`,
        );
      }
      if (this.#handlers.has(handler.taskName)) {
        throw new Error(`duplicate worker handler: ${handler.taskName}`);
      }
      this.#handlers.set(handler.taskName, handler);
    }
  }

  get size(): number {
    return this.#handlers.size;
  }

  get taskNames(): readonly string[] {
    return [...this.#handlers.keys()].sort();
  }

  resolve(taskName: string, taskType: string): WorkerHandler | undefined {
    if (taskType !== this.workerType) {
      return undefined;
    }
    return this.#handlers.get(taskName);
  }
}
