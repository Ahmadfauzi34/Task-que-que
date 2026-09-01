import { describe, expect, test } from "bun:test";

import { TASK_REGISTRY, getTaskPolicy } from "../src/registry";

describe("public task registry", () => {
  test("maps document and hash handlers to the hard cpu capability", () => {
    expect(getTaskPolicy(TASK_REGISTRY, "document.process")).toMatchObject({
      queueKind: "cpu",
      maxPayloadBytes: 256 * 1024,
    });
    expect(getTaskPolicy(TASK_REGISTRY, "hash.compute")).toMatchObject({
      queueKind: "cpu",
      maxPayloadBytes: 256 * 1024,
    });
  });

  test("maps vector dot to an independent custom capability", () => {
    expect(getTaskPolicy(TASK_REGISTRY, "vector.dot")).toMatchObject({
      queueKind: "vector",
      maxPayloadBytes: 256 * 1024,
    });
  });

  test("keeps prototype-looking and unknown names outside the public allowlist", () => {
    expect(getTaskPolicy(TASK_REGISTRY, "constructor")).toBeNull();
    expect(getTaskPolicy(TASK_REGISTRY, "toString")).toBeNull();
    expect(getTaskPolicy(TASK_REGISTRY, "hash.shell")).toBeNull();
    expect(getTaskPolicy(TASK_REGISTRY, "vector.exec")).toBeNull();
  });
});
