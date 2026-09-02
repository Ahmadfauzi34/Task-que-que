import { describe, expect, test } from "bun:test";

import {
  WorkerHandlerRegistry,
  type WorkerHandler,
  type WorkerHandlerContext,
} from "../src/registry";

function handler(taskName: string, taskType = "cpu"): WorkerHandler {
  return {
    taskName,
    taskType,
    async handle(_task, _context: WorkerHandlerContext) {},
  };
}

describe("worker handler registry", () => {
  test("resolves and advertises exact task names inside one hard capability", () => {
    const first = handler("document.process");
    const second = handler("document.preview");
    const registry = new WorkerHandlerRegistry("cpu", [first, second]);

    expect(registry.size).toBe(2);
    expect(registry.taskNames).toEqual(["document.preview", "document.process"]);
    expect(registry.resolve("document.process", "cpu")).toBe(first);
    expect(registry.resolve("document.preview", "cpu")).toBe(second);
    expect(registry.resolve("document.missing", "cpu")).toBeUndefined();
  });

  test("does not treat prototype-looking task names as implicit handlers", () => {
    const registry = new WorkerHandlerRegistry("cpu", [handler("document.process")]);

    expect(registry.resolve("constructor", "cpu")).toBeUndefined();
    expect(registry.resolve("toString", "cpu")).toBeUndefined();
  });

  test("rejects duplicate task handlers", () => {
    expect(
      () =>
        new WorkerHandlerRegistry("cpu", [
          handler("document.process"),
          handler("document.process"),
        ]),
    ).toThrow("duplicate worker handler");
  });

  test("rejects handlers outside the registered Rust capability", () => {
    expect(() => new WorkerHandlerRegistry("cpu", [handler("model.infer", "gpu")])).toThrow(
      "expected hard capability cpu",
    );
  });

  test("requires an explicit non-empty handler set", () => {
    expect(() => new WorkerHandlerRegistry("cpu", [])).toThrow(
      "worker registry must contain at least one handler",
    );
  });
});
