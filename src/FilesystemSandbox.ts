import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { CopyError, ExecError } from "./errors.js";
import { Sandbox, type SandboxService } from "./Sandbox.js";

const makeFilesystemSandbox = (
  sandboxDir: string,
): Effect.Effect<SandboxService, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      exec: (command, options) =>
        Effect.async((resume) => {
          execFile(
            "sh",
            ["-c", command],
            { cwd: options?.cwd ?? sandboxDir },
            (error, stdout, stderr) => {
              if (error && error.code === undefined) {
                resume(
                  Effect.fail(
                    new ExecError({
                      command,
                      message: `Failed to exec: ${error.message}`,
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
          const proc = spawn("sh", ["-c", command], {
            cwd: options?.cwd ?? sandboxDir,
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
                  message: `Failed to exec: ${error.message}`,
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
          yield* fs
            .makeDirectory(dirname(sandboxPath), { recursive: true })
            .pipe(
              Effect.mapError(
                (error) =>
                  new CopyError({
                    message: `Failed to copy ${hostPath} -> ${sandboxPath}: ${error}`,
                  }),
              ),
            );
          yield* fs.copyFile(hostPath, sandboxPath).pipe(
            Effect.mapError(
              (error) =>
                new CopyError({
                  message: `Failed to copy ${hostPath} -> ${sandboxPath}: ${error}`,
                }),
            ),
          );
        }),

      copyOut: (sandboxPath, hostPath) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(hostPath), { recursive: true }).pipe(
            Effect.mapError(
              (error) =>
                new CopyError({
                  message: `Failed to copy ${sandboxPath} -> ${hostPath}: ${error}`,
                }),
            ),
          );
          yield* fs.copyFile(sandboxPath, hostPath).pipe(
            Effect.mapError(
              (error) =>
                new CopyError({
                  message: `Failed to copy ${sandboxPath} -> ${hostPath}: ${error}`,
                }),
            ),
          );
        }),
    };
  });

export const FilesystemSandbox = {
  layer: (sandboxDir: string): Layer.Layer<Sandbox> =>
    Layer.effect(Sandbox, makeFilesystemSandbox(sandboxDir)).pipe(
      Layer.provide(NodeFileSystem.layer),
    ),
};
