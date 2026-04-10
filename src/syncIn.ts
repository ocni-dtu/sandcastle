/**
 * Sync-in: transfer a host git repo into an isolated sandbox via git bundle.
 *
 * Creates a git bundle capturing all refs from the host repo,
 * copies it into the sandbox via the provider's copyIn, and
 * clones from the bundle inside the sandbox.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";

/** Execute a command on the host side, returning stdout. Throws on non-zero exit. */
const execHost = (command: string, cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Host command failed: ${command}\n${stderr?.toString() || error.message}`,
            ),
          );
        } else {
          resolve(stdout.toString());
        }
      },
    );
  });

/** Execute a command in the sandbox, throwing if it fails. */
const execOk = async (
  handle: IsolatedSandboxHandle,
  command: string,
  options?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const result = await handle.exec(command, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
    );
  }
  return result;
};

/**
 * Sync a host git repo into an isolated sandbox.
 *
 * 1. `git bundle create --all` on the host
 * 2. `copyIn` the bundle to the sandbox
 * 3. `git clone` from the bundle inside the sandbox
 * 4. Verify HEAD matches
 *
 * @returns The branch name that was checked out
 */
export const syncIn = async (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
): Promise<{ branch: string }> => {
  // Get current branch from host
  const branch = (
    await execHost("git rev-parse --abbrev-ref HEAD", hostRepoDir)
  ).trim();

  // Create git bundle on host capturing all refs
  const bundleDir = await mkdtemp(join(tmpdir(), "sandcastle-bundle-"));
  const bundleHostPath = join(bundleDir, "repo.bundle");
  try {
    await execHost(
      `git bundle create "${bundleHostPath}" --all`,
      hostRepoDir,
    );

    // Create temp dir in sandbox and copy bundle in
    const mkTempResult = await execOk(handle, "mktemp -d -t sandcastle-XXXXXX");
    const sandboxTmpDir = mkTempResult.stdout.trim();
    const bundleSandboxPath = `${sandboxTmpDir}/repo.bundle`;

    await handle.copyIn(bundleHostPath, bundleSandboxPath);

    // Clone from bundle into the workspace
    const workspacePath = handle.workspacePath;
    await execOk(
      handle,
      `git clone "${bundleSandboxPath}" "${workspacePath}_clone"`,
    );

    // Move contents from clone into workspace (git clone requires empty target)
    await execOk(
      handle,
      `rm -rf "${workspacePath}" && mv "${workspacePath}_clone" "${workspacePath}"`,
    );

    // Checkout the correct branch
    await execOk(handle, `git checkout "${branch}"`, { cwd: workspacePath });

    // Clean up sandbox temp files
    await handle.exec(`rm -rf "${sandboxTmpDir}"`);

    // Verify sync succeeded
    const hostHead = (
      await execHost("git rev-parse HEAD", hostRepoDir)
    ).trim();
    const sandboxHead = (
      await execOk(handle, "git rev-parse HEAD", { cwd: workspacePath })
    ).stdout.trim();

    if (hostHead !== sandboxHead) {
      throw new Error(
        `HEAD mismatch after sync-in: host=${hostHead} sandbox=${sandboxHead}`,
      );
    }

    return { branch };
  } finally {
    // Clean up host-side bundle temp dir
    await rm(bundleDir, { recursive: true, force: true });
  }
};
