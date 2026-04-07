import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok } from '../types/result.js';

const Language = z.enum(['rust', 'typescript', 'go']);
type Language = z.infer<typeof Language>;

const Feature = z.enum(['test', 'typecheck', 'lint', 'gh-pages', 'release']);
type Feature = z.infer<typeof Feature>;

const CiGenerateInput = z.object({
  language: Language.describe('Project language'),
  features: z.array(Feature).describe('CI features to include'),
});

const CiGenerateOutput = z.object({
  files: z
    .record(z.string(), z.string())
    .describe('Map of file path to YAML content'),
});

type CiGenerateIn = z.infer<typeof CiGenerateInput>;
type CiGenerateOut = z.infer<typeof CiGenerateOutput>;

// --- Language-specific commands ---

const COMMANDS: Record<Language, Record<'test' | 'typecheck' | 'lint', string>> = {
  rust: {
    typecheck: 'cargo check',
    test: 'cargo test',
    lint: 'cargo clippy -- -D warnings',
  },
  typescript: {
    typecheck: 'npx tsc --noEmit',
    test: 'npx vitest run',
    lint: 'npx eslint .',
  },
  go: {
    typecheck: 'go build ./...',
    test: 'go test ./...',
    lint: 'golangci-lint run',
  },
};

const SETUP_STEPS: Record<Language, string> = {
  rust: [
    '      - uses: actions/checkout@v4',
    '      - uses: dtolnay/rust-toolchain@stable',
  ].join('\n'),
  typescript: [
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 20',
    '      - run: npm ci',
  ].join('\n'),
  go: [
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-go@v5',
    '        with:',
    '          go-version: stable',
  ].join('\n'),
};

// --- Template helpers ---

function ciJobYaml(name: string, command: string, language: Language): string {
  return [
    `  ${name}:`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    SETUP_STEPS[language],
    `      - run: ${command}`,
  ].join('\n');
}

function ciWorkflowYaml(language: Language, jobs: string[]): string {
  return [
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'jobs:',
    ...jobs,
  ].join('\n') + '\n';
}

function ghPagesWorkflowYaml(language: Language): string {
  const buildCmd = language === 'rust'
    ? 'cargo doc --no-deps'
    : language === 'typescript'
      ? 'npm run build'
      : 'go doc ./...';

  return [
    'name: GitHub Pages',
    'on:',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  pages: write',
    '  id-token: write',
    '',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    SETUP_STEPS[language],
    `      - run: ${buildCmd}`,
    '      - uses: actions/upload-pages-artifact@v3',
    '        with:',
    '          path: ./docs',
    '      - uses: actions/deploy-pages@v4',
  ].join('\n') + '\n';
}

function releaseWorkflowYaml(language: Language): string {
  const buildCmd = language === 'rust'
    ? 'cargo build --release'
    : language === 'typescript'
      ? 'npm run build'
      : 'go build -o dist/ ./...';

  return [
    'name: Release',
    'on:',
    '  push:',
    '    tags: ["v*"]',
    '',
    'permissions:',
    '  contents: write',
    '',
    'jobs:',
    '  release:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    SETUP_STEPS[language],
    `      - run: ${buildCmd}`,
    '      - uses: softprops/action-gh-release@v2',
  ].join('\n') + '\n';
}

// --- Standalone generation function ---

/**
 * Generate CI workflow files for a given language and feature set.
 * Exported so repo-init can call this directly without constructing a ToolContext.
 */
export function generateCiFiles(
  language: Language,
  features: Feature[],
): Record<string, string> {
  const files: Record<string, string> = {};

  // Collect CI jobs (test, typecheck, lint go into one ci.yml)
  const ciFeatures = features.filter(
    (f): f is 'test' | 'typecheck' | 'lint' => f === 'test' || f === 'typecheck' || f === 'lint',
  );

  if (ciFeatures.length > 0) {
    const jobs = ciFeatures.map((f) => ciJobYaml(f, COMMANDS[language][f], language));
    files['.github/workflows/ci.yml'] = ciWorkflowYaml(language, jobs);
  }

  // gh-pages and release get their own workflow files
  if (features.includes('gh-pages')) {
    files['.github/workflows/gh-pages.yml'] = ghPagesWorkflowYaml(language);
  }

  if (features.includes('release')) {
    files['.github/workflows/release.yml'] = releaseWorkflowYaml(language);
  }

  return files;
}

// --- Tool export ---

export const ciGenerateTool: Tool<CiGenerateIn, CiGenerateOut> = {
  definition: {
    name: 'ci-generate',
    description:
      'Generate GitHub Actions CI workflow files for a given language and feature set.',
    inputSchema: CiGenerateInput,
    outputSchema: CiGenerateOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    const files = generateCiFiles(input.language, input.features);
    return ok({ files });
  },
};
