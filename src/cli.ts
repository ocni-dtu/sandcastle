import { Command } from "@effect/cli";
import { Console, Effect } from "effect";

export const sandcastle = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    yield* Console.log("🏰 Sandcastle v0.0.1");
  }),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: "0.0.1",
});
