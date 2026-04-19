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

/**
 * Validate and normalize a relative input path.
 *
 * Returns [null, errorMessage] on rejection, [normalized, null] on success.
 * Normalization strips redundant `.` segments and `//`; rejects absolute
 * paths, `..` segments, empty keys, `.`, and embedded NUL.
 */
function normalizeRelPath(
  relPath: string,
): [string | null, string | null] {
  if (relPath.length === 0) return [null, 'empty path'];
  if (relPath.includes('\u0000')) return [null, 'null byte in path'];
  if (path.isAbsolute(relPath)) return [null, 'absolute paths not allowed'];

  // Reject any '..' segment in the raw input — even if a subsequent
  // normalize would cancel it. A caller that wrote 'a/../b' expressed
  // intent we do not want to honor silently.
  const rawSegments = relPath.split(/[/\\]/);
  if (rawSegments.some((s) => s === '..')) {
    return [null, 'parent segments not allowed'];
  }

  // Normalize on posix semantics so reports are stable across platforms
  // and leading "./" is dropped. After the .. guard above, this only
  // collapses '.' and '//' — it cannot produce escape.
  const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'));

  if (normalized === '.' || normalized === '') {
    return [null, 'path resolves to baseDir itself'];
  }
  return [normalized, null];
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

    // Resolve the canonical baseDir once so every target comparison is
    // against the real, symlink-followed path.
    let realBaseDir: string;
    try {
      realBaseDir = await fs.realpath(baseDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('invalid-basedir', msg, false);
    }

    const applied: string[] = [];
    const skipped: { path: string; reason: 'exists' | 'dry-run' }[] = [];

    for (const [rawPath, content] of Object.entries(safe.files)) {
      const [relPath, why] = normalizeRelPath(rawPath);
      if (relPath === null) {
        return err('invalid-path', `${rawPath}: ${why}`, false);
      }

      if (dryRun) {
        skipped.push({ path: relPath, reason: 'dry-run' });
        continue;
      }

      const target = path.resolve(realBaseDir, relPath);
      const parent = path.dirname(target);

      try {
        await fs.mkdir(parent, { recursive: true });

        // Defense against symlink-based escape: after mkdir, confirm the
        // resolved parent still sits under realBaseDir. A symlink placed
        // inside baseDir by an earlier apply or external tool is a write
        // into whatever the link points to otherwise.
        const realParent = await fs.realpath(parent);
        if (
          realParent !== realBaseDir &&
          !realParent.startsWith(realBaseDir + path.sep)
        ) {
          return err(
            'path-escape',
            `${rawPath}: resolves outside baseDir`,
            false,
          );
        }

        const realTarget = path.join(realParent, path.basename(target));

        if (!force && (await fileExists(realTarget))) {
          skipped.push({ path: relPath, reason: 'exists' });
          continue;
        }

        await fs.writeFile(realTarget, content, 'utf8');
        applied.push(relPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err('write-failed', `${rawPath}: ${msg}`, false);
      }
    }

    return ok({ baseDir: realBaseDir, applied, skipped });
  },
};
