import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import { Effect, Ref } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  makeSandboxLayerFromHandle,
  resolveGitMounts,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type {
  SandboxProvider,
  BranchStrategy,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { copyToSandbox } from "./CopyToSandbox.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { generateTempBranchName, getCurrentBranch } from "./WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";

export interface InteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-6")) */
  readonly agent: AgentProvider;
  /** Sandbox provider (e.g. docker()). */
  readonly sandbox: SandboxProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Optional name for the interactive session. */
  readonly name?: string;
  /** Branch strategy — controls how the agent's changes relate to branches.
   * Defaults to { type: "head" } for bind-mount providers and { type: "merge-to-head" } for isolated providers. */
  readonly branchStrategy?: BranchStrategy;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: SandboxHooks;
  /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
  readonly copyToSandbox?: string[];
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Record<string, string>;
}

export interface InteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on. */
  readonly branch: string;
  /** Host path to the preserved worktree, if worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
  /** Exit code of the interactive process. */
  readonly exitCode: number;
}

/**
 * Launch an interactive agent session inside a sandbox.
 *
 * The user sees the agent's TUI directly. When the session ends,
 * Sandcastle collects commits and handles branch merging, just like run().
 *
 * Full prompt preprocessing pipeline: PromptResolver -> PromptArgumentSubstitution
 * -> PromptPreprocessor (shell expressions inside sandbox).
 *
 * All three branch strategies are supported: head, merge-to-head, branch.
 */
