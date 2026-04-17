import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const PipelinePublishInput = z.object({
  issueSha: z.string().describe('SHA of the issue commit to annotate with a pipeline note'),
  retro: z.object({
    title: z.string().describe('Retro commit subject line'),
    body: z.string().describe('Retro commit body'),
    agentId: z.string().describe('Agent-Id trailer value'),
    sessionId: z.string().describe('Session-Id trailer value'),
  }).describe('Retro commit content and trailers'),
  note: z
    .record(z.string(), z.string())
    .describe('YAML key-value pairs for the pipeline note'),
  remote: z
    .string()
    .optional()
    .describe('Git remote name (default: origin)'),
});

const PipelinePublishOutput = z.object({
  retroSha: z.string().describe('SHA of the retro commit'),
  noteSha: z.string().describe('SHA of the pipeline notes ref tip (refs/notes/pipeline)'),
  verified: z.boolean().describe('Whether both refs were verified on the remote'),
});

type PipelinePublishIn = z.infer<typeof PipelinePublishInput>;
type PipelinePublishOut = z.infer<typeof PipelinePublishOutput>;

export const pipelinePublishTool: Tool<PipelinePublishIn, PipelinePublishOut> = {
  definition: {
    name: 'pipeline-publish',
    description: 'Publish a retro commit to the retros branch and a pipeline note on an issue SHA, then verify both on the remote.',
    inputSchema: PipelinePublishInput,
    outputSchema: PipelinePublishOutput,
    roles: ['orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const remote = input.remote ?? 'origin';
    const worktreePath = join(tmpdir(), `loom-retros-${randomUUID()}`);

    try {
      // 1. Create/checkout retros worktree
      // First try to add the worktree from an existing retros branch
      let wtResult = await exec(
        'git',
        ['worktree', 'add', worktreePath, 'retros'],
        cwd,
      );
      if (wtResult.exitCode !== 0) {
        // If the branch doesn't exist, create an orphan branch
        wtResult = await exec(
          'git',
          ['worktree', 'add', '--detach', worktreePath],
          cwd,
        );
        if (wtResult.exitCode !== 0) {
          return err('worktree-failed', wtResult.stderr.trim(), true);
        }

        // Create orphan retros branch
        const orphanResult = await exec(
          'git',
          ['checkout', '--orphan', 'retros'],
          worktreePath,
        );
        if (orphanResult.exitCode !== 0) {
          return err('orphan-branch-failed', orphanResult.stderr.trim(), true);
        }

        // Clean the index for the orphan branch
        await exec('git', ['rm', '-rf', '--cached', '.'], worktreePath);
      }

      // 2. Write retro commit with trailers
      const message = [
        input.retro.title,
        '',
        input.retro.body,
      ].join('\n');

      // Create an empty commit with trailers
      const commitResult = await exec(
        'git',
        [
          'commit', '--allow-empty',
          '-m', message,
          '--trailer', `Agent-Id: ${input.retro.agentId}`,
          '--trailer', `Session-Id: ${input.retro.sessionId}`,
        ],
        worktreePath,
      );
      if (commitResult.exitCode !== 0) {
        return err('retro-commit-failed', commitResult.stderr.trim(), true);
      }

      // Get retro SHA
      const retroShaResult = await exec('git', ['rev-parse', 'HEAD'], worktreePath);
      if (retroShaResult.exitCode !== 0) {
        return err('rev-parse-failed', retroShaResult.stderr.trim(), false);
      }
      const retroSha = retroShaResult.stdout.trim();

      // 3. Push retros branch
      const pushRetrosResult = await exec(
        'git',
        ['push', remote, 'retros', '-u'],
        worktreePath,
      );
      if (pushRetrosResult.exitCode !== 0) {
        return err('push-retros-failed', pushRetrosResult.stderr.trim(), true);
      }

      // 4. Write git notes --ref=pipeline on issueSha
      const noteContent = Object.entries(input.note)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

      const noteResult = await exec(
        'git',
        ['notes', '--ref=pipeline', 'add', '-m', noteContent, input.issueSha],
        cwd,
      );
      if (noteResult.exitCode !== 0) {
        return err('note-add-failed', noteResult.stderr.trim(), true);
      }

      // 5. Push refs/notes/pipeline
      const pushNotesResult = await exec(
        'git',
        ['push', remote, 'refs/notes/pipeline'],
        cwd,
      );
      if (pushNotesResult.exitCode !== 0) {
        return err('push-notes-failed', pushNotesResult.stderr.trim(), true);
      }

      // 6. Verify both via git ls-remote
      const verifyRetrosResult = await exec(
        'git',
        ['ls-remote', remote, 'retros'],
        cwd,
      );
      const verifyNotesResult = await exec(
        'git',
        ['ls-remote', remote, 'refs/notes/pipeline'],
        cwd,
      );
      const verified =
        verifyRetrosResult.exitCode === 0 &&
        verifyRetrosResult.stdout.trim().length > 0 &&
        verifyNotesResult.exitCode === 0 &&
        verifyNotesResult.stdout.trim().length > 0;

      // Get the pipeline notes ref tip SHA
      const noteShaResult = await exec(
        'git',
        ['rev-parse', 'refs/notes/pipeline'],
        cwd,
      );
      if (noteShaResult.exitCode !== 0) {
        return err('note-ref-resolve-failed', 'Could not resolve refs/notes/pipeline', false);
      }
      const noteSha = noteShaResult.stdout.trim();

      // 7. Return success only if verified
      if (!verified) {
        return err('verification-failed', 'Could not verify retros branch or pipeline notes on remote', true);
      }

      return ok({ retroSha, noteSha, verified });
    } finally {
      // Always clean up worktree
      await exec('git', ['worktree', 'remove', '--force', worktreePath], cwd);
    }
  },
};
