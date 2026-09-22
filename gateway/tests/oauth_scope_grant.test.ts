import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  CAPABILITY_AUTHORITY,
  CAPABILITY_DEPTH,
} from "../src/capabilities";
import {
  deriveOAuthCapabilityGrant,
} from "../src/oauth-scope-grant";

describe(
  "OAuth scope to capability grant derivation",
  () => {
    test(
      "derives the minimum D/A required by exact static scopes",
      () => {
        expect(
          deriveOAuthCapabilityGrant([
            "capability.read",
          ]),
        ).toEqual({
          ok: true,
          grant: {
            depth:
              CAPABILITY_DEPTH.DISCOVER,
            authority:
              CAPABILITY_AUTHORITY.OBSERVE,
            scopes: [
              "capability.read",
            ],
          },
        });

        expect(
          deriveOAuthCapabilityGrant([
            "task.invoke",
            "task:document.process",
          ]),
        ).toEqual({
          ok: true,
          grant: {
            depth:
              CAPABILITY_DEPTH.EXECUTE,
            authority:
              CAPABILITY_AUTHORITY.INVOKE,
            scopes: [
              "task.invoke",
              "task:document.process",
            ],
          },
        });

        expect(
          deriveOAuthCapabilityGrant([
            "capability.read",
            "filesystem.write",
          ]),
        ).toEqual({
          ok: true,
          grant: {
            depth:
              CAPABILITY_DEPTH.DELEGATED_SYSTEM,
            authority:
              CAPABILITY_AUTHORITY.MUTATE_SCOPED,
            scopes: [
              "capability.read",
              "filesystem.write",
            ],
          },
        });
      },
    );

    test(
      "rejects empty, wildcard, duplicate, and unmapped OAuth scopes",
      () => {
        expect(
          deriveOAuthCapabilityGrant([]),
        ).toEqual({
          ok: false,
          error: "empty_scope",
        });

        expect(
          deriveOAuthCapabilityGrant([
            "*",
          ]),
        ).toEqual({
          ok: false,
          error: "wildcard_scope",
          scope: "*",
        });

        expect(
          deriveOAuthCapabilityGrant([
            "task.*",
          ]),
        ).toEqual({
          ok: false,
          error: "wildcard_scope",
          scope: "task.*",
        });

        expect(
          deriveOAuthCapabilityGrant([
            "capability.read",
            "capability.read",
          ]),
        ).toEqual({
          ok: false,
          error: "unmapped_scope",
          scope: "capability.read",
        });

        expect(
          deriveOAuthCapabilityGrant([
            "process.command.future",
          ]),
        ).toEqual({
          ok: false,
          error: "unmapped_scope",
          scope:
            "process.command.future",
        });
      },
    );
  },
);
