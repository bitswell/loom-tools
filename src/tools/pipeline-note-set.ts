import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const PipelineNoteSetInput = z.object({
  sha: z
    .string()
    .min(1)
    .describe('Commit SHA to annotate (refs/notes/pipeline is keyed by commit)'),
  pairs: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .describe('Key name (must be non-empty; regex-escaped internally)'),
        value: z.string().describe('Value as written after `key: `'),
      }),
    )
    .min(1)
    .describe(
      'Key-value pairs to set. Duplicate keys: last entry wins (divergence from scripts/pipeline-note-set.sh, which appends every pair verbatim).',
    ),
});

const PipelineNoteSetOutput = z.object({
  sha: z.string().describe('Echoed input sha'),
  previous: z
    .string()
    .nullable()
    .describe('Existing note content before write, or null if none'),
  current: z.string().describe('Full note content written'),
});

type PipelineNoteSetIn = z.infer<typeof PipelineNoteSetInput>;
type PipelineNoteSetOut = z.infer<typeof PipelineNoteSetOutput>;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const pipelineNoteSetTool: Tool<PipelineNoteSetIn, PipelineNoteSetOut> = {
  definition: {
    name: 'pipeline-note-set',
    description:
      'Set key:value lines on refs/notes/pipeline for a commit, replacing any existing lines for the same keys while preserving the rest. Does not push. Duplicate keys in input: last entry wins.',
    inputSchema: PipelineNoteSetInput,
    outputSchema: PipelineNoteSetOutput,
    roles: ['writer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;

    const deduped = new Map<string, string>();
    for (const { key, value } of input.pairs) {
      deduped.delete(key);
      deduped.set(key, value);
    }

    const showResult = await exec(
      'git',
      ['notes', '--ref=pipeline', 'show', input.sha],
      cwd,
    );
    const previous: string | null =
      showResult.exitCode === 0 ? showResult.stdout.replace(/\n$/, '') : null;

    const keyAlternation = [...deduped.keys()].map(escapeRegex).join('|');
    const filterRe = new RegExp(`^(?:${keyAlternation}):[ \\t]*`);

    const keptLines =
      previous === null
        ? []
        : previous.split('\n').filter((line) => !filterRe.test(line));

    const appended = [...deduped.entries()].map(([k, v]) => `${k}: ${v}`);
    const current = [...keptLines, ...appended].join('\n');

    const writeResult = await exec(
      'git',
      [
        'notes',
        '--ref=pipeline',
        'add',
        '-f',
        '-m',
        current,
        input.sha,
      ],
      cwd,
    );
    if (writeResult.exitCode !== 0) {
      return err(
        'git-notes-add-failed',
        writeResult.stderr.trim() || 'git notes add failed',
        true,
      );
    }

    return ok({ sha: input.sha, previous, current });
  },
};
