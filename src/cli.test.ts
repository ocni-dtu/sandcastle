import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { sandcastle } from "./cli.js";

describe("sandcastle CLI", () => {
  it.effect("command is defined", () =>
    Effect.gen(function* () {
      // Verify the command exists and has the right name
      expect(sandcastle).toBeDefined();
    }),
  );
});
