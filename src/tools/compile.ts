import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const CompileInput = z.object({
  language: z
    .enum(['rust', 'typescript', 'go'])
    .optional()
    .describe('Override language detection'),
});

const CompileOutput = z.object({
  success: z.boolean(),
  language: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
});

type CompileIn = z.infer<typeof CompileInput>;
type CompileOut = z.infer<typeof CompileOutput>;

type Language = 'rust' | 'typescript' | 'go';

function detectLanguage(cwd: string): Language | null {
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(cwd, 'package.json'))) return 'typescript';
  if (existsSync(join(cwd, 'go.mod'))) return 'go';
  return null;
}

const COMPILE_COMMANDS: Record<Language, { cmd: string; args: string[] }> = {
  rust: { cmd: 'cargo', args: ['check'] },
  typescript: { cmd: 'npx', args: ['tsc', '--noEmit'] },
  go: { cmd: 'go', args: ['build', './...'] },
};

export const compileTool: Tool<CompileIn, CompileOut> = {
  definition: {
    name: 'compile',
    description: 'Detect language and run the appropriate compile/check command.',
    inputSchema: CompileInput,
    outputSchema: CompileOutput,
    roles: ['writer', 'orchestrator'],
  },
  handler: async (input, ctx) => {
    const cwd = ctx.worktree;
    const language = input.language ?? detectLanguage(cwd);

    if (!language) {
      return err(
        'language-not-detected',
        'Could not detect project language (no Cargo.toml, package.json, or go.mod)',
        false,
      );
    }

    const { cmd, args } = COMPILE_COMMANDS[language];
    const start = Date.now();
    const result = await exec(cmd, args, cwd);
    const durationMs = Date.now() - start;

    return ok({
      success: result.exitCode === 0,
      language,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
    });
  },
};

/** Exported for testing. */
export { detectLanguage };