export const interactive = async (
  options: InteractiveOptions,
): Promise<InteractiveResult> => {
  const { prompt, promptFile, hooks, agent: provider } = options;

  // Derive branch strategy
  const branchStrategy: BranchStrategy =
    options.branchStrategy ??
    (options.sandbox.tag === "isolated"
      ? { type: "merge-to-head" }
      : { type: "head" });

  // Validate: head strategy is not supported with isolated providers
  if (branchStrategy.type === "head" && options.sandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers",
    );
  }

  // Validate: copyToSandbox is incompatible with head strategy
  if (
    branchStrategy.type === "head" &&
    options.copyToSandbox &&
    options.copyToSandbox.length > 0
  ) {
    throw new Error(
      "copyToSandbox is not supported with head branch strategy. " +
        "In head mode the host working directory is bind-mounted directly.",
    );
  }

  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const hostRepoDir = process.cwd();

  // 1. Resolve prompt (from string or file)
  const rawPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );

  // 2. Resolve env vars
  const resolvedEnv = await Effect.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );
  const env = mergeProviderEnv({
    resolvedEnv,
    agentProviderEnv: provider.env,
    sandboxProviderEnv: options.sandbox.env,
  });
  const effectiveEnv = { ...env, ...(options.env ?? {}) };

  // 3. Capture host's current branch
  const currentHostBranch = await Effect.runPromise(
    getCurrentBranch(hostRepoDir),
  );

  const resolvedBranch =
    branchStrategy.type === "head"
      ? currentHostBranch
      : (branch ?? generateTempBranchName(options.name));

  // 4. Validate and substitute prompt args
  const userArgs = options.promptArgs ?? {};
  // SilentDisplay for prompt arg substitution (warnings go nowhere for interactive)
  const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
  const displayLayer = SilentDisplay.layer(displayRef);

  const substitutedPrompt = await Effect.runPromise(
    Effect.gen(function* () {
      yield* validateNoBuiltInArgOverride(userArgs);
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...userArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      return yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );
    }).pipe(Effect.provide(displayLayer)),
  );

  // 5. Validate buildInteractiveArgs is available
  if (!provider.buildInteractiveArgs) {
    throw new Error(
      `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
    );
  }

  // In head mode, pass the host branch so SandboxLifecycle skips the merge step.
  const lifecycleBranch =
    branchStrategy.type === "head" ? currentHostBranch : branch;

  // 6. Create sandbox and run interactive session
  // We manage the lifecycle manually (like SandboxFactory) to access the raw
  // handle for interactiveExec, while delegating git operations to withSandboxLifecycle.
  const isHeadMode = branchStrategy.type === "head";
  const sandboxProvider = options.sandbox;

  let worktreeInfo: WorktreeManager.WorktreeInfo | undefined;
  let handle: BindMountSandboxHandle | IsolatedSandboxHandle | undefined;
  let preservedWorktreePath: string | undefined;
  let exitCode = 1;

  try {
    // Create worktree (unless head mode)
    if (!isHeadMode) {
      worktreeInfo = await Effect.runPromise(
        WorktreeManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.andThen(
            branch
              ? WorktreeManager.create(hostRepoDir, { branch })
              : WorktreeManager.create(hostRepoDir, { name: options.name }),
          ),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      // Copy files to worktree (bind-mount only, non-head)
      if (
        sandboxProvider.tag === "bind-mount" &&
        options.copyToSandbox &&
        options.copyToSandbox.length > 0
      ) {
        await Effect.runPromise(
          copyToSandbox(options.copyToSandbox, hostRepoDir, worktreeInfo.path),
        );
      }
    }

    // Start sandbox
    if (sandboxProvider.tag === "isolated") {
      const startResult = await Effect.runPromise(
        startSandbox({
          provider: sandboxProvider,
          hostRepoDir: worktreeInfo!.path,
          env: effectiveEnv,
          copyPaths: options.copyToSandbox,
        }),
      );
      handle = startResult.handle;
    } else {
      const gitPath = join(hostRepoDir, ".git");
      const gitMounts = await Effect.runPromise(
        resolveGitMounts(gitPath).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      const startResult = await Effect.runPromise(
        startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env: effectiveEnv,
          worktreeOrRepoPath: isHeadMode ? hostRepoDir : worktreeInfo!.path,
          gitMounts,
          workspaceDir: SANDBOX_WORKSPACE_DIR,
        }),
      );
      handle = startResult.handle;
    }

    // Check interactiveExec is available
    if (!handle.interactiveExec) {
      throw new Error(
        `Sandbox provider does not support interactiveExec. ` +
          `The provider must implement the optional interactiveExec method to use interactive().`,
      );
    }
    const interactiveExecFn = handle.interactiveExec.bind(handle);

    // Build sandbox layer and run withSandboxLifecycle
    const sandboxLayer = makeSandboxLayerFromHandle(handle);
    const workspacePath = handle.workspacePath;

    const applyToHost =
      sandboxProvider.tag === "isolated" && worktreeInfo
        ? () => syncOut(worktreeInfo!.path, handle as IsolatedSandboxHandle)
        : () => Effect.void;

    const lifecycleEffect = withSandboxLifecycle(
      {
        hostRepoDir,
        sandboxRepoDir: workspacePath,
        hooks,
        branch: lifecycleBranch,
        hostWorktreePath: isHeadMode ? hostRepoDir : worktreeInfo?.path,
        applyToHost,
      },
      (ctx) =>
        Effect.gen(function* () {
          // Preprocess prompt (expand !`command` shell expressions inside sandbox)
          const fullPrompt = yield* preprocessPrompt(
            substitutedPrompt,
            ctx.sandbox,
            ctx.sandboxRepoDir,
          );

          // Build interactive args and run the session
          const interactiveArgs = provider.buildInteractiveArgs!(fullPrompt);
          const result = yield* Effect.promise(() =>
            interactiveExecFn(interactiveArgs, {
              stdin: process.stdin,
              stdout: process.stdout,
              stderr: process.stderr,
              cwd: workspacePath,
            }),
          );

          return result.exitCode;
        }),
    );

    const lifecycleResult = await Effect.runPromise(
      lifecycleEffect.pipe(
        Effect.provide(sandboxLayer),
        Effect.provide(displayLayer),
      ),
    );

    exitCode = lifecycleResult.result;

    // Check for uncommitted changes (worktree mode only)
    if (worktreeInfo) {
      const hasUncommitted = await Effect.runPromise(
        WorktreeManager.hasUncommittedChanges(worktreeInfo.path).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        ),
      );
      if (hasUncommitted) {
        preservedWorktreePath = worktreeInfo.path;
      }
    }

    return {
      commits: lifecycleResult.commits,
      branch: lifecycleResult.branch,
      preservedWorktreePath,
      exitCode,
    };
  } finally {
    // Clean up: close handle
    if (handle) {
      await handle.close().catch(() => {});
    }

    // Remove worktree if not preserved
    if (worktreeInfo && !preservedWorktreePath) {
      await Effect.runPromise(
        WorktreeManager.remove(worktreeInfo.path).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      );
    }
  }
};
