import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';
import { parseTrailers } from '../util/trailers.js';

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
  commitSha: z.string().describe('SHA of the request commit'),
  fulfilled: z.boolean().describe('Whether the tool was provided (only true if blocking)'),
});

type ToolRequestIn = z.infer<typeof ToolRequestInput>;
type ToolRequestOut = z.infer<typeof ToolRequestOutput>;

export const toolRequestTool: Tool<ToolRequestIn, ToolRequestOut> = {
  definition: {
    name: 'tool-request',
    description:
      'Request a new tool at runtime. Optionally block until fulfilled.',
    inputSchema: ToolRequestInput,
    outputSchema: ToolRequestOutput,
    roles: ['writer', 'reviewer', 'orchestrator'],
    emits: ['tool-requested'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    // Create a commit with Tool-Requested trailer
    const message = `tool-request: ${input.toolName}\n\n${input.reason}`;
    const trailerArgs = [
      '--trailer', `Agent-Id: ${ctx.agentId}`,
      '--trailer', `Session-Id: ${ctx.sessionId}`,
      '--trailer', `Tool-Requested: ${input.toolName}`,
      '--trailer', `Heartbeat: ${new Date().toISOString()}`,
    ];

    const commitResult = await exec(
      'git',
      ['commit', '--allow-empty', '-m', message, ...trailerArgs],
      cwd,
    );
    if (commitResult.exitCode !== 0) {
      return err('commit-failed', commitResult.stderr.trim(), true);
    }

    const shaResult = await exec('git', ['rev-parse', 'HEAD'], cwd);
    if (shaResult.exitCode !== 0) {
      return err('rev-parse-failed', shaResult.stderr.trim(), false);
    }
    const commitSha = shaResult.stdout.trim();

    await ctx.emit({
      type: 'tool-requested',
      branch: ctx.branch,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      payload: { toolName: input.toolName, reason: input.reason },
    });

    if (!input.blocking) {
      return ok({ requested: input.toolName, commitSha, fulfilled: false });
    }

    // Blocking: poll for Tool-Provided trailer
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
          // Check recent commits for Tool-Provided trailer
          const logResult = await exec(
            'git',
            ['log', '-5', '--format=%(trailers)', ctx.branch],
            cwd,
          );

          if (logResult.exitCode === 0) {
            const trailers = parseTrailers(logResult.stdout);
            if (trailers['Tool-Provided'] === input.toolName) {
              resolve(
                ok({ requested: input.toolName, commitSha, fulfilled: true }),
              );
              return;
            }
          }

          poll();
        }, pollInterval);
      };

      poll();
    });
  },
};
