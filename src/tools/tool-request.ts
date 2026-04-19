import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailersMulti } from '../util/trailers.js';

const TOOL_REQUESTS_REF = 'refs/heads/tool-requests';

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
});

type ToolRequestIn = z.infer<typeof ToolRequestInput>;
type ToolRequestOut = z.infer<typeof ToolRequestOutput>;

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

    // Pull any remote-only history for the ref so the local parent is
    // up-to-date. Silently ignore failure (offline, no remote ref) —
    // update-ref will still catch a divergent local-tip below.
    await exec(
      'git',
      [
        'fetch',
        'origin',
        `${TOOL_REQUESTS_REF}:${TOOL_REQUESTS_REF}`,
      ],
      cwd,
    );

    // Resolve parent. Missing ref → orphan commit (no -p).
    const parentResult = await exec(
      'git',
      ['rev-parse', '--verify', '--quiet', TOOL_REQUESTS_REF],
      cwd,
    );
    const parent: string | null =
      parentResult.exitCode === 0 ? parentResult.stdout.trim() : null;

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

    // Build commit message: subject + body + trailer block. Trailers
    // stay byte-identical to the previous porcelain form.
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
    const updateArgs = ['update-ref', TOOL_REQUESTS_REF, commitSha];
    if (parent !== null) {
      updateArgs.push(parent);
    } else {
      // Creating the ref: expected-old must be the null sha to refuse
      // a racing orphan creation.
      updateArgs.push('0000000000000000000000000000000000000000');
    }
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

    // Push to origin. On failure, keep the local ref and surface the
    // error as an event — the tool stays useful offline.
    const pushResult = await exec(
      'git',
      [
        'push',
        'origin',
        `${TOOL_REQUESTS_REF}:${TOOL_REQUESTS_REF}`,
      ],
      cwd,
    );
    if (pushResult.exitCode !== 0) {
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
      return ok({ requested: input.toolName, commitSha, fulfilled: false });
    }

    const pollInterval = input.pollIntervalMs ?? 5000;
    const timeout = input.timeoutMs ?? 120000;

    return new Promise((resolve) => {
      const startTime = Date.now();

      const poll = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          resolve(
            ok({ requested: input.toolName, commitSha, fulfilled: false }),
          );
          return;
        }

        setTimeout(async () => {
          // Pull any new fulfillment commits published by the provider.
          await exec(
            'git',
            [
              'fetch',
              'origin',
              `${TOOL_REQUESTS_REF}:${TOOL_REQUESTS_REF}`,
            ],
            cwd,
          );

          // Scan recent commits on the dedicated ref for a fulfillment
          // commit carrying both Tool-Provided: <name> and
          // Tool-Request-Sha: <our commitSha>. %(trailers:only) drops
          // the blank separator lines that otherwise pollute parsing
          // when %B-style output is requested.
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
