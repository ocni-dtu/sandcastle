import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { CopyError, ExecError } from "./errors.js";
import { Sandbox, type SandboxService } from "./Sandbox.js";

const makeDockerSandbox = (
  containerName: string,
): Effect.Effect<SandboxService, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      exec: (command, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          execFile(
            "docker",
            args,
            { maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error && error.code === undefined) {
                resume(
                  Effect.fail(
                    new ExecError({
                      command,
                      message: `docker exec failed: ${error.message}`,
                    }),
                  ),
                );
              } else {
                resume(
                  Effect.succeed({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode:
                      typeof error?.code === "number"
                        ? error.code
                        : (0 as number),
                  }),
                );
              }
            },
          );
        }),

      execStreaming: (command, onStdoutLine, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          const proc = spawn("docker", args, {
            stdio: ["ignore", "pipe", "pipe"],
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];

          const rl = createInterface({ input: proc.stdout! });
          rl.on("line", (line) => {
            stdoutChunks.push(line);
            onStdoutLine(line);
          });

          proc.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          proc.on("error", (error) => {
            resume(
              Effect.fail(
                new ExecError({
                  command,
                  message: `docker exec streaming failed: ${error.message}`,
                }),
              ),
            );
          });

          proc.on("close", (code) => {
            resume(
              Effect.succeed({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              }),
            );
          });
        }),

      copyIn: (hostPath, sandboxPath) =>
        Effect.gen(function* () {
          // Ensure parent directory exists in container
          const parentDir = dirname(sandboxPath);
          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["exec", containerName, "mkdir", "-p", parentDir],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to create dir ${parentDir}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });

          // docker cp hostPath containerName:sandboxPath
          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${hostPath} -> ${containerName}:${sandboxPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),

      copyOut: (sandboxPath, hostPath) =>
        Effect.gen(function* () {
          // Ensure parent directory exists on host
          yield* fs.makeDirectory(dirname(hostPath), { recursive: true }).pipe(
            Effect.mapError(
              (error) =>
                new CopyError({
                  message: `Failed to create host dir ${dirname(hostPath)}: ${error}`,
                }),
            ),
          );

          // docker cp containerName:sandboxPath hostPath
          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${containerName}:${sandboxPath} -> ${hostPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),
    };
  });

export const DockerSandbox = {
  layer: (containerName: string): Layer.Layer<Sandbox> =>
    Layer.effect(Sandbox, makeDockerSandbox(containerName)).pipe(
      Layer.provide(NodeFileSystem.layer),
    ),
};
