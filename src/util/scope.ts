export interface ScopeResult {
  valid: boolean;
  violations: string[];
}

/**
 * Check whether all files fall within the allowed scope and outside the denied scope.
 *
 * Matching rules:
 * - A pattern ending with '/' matches any file whose path starts with that prefix.
 *   e.g. 'src/' matches 'src/foo.ts', 'src/bar/baz.ts'
 * - A pattern with '*' is a simple glob: '*' matches any non-'/' characters.
 *   e.g. '*.ts' matches 'foo.ts' but not 'src/foo.ts'
 *   e.g. 'src/*.ts' matches 'src/foo.ts' but not 'src/bar/foo.ts'
 * - A pattern with '**' matches across directory separators.
 *   e.g. 'src/**' matches 'src/foo.ts' and 'src/bar/baz.ts'
 * - An exact string matches exactly.
 */
export function validateScope(
  files: string[],
  allowed: string[],
  denied: string[],
): ScopeResult {
  const violations: string[] = [];

  for (const file of files) {
    const isAllowed =
      allowed.length === 0 || allowed.some((p) => matchPattern(file, p));
    const isDenied =
      denied.length > 0 && denied.some((p) => matchPattern(file, p));

    if (!isAllowed || isDenied) {
      violations.push(file);
    }
  }

  return { valid: violations.length === 0, violations };
}

function matchPattern(file: string, pattern: string): boolean {
  // Directory prefix: 'src/' matches anything starting with 'src/'
  if (pattern.endsWith('/')) {
    return file.startsWith(pattern) || file === pattern.slice(0, -1);
  }

  // Convert glob to regex
  if (pattern.includes('*')) {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (not *)
      .replace(/\*\*/g, '\0')                // placeholder for **
      .replace(/\*/g, '[^/]*')               // * = non-slash
      .replace(/\0/g, '.*');                 // ** = anything
    return new RegExp(`^${regexStr}$`).test(file);
  }

  // Exact match
  return file === pattern;
}
