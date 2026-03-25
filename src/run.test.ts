import { describe, expect, it } from "vitest";
import {
  buildLogFilename,
  defaultImageName,
  sanitizeBranchForFilename,
  USE_WORKTREE_MODE,
  type RunOptions,
  type RunResult,
} from "./run.js";

describe("RunResult", () => {
  it("includes logFilePath when logging to a file", () => {
    const result: RunResult = {
      iterationsRun: 1,
      wasCompletionSignalDetected: false,
      stdout: "",
      commits: [],
      branch: "main",
      logFilePath: "/path/to/sandcastle.log",
    };
    expect(result.logFilePath).toBe("/path/to/sandcastle.log");
  });

  it("allows logFilePath to be absent when logging to stdout", () => {
    const result: RunResult = {
      iterationsRun: 1,
      wasCompletionSignalDetected: false,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.logFilePath).toBeUndefined();
  });
});

describe("RunOptions", () => {
  it("allows timeoutSeconds to be specified", () => {
    const opts: RunOptions = { prompt: "test", timeoutSeconds: 120 };
    expect(opts.timeoutSeconds).toBe(120);
  });

  it("allows timeoutSeconds to be omitted (uses default)", () => {
    const opts: RunOptions = { prompt: "test" };
    expect(opts.timeoutSeconds).toBeUndefined();
  });

  it("allows name to be specified", () => {
    const opts: RunOptions = { prompt: "test", name: "my-run" };
    expect(opts.name).toBe("my-run");
  });

  it("allows name to be omitted", () => {
    const opts: RunOptions = { prompt: "test" };
    expect(opts.name).toBeUndefined();
  });
});

describe("USE_WORKTREE_MODE", () => {
  it("is a boolean feature flag", () => {
    expect(typeof USE_WORKTREE_MODE).toBe("boolean");
  });
});

describe("sanitizeBranchForFilename", () => {
  it("passes through a simple branch name unchanged", () => {
    expect(sanitizeBranchForFilename("main")).toBe("main");
  });

  it("replaces forward slashes with dashes", () => {
    expect(sanitizeBranchForFilename("sandcastle/issue-87-log-file")).toBe(
      "sandcastle-issue-87-log-file",
    );
  });

  it("replaces backslashes with dashes", () => {
    expect(sanitizeBranchForFilename("feature\\branch")).toBe("feature-branch");
  });

  it("replaces all problematic filesystem characters", () => {
    expect(sanitizeBranchForFilename('feat:name*?"><|')).toBe(
      "feat-name------",
    );
  });

  it("handles nested slashes like a typical sandcastle branch", () => {
    expect(
      sanitizeBranchForFilename("sandcastle/issue-87-log-file-branch-name"),
    ).toBe("sandcastle-issue-87-log-file-branch-name");
  });
});

describe("defaultImageName", () => {
  it("returns sandcastle:<dir-name> for a typical repo path", () => {
    expect(defaultImageName("/home/user/my-project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("lowercases the directory name", () => {
    expect(defaultImageName("/home/user/MyProject")).toBe(
      "sandcastle:myproject",
    );
  });

  it("replaces characters invalid in Docker image tags with dashes", () => {
    expect(defaultImageName("/home/user/my project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("handles paths with trailing slash gracefully", () => {
    expect(defaultImageName("/home/user/my-repo/")).toBe("sandcastle:my-repo");
  });
});

describe("buildLogFilename", () => {
  it("returns sanitized branch + .log when no target branch", () => {
    expect(buildLogFilename("main")).toBe("main.log");
  });

  it("prefixes with target branch when temp branch is used", () => {
    expect(buildLogFilename("sandcastle/20260325-142719", "main")).toBe(
      "main-sandcastle-20260325-142719.log",
    );
  });

  it("sanitizes target branch with slashes", () => {
    expect(
      buildLogFilename("sandcastle/20260325-142719", "feature/my-work"),
    ).toBe("feature-my-work-sandcastle-20260325-142719.log");
  });
});
