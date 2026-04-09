import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from '../../src/util/exec.js';

/**
 * Run git with a message piped on stdin. Used for `git commit -F -`
 * so we can produce multi-line messages with trailers without
 * touching the filesystem.
 */
function gitWithStdin(
  cwd: string,
  args: string[],
  input: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `git ${args.join(' ')} failed: ${stderr.trim() || error.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
    if (!child.stdin) {
      reject(new Error('git child process has no stdin'));
      return;
    }
    child.stdin.end(input);
  });
}

/**
 * Options for creating a commit in a fixture repo.
 */
export interface CommitOpts {
  /** Commit subject line (first line of the message). */
  subject: string;
  /** Optional body paragraph between subject and trailers. */
  body?: string;
  /**
   * Trailers to append. Values may be strings (single) or string[]
   * (repeated — one trailer line per element, order preserved).
   */
  trailers?: Record<string, string | string[]>;
  /** Map of relPath -> file contents. Written and staged before commit. */
  files?: Record<string, string>;
  /** Permit an empty commit (no files, no changes). */
  allowEmpty?: boolean;
}

/**
 * Handle to an isolated git fixture repo.
 *
 * All methods use real git subprocess calls. Every instance lives in
 * its own mkdtemp directory, so parallel vitest workers are safe.
 */
export interface FixtureRepo {
  /** Absolute path to the repo working tree. */
  readonly path: string;
  /** Create a commit; returns the full SHA. */
  commit(opts: CommitOpts): Promise<string>;
  /** Create a branch at `from` (default HEAD). Does not check out. */
  branch(name: string, from?: string): Promise<void>;
  /** Check out a ref (branch or commit). */
  checkout(ref: string): Promise<void>;
  /** Remove the fixture directory. Idempotent. */
  cleanup(): Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await exec('git', args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
}

function buildMessage(opts: CommitOpts): string {
  const parts: string[] = [opts.subject];
  if (opts.body && opts.body.length > 0) {
    parts.push('', opts.body);
  }
  const trailerLines: string[] = [];
  if (opts.trailers) {
    for (const [key, value] of Object.entries(opts.trailers)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          trailerLines.push(`${key}: ${v}`);
        }
      } else {
        trailerLines.push(`${key}: ${value}`);
      }
    }
  }
  if (trailerLines.length > 0) {
    parts.push('', trailerLines.join('\n'));
  }
  return parts.join('\n') + '\n';
}

/**
 * Create a new isolated git fixture repo.
 *
 * Initializes the repo, configures a test identity, and writes one
 * empty init commit so HEAD is resolvable from the start.
 */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fixture-'));

  await git(repoPath, ['init', '-q', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'test.bot@loom.local']);
  await git(repoPath, ['config', 'user.name', 'Loom Test Bot']);
  await git(repoPath, ['config', 'commit.gpgsign', 'false']);
  await git(repoPath, ['config', 'tag.gpgsign', 'false']);
  await git(repoPath, ['config', 'init.defaultBranch', 'main']);

  const repo: FixtureRepo = {
    path: repoPath,

    async commit(opts: CommitOpts): Promise<string> {
      // Stage any files provided.
      if (opts.files) {
        for (const [relPath, content] of Object.entries(opts.files)) {
          const abs = path.join(repoPath, relPath);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content);
          await git(repoPath, ['add', '--', relPath]);
        }
      }

      const message = buildMessage(opts);
      const hasFiles = opts.files && Object.keys(opts.files).length > 0;
      const commitArgs = ['commit', '-q', '-F', '-'];
      if (opts.allowEmpty || !hasFiles) {
        commitArgs.push('--allow-empty');
      }

      // Pipe the message on stdin. src/util/exec.ts does not support
      // stdin, so use execFile directly here — documented in the plan.
      await gitWithStdin(repoPath, commitArgs, message);

      const revResult = await exec('git', ['rev-parse', 'HEAD'], repoPath);
      if (revResult.exitCode !== 0) {
        throw new Error(`git rev-parse HEAD failed: ${revResult.stderr.trim()}`);
      }
      return revResult.stdout.trim();
    },

    async branch(name: string, from?: string): Promise<void> {
      const args = ['branch', name];
      if (from) args.push(from);
      await git(repoPath, args);
    },

    async checkout(ref: string): Promise<void> {
      await git(repoPath, ['checkout', '-q', ref]);
    },

    async cleanup(): Promise<void> {
      await fs.rm(repoPath, { recursive: true, force: true });
    },
  };

  // Initial empty commit so HEAD exists for later branch/checkout calls.
  await repo.commit({ subject: 'init', allowEmpty: true });

  return repo;
}

/**
 * Options for the `assigned` convenience helper.
 *
 * Produces a CommitOpts shaped like a standard ASSIGNED commit — the
 * shape protocol-enforcement tests reach for most often.
 */
export interface AssignedOpts {
  /** Agent-Id trailer. */
  agent: string;
  /** Short task slug, used as Assignment trailer and commit subject suffix. */
  slug: string;
  /** Scope trailer value (literal string — e.g., `src/tools/**`). */
  scope: string;
  /** Dependencies trailer. Defaults to `none`. */
  deps?: string;
  /** Budget trailer (ms). Defaults to 60000. */
  budget?: number;
  /** Session-Id trailer. Defaults to a fixed test uuid. */
  sessionId?: string;
  /** Assigned-To trailer. Defaults to `agent`. */
  assignedTo?: string;
}

const DEFAULT_TEST_SESSION = '00000000-0000-0000-0000-000000000001';

/**
 * Build a CommitOpts for a standard ASSIGNED commit.
 */
export function assigned(opts: AssignedOpts): CommitOpts {
  return {
    subject: `task(loom): ${opts.slug}`,
    trailers: {
      'Agent-Id': opts.agent,
      'Assigned-To': opts.assignedTo ?? opts.agent,
      'Assignment': opts.slug,
      'Scope': opts.scope,
      'Dependencies': opts.deps ?? 'none',
      'Budget': String(opts.budget ?? 60000),
      'Session-Id': opts.sessionId ?? DEFAULT_TEST_SESSION,
      'Task-Status': 'ASSIGNED',
    },
  };
}
