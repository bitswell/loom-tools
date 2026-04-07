import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../types/tool.js';
import { ok, err } from '../types/result.js';
import { exec } from '../util/exec.js';

const TestInput = z.object({
  language: z
    .enum(['rust', 'typescript', 'go'])
    .optional()
    .describe('Override language detection'),
  filter: z
    .string()
    .optional()
    .describe('Test name filter / pattern'),
});

const TestOutput = z.object({
  success: z.boolean(),
  language: z.string(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
});

type TestIn = z.infer<typeof TestInput>;
type TestOut = z.infer<typeof TestOutput>;

type Language = 'rust' | 'typescript' | 'go';

function detectLanguage(cwd: string): Language | null {
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(cwd, 'package.json'))) return 'typescript';
  if (existsSync(join(cwd, 'go.mod'))) return 'go';
  return null;
}

function buildTestCommand(
  language: Language,
  filter?: string,
): { cmd: string; args: string[] } {
  switch (language) {
    case 'rust': {
      const args = ['test'];
      if (filter) args.push('--', filter);
      return { cmd: 'cargo', args };
    }
    case 'typescript': {
      const args = ['vitest', 'run'];
      if (filter) args.push('-t', filter);
      return { cmd: 'npx', args };
    }
    case 'go': {
      const args = ['test', './...'];
      if (filter) args.push('-run', filter);
      return { cmd: 'go', args };
    }
  }
}

/**
 * Parse test counts from output. Best-effort — different runners
 * have different formats.
 */
function parseCounts(
  language: Language,
  stdout: string,
  stderr: string,
): { passed: number; failed: number; skipped: number } {
  const text = stdout + '\n' + stderr;

  if (language === 'typescript') {
    // Vitest summary line: "Tests  5 passed (5)" or "Tests  3 passed | 1 failed (4)"
    // Anchor to "Tests" to avoid matching "Test Files" line counts.
    const testsLine = text.match(/Tests\s+.*/)?.[0] ?? '';
    const passed = testsLine.match(/(\d+)\s+passed/)?.[1];
    const failed = testsLine.match(/(\d+)\s+failed/)?.[1];
    const skipped = testsLine.match(/(\d+)\s+skipped/)?.[1];
    return {
      passed: Number(passed ?? 0),
      failed: Number(failed ?? 0),
      skipped: Number(skipped ?? 0),
    };
  }

  if (language === 'rust') {
    // Cargo: "test result: ok. 5 passed; 0 failed; 0 ignored;"
    const match = text.match(
      /test result:.*?(\d+) passed.*?(\d+) failed.*?(\d+) ignored/,
    );
    if (match) {
      return {
        passed: Number(match[1]),
        failed: Number(match[2]),
        skipped: Number(match[3]),
      };
    }
  }

  if (language === 'go') {
    // Go: count "--- PASS:" and "--- FAIL:" and "--- SKIP:" lines
    const passed = (text.match(/--- PASS:/g) ?? []).length;
    const failed = (text.match(/--- FAIL:/g) ?? []).length;
    const skipped = (text.match(/--- SKIP:/g) ?? []).length;
    return { passed, failed, skipped };
  }

  return { passed: 0, failed: 0, skipped: 0 };
}

export const testTool: Tool<TestIn, TestOut> = {
  definition: {
    name: 'test',
    description: 'Detect language and run the appropriate test command.',
    inputSchema: TestInput,
    outputSchema: TestOutput,
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

    const { cmd, args } = buildTestCommand(language, input.filter);
    const start = Date.now();
    const result = await exec(cmd, args, cwd);
    const durationMs = Date.now() - start;
    const counts = parseCounts(language, result.stdout, result.stderr);

    return ok({
      success: result.exitCode === 0,
      language,
      ...counts,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
    });
  },
};

/** Exported for testing. */
export { detectLanguage, parseCounts, buildTestCommand };
