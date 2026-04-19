import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailersMulti } from '../util/trailers.js';

const TOOL_REQUESTS_REF = 'refs/heads/tool-requests';
const TOOL_REQUESTS_BRANCH = 'tool-requests';
const NULL_SHA = '0000000000000000000000000000000000000000';

const ToolRequestInput = z.object({
  toolName: z.string().describe('Name of the tool being requested'),
  reason: z.string().describe('Why the tool is needed'),
  blocking: z
    .boolean()
    .optional()
    .describe('If true, poll until the tool is provided (default: false)'),
  pollIntervalMs: z
    .number()
    .optional()
    .describe('Polling interval when blocking (default: 5000)'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Timeout when blocking (default: 120000 / 2 min)'),
});

const ToolRequestOutput = z.object({
  requested: z.string().describe('Tool name that was requested'),
  commitSha: z.string().describe('SHA of the request commit on refs/heads/tool-requests'),
  fulfilled: z.boolean().describe('Whether the tool was provided (only true if blocking)'),
  pushed: z
    .boolean()
    .describe('Whether the commit reached origin. False iff push failed; callers that need visibility to providers should retry.'),
});

type ToolRequestIn = z.infer<typeof ToolRequestInput>;
type ToolRequestOut = z.infer<typeof ToolRequestOutput>;

/**
 * Sync the local tool-requests ref with origin before we parent a new
 * commit on it. Returns the parent sha (or null for orphan path).
 *
 * Cases, explicitly distinguished:
 *   1. origin lacks the ref, no local tip — orphan path.
 *   2. origin lacks the ref, local tip exists — offline-accumulated
 *      commits; parent onto local tip and push later.
 *   3. origin has it, no local tip — fetch to populate local.
 *   4. origin has it, local equals origin — nothing to do.
 *   5. origin has it, local is a descendant of origin — local is
 *      strictly ahead (stranded commits from a prior push failure);
 *      parent onto local tip. Push will carry the range.
 *   6. origin has it, origin is a descendant of local — fetch to
 *      fast-forward local, then parent onto new tip.
 *   7. origin has it, local and origin have diverged — error out;
 *      caller must reconcile manually.
 *   8. ls-remote itself fails (network / auth) — if a local tip
 *      exists, serve offline; otherwise origin-unreachable.
 */
async function syncWithOrigin(
  cwd: string,
): Promise<{ parent: string | null; error: ReturnType<typeof err> | null }> {
  const remoteRef = await exec(
    'git',
    ['ls-remote', '--exit-code', 'origin', TOOL_REQUESTS_REF],
    cwd,
  );
  const localTip = await readLocalTip(cwd);

  if (remoteRef.exitCode === 2) {
    // ls-remote contract: exit 2 = ref not matched on origin.
    return { parent: localTip, error: null };
  }

  if (remoteRef.exitCode !== 0) {
    if (localTip !== null) {
      return { parent: localTip, error: null };
    }
    return {
      parent: null,
      error: err(
        'origin-unreachable',
        `ls-remote origin ${TOOL_REQUESTS_REF} failed: ${remoteRef.stderr.trim()}`,
        true,
      ),
    };
  }

  const originTip = remoteRef.stdout.split(/\s/)[0];
  if (!originTip || !/^[0-9a-f]{40}$/.test(originTip)) {
    return {
      parent: null,
      error: err(
        'ls-remote-malformed',
        `ls-remote returned no sha: ${JSON.stringify(remoteRef.stdout)}`,
        true,
      ),
    };
  }

  if (localTip === null) {
    // No local tip, origin has one: fetch to populate.
    const fetchResult = await exec(
      'git',
      ['fetch', 'origin', `${TOOL_REQUESTS_REF}:${TOOL_REQUESTS_REF}`],
      cwd,
    );
    if (fetchResult.exitCode !== 0) {
      return {
        parent: null,
        error: err(
          'fetch-failed',
          `fetch of ${TOOL_REQUESTS_REF} failed: ${fetchResult.stderr.trim()}`,
          true,
        ),
      };
    }
    return { parent: await readLocalTip(cwd), error: null };
  }

  if (localTip === originTip) {
    return { parent: localTip, error: null };
  }

  // Local ≠ origin. Determine the relation.
  // "Is originTip an ancestor of localTip" — yes means local is strictly
  // ahead (stranded commits), push will fast-forward origin.
  const localAhead = await exec(
    'git',
    ['merge-base', '--is-ancestor', originTip, localTip],
    cwd,
  );
  if (localAhead.exitCode === 0) {
    return { parent: localTip, error: null };
  }

  // "Is localTip an ancestor of originTip" — yes means origin is
  // strictly ahead; fetch will fast-forward local.
  const originAhead = await exec(
    'git',
    ['merge-base', '--is-ancestor', localTip, originTip],
    cwd,
  );
  if (originAhead.exitCode === 0) {
    const fetchResult = await exec(
      'git',
      ['fetch', 'origin', `${TOOL_REQUESTS_REF}:${TOOL_REQUESTS_REF}`],
      cwd,
    );
    if (fetchResult.exitCode !== 0) {
      return {
        parent: null,
        error: err(
          'fetch-failed',
          `fetch of ${TOOL_REQUESTS_REF} failed: ${fetchResult.stderr.trim()}`,
          true,
        ),
      };
    }
    return { parent: await readLocalTip(cwd), error: null };
  }

  // Neither is ancestor of the other: true divergence.
  return {
    parent: null,
    error: err(
      'tool-requests-diverged',
      `local ${TOOL_REQUESTS_REF} (${localTip}) has diverged from origin (${originTip}). Resolve manually (e.g. git fetch --force origin ${TOOL_REQUESTS_REF}:${TOOL_REQUESTS_REF} after confirming origin is authoritative) before retrying.`,
      true,
    ),
  };
}

async function readLocalTip(cwd: string): Promise<string | null> {
  const r = await exec(
    'git',
    ['rev-parse', '--verify', '--quiet', TOOL_REQUESTS_REF],
    cwd,
  );
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export const toolRequestTool: Tool<ToolRequestIn, ToolRequestOut> = {
  definition: {
    name: 'tool-request',
    description:
      'Request a new tool at runtime. Writes a commit on refs/heads/tool-requests (orphan branch) without touching the caller HEAD/index/worktree, then pushes to origin. Optionally blocks until a fulfilling commit lands on the same ref carrying a matching Tool-Request-Sha trailer.',
    inputSchema: ToolRequestInput,
    outputSchema: ToolRequestOutput,
    roles: ['writer', 'reviewer', 'orchestrator'],
    emits: ['tool-requested', 'tool-request-push-failed'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    // Refuse when the caller is checked out to tool-requests: update-ref
    // would silently advance their HEAD to a commit with an empty tree,
    // making every tracked file look deleted against the new HEAD.
    // This is a configuration mistake, not a supported case.
    if (
      ctx.branch === TOOL_REQUESTS_BRANCH ||
      ctx.branch === TOOL_REQUESTS_REF
    ) {
      return err(
        'caller-on-tool-requests',
        `Caller worktree is checked out to ${TOOL_REQUESTS_BRANCH}; update-ref would clobber its HEAD. Check out a different branch before calling tool-request.`,
        false,
      );
    }

    const synced = await syncWithOrigin(cwd);
    if (synced.error !== null) {
      return synced.error;
    }
    const parent = synced.parent;

    // Empty tree so nothing from the caller's worktree or index leaks in.
    const treeResult = await exec(
      'git',
      ['hash-object', '-t', 'tree', '/dev/null', '-w'],
      cwd,
    );
    if (treeResult.exitCode !== 0) {
      return err(
        'hash-object-failed',
        treeResult.stderr.trim() || 'git hash-object failed',
        true,
      );
    }
    const tree = treeResult.stdout.trim();

    const heartbeat = new Date().toISOString();
    const message =
      `tool-request: ${input.toolName}\n\n${input.reason}\n\n` +
      `Agent-Id: ${ctx.agentId}\n` +
      `Session-Id: ${ctx.sessionId}\n` +
      `Tool-Requested: ${input.toolName}\n` +
      `Heartbeat: ${heartbeat}\n`;

    const commitTreeArgs = ['commit-tree', tree, '-m', message];
    if (parent !== null) {
      commitTreeArgs.push('-p', parent);
    }
    const commitResult = await exec('git', commitTreeArgs, cwd);
    if (commitResult.exitCode !== 0) {
      return err(
        'commit-tree-failed',
        commitResult.stderr.trim() || 'git commit-tree failed',
        true,
      );
    }
    const commitSha = commitResult.stdout.trim();

    // Update ref atomically. Expected-old catches a racing writer.
    const updateArgs = [
      'update-ref',
      TOOL_REQUESTS_REF,
      commitSha,
      parent ?? NULL_SHA,
    ];
    const updateResult = await exec('git', updateArgs, cwd);
    if (updateResult.exitCode !== 0) {
      return err(
        'update-ref-failed',
        updateResult.stderr.trim() || 'git update-ref failed',
        true,
      );
    }

    await ctx.emit({
      type: 'tool-requested',
      branch: ctx.branch,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      timestamp: heartbeat,
      payload: { toolName: input.toolName, reason: input.reason, commitSha },
    });

    // Push to origin. On failure, keep the local ref advanced and surface
    // the error as an event + pushed=false. A subsequent successful call
    // will carry its own commits plus the stranded one (push sends the
    // whole range local-tip → origin-tip).
    const pushResult = await exec(
      'git',
      ['push', 'origin', `${TOOL_REQUESTS_REF}:${TOOL_REQUESTS_REF}`],
      cwd,
    );
    const pushed = pushResult.exitCode === 0;
    if (!pushed) {
      await ctx.emit({
        type: 'tool-request-push-failed',
        branch: ctx.branch,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          toolName: input.toolName,
          commitSha,
          stderr: pushResult.stderr.trim(),
        },
      });
    }

    if (!input.blocking) {
      return ok({
        requested: input.toolName,
        commitSha,
        fulfilled: false,
        pushed,
      });
    }

    const pollInterval = input.pollIntervalMs ?? 5000;
    const timeout = input.timeoutMs ?? 120000;

    return new Promise((resolve) => {
      const startTime = Date.now();

      const poll = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          resolve(
            ok({
              requested: input.toolName,
              commitSha,
              fulfilled: false,
              pushed,
            }),
          );
          return;
        }

        setTimeout(async () => {
          // Pull any new fulfillment commits. Same sync logic as the
          // initial call — if origin has diverged we stop polling
          // rather than wait forever on a fork.
          const syncResult = await syncWithOrigin(cwd);
          if (syncResult.error !== null) {
            resolve(syncResult.error);
            return;
          }

          // Scan recent commits on the dedicated ref for a fulfillment
          // commit carrying both Tool-Provided: <name> and
          // Tool-Request-Sha: <our commitSha>.
          const logResult = await exec(
            'git',
            [
              'log',
              '-20',
              '--format=%H%x00%(trailers:only,unfold)%x1e',
              TOOL_REQUESTS_REF,
            ],
            cwd,
          );

          if (logResult.exitCode === 0) {
            for (const record of logResult.stdout.split('\x1e')) {
              const [, rawTrailers] = record.split('\x00');
              if (!rawTrailers) continue;
              const trailers = parseTrailersMulti(rawTrailers);
              const provided = trailers['Tool-Provided'] ?? [];
              const requestShas = trailers['Tool-Request-Sha'] ?? [];
              if (
                provided.includes(input.toolName) &&
                requestShas.includes(commitSha)
              ) {
                resolve(
                  ok({
                    requested: input.toolName,
                    commitSha,
                    fulfilled: true,
                    pushed,
                  }),
                );
                return;
              }
            }
          }

          poll();
        }, pollInterval);
      };

      poll();
    });
  },
};
