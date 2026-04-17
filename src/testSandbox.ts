/**
 * Test helper: creates a local (filesystem-based) Sandbox layer for unit tests.
 * This replaces FilesystemSandbox which has been removed.
 */
import { Effect, Layer } from "effect";
import { execFile, spawn, execSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { CopyError, ExecError } from "./errors.js";
import { type ExecResult, Sandbox } from "./SandboxFactory.js";

/**
 * Creates an isolated git global config env so that test sandbox
 * `git config --global` writes don't corrupt the developer's real ~/.gitconfig.
 */
export const createIsolatedGitEnv = (): Record<string, string> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
  const globalConfigPath = join(tmpDir, ".gitconfig");
  writeFileSync(globalConfigPath, "");

  // Pre-set a default identity in the isolated config so that tests can commit
  execSync(`git config --file "${globalConfigPath}" user.name "Test"`);
  execSync(
    `git config --file "${globalConfigPath}" user.email "test@test.com"`,
  );

  return {
    GIT_CONFIG_GLOBAL: globalConfigPath,
    // Some older git versions or environments might still look at HOME for .gitconfig
    HOME: tmpDir,
  };
};

export const makeLocalSandboxLayer = (
  sandboxDir: string,
): Layer.Layer<Sandbox> => {
  const gitEnv = createIsolatedGitEnv();
  const env = { ...process.env, ...gitEnv };

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      if (options?.onLine) {
        const onLine = options.onLine;
        return Effect.async<ExecResult, ExecError>((resume) => {
          const proc = spawn("sh", ["-c", command], {
            cwd: options?.cwd ?? sandboxDir,
            stdio: ["ignore", "pipe", "pipe"],
            env,
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];

          const rl = createInterface({ input: proc.stdout! });
          rl.on("line", (line) => {
            stdoutChunks.push(line);
            onLine(line);
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
        });
      }

      return Effect.async<ExecResult, ExecError>((resume) => {
        execFile(
          "sh",
          ["-c", command],
          {
            cwd: options?.cwd ?? sandboxDir,
            maxBuffer: 10 * 1024 * 1024,
            env,
          },
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
      });
    },

    copyIn: (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${hostPath} -> ${sandboxPath}: ${e}`,
          }),
      }),

    copyFileOut: (sandboxPath, hostPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${sandboxPath} -> ${hostPath}: ${e}`,
          }),
      }),
  });
};
