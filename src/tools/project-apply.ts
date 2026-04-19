import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';

const ProjectApplyInput = z.object({
  files: z
    .record(z.string(), z.string())
    .describe('Map of relative file path to content.'),
  baseDir: z
    .string()
    .optional()
    .describe('Directory to apply relative paths into. Defaults to cwd.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('Report what would happen, touch nothing.'),
  force: z
    .boolean()
    .optional()
    .describe('Overwrite existing files. Default false.'),
});

const ProjectApplyOutput = z.object({
  baseDir: z.string().describe('Resolved absolute base directory.'),
  applied: z
    .array(z.string())
    .describe('Relative paths actually written to disk.'),
  skipped: z
    .array(
      z.object({
        path: z.string(),
        reason: z.enum(['exists', 'dry-run']),
      }),
    )
    .describe('Paths not written with the reason.'),
});

type ProjectApplyIn = z.infer<typeof ProjectApplyInput>;
type ProjectApplyOut = z.infer<typeof ProjectApplyOutput>;

function validateRelPath(relPath: string): string | null {
  if (relPath.length === 0) return 'empty path';
  if (path.isAbsolute(relPath)) return 'absolute paths not allowed';
  const segments = relPath.split(/[/\\]/);
  if (segments.some((s) => s === '..')) return 'parent segments not allowed';
  return null;
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

export const projectApplyTool: Tool<ProjectApplyIn, ProjectApplyOut> = {
  definition: {
    name: 'project-apply',
    description:
      'Apply a files-map (relative path -> content) to disk beneath a base directory, honoring dry-run and force flags.',
    inputSchema: ProjectApplyInput,
    outputSchema: ProjectApplyOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    const parsed = ProjectApplyInput.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const p = issue.path.join('.');
      return err(
        'invalid-input',
        p ? `${p}: ${issue.message}` : issue.message,
        false,
      );
    }
    const safe = parsed.data;

    const baseDir = path.resolve(safe.baseDir ?? process.cwd());
    const dryRun = safe.dryRun ?? false;
    const force = safe.force ?? false;

    const applied: string[] = [];
    const skipped: { path: string; reason: 'exists' | 'dry-run' }[] = [];

    for (const [relPath, content] of Object.entries(safe.files)) {
      const why = validateRelPath(relPath);
      if (why !== null) {
        return err('invalid-path', `${relPath}: ${why}`, false);
      }

      if (dryRun) {
        skipped.push({ path: relPath, reason: 'dry-run' });
        continue;
      }

      const target = path.resolve(baseDir, relPath);
      if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
        return err(
          'path-escape',
          `${relPath}: resolved target escapes baseDir`,
          false,
        );
      }

      if (!force && (await fileExists(target))) {
        skipped.push({ path: relPath, reason: 'exists' });
        continue;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      applied.push(relPath);
    }

    return ok({ baseDir, applied, skipped });
  },
};
