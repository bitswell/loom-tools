import { describe, it, expect } from 'vitest';
import { validateScope } from '../../src/util/scope.js';

describe('validateScope', () => {
  // ── Directory prefix patterns ──────────────────────────────────────────

  describe('directory prefix matching', () => {
    it('allows files under an allowed directory prefix', () => {
      const result = validateScope(
        ['src/foo.ts', 'src/bar/baz.ts'],
        ['src/'],
        [],
      );
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('rejects files outside allowed directory prefix', () => {
      const result = validateScope(
        ['src/foo.ts', 'dist/out.js'],
        ['src/'],
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(['dist/out.js']);
    });

    it('allows multiple directory prefixes', () => {
      const result = validateScope(
        ['src/foo.ts', 'tests/bar.test.ts'],
        ['src/', 'tests/'],
        [],
      );
      expect(result.valid).toBe(true);
    });

    it('rejects when file matches denied directory', () => {
      const result = validateScope(
        ['src/foo.ts', 'src/secrets/key.ts'],
        ['src/'],
        ['src/secrets/'],
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(['src/secrets/key.ts']);
    });
  });

  // ── Glob patterns ─────────────────────────────────────────────────────

  describe('glob matching', () => {
    it('matches single-star within a directory', () => {
      const result = validateScope(
        ['src/foo.ts', 'src/bar.ts'],
        ['src/*.ts'],
        [],
      );
      expect(result.valid).toBe(true);
    });

    it('single-star does not cross directory boundaries', () => {
      const result = validateScope(
        ['src/nested/foo.ts'],
        ['src/*.ts'],
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(['src/nested/foo.ts']);
    });

    it('double-star crosses directory boundaries', () => {
      const result = validateScope(
        ['src/foo.ts', 'src/nested/bar.ts', 'src/a/b/c.ts'],
        ['src/**'],
        [],
      );
      expect(result.valid).toBe(true);
    });

    it('denied glob pattern blocks matching files', () => {
      const result = validateScope(
        ['src/foo.ts', 'src/foo.test.ts'],
        ['src/'],
        ['**/*.test.ts'],
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(['src/foo.test.ts']);
    });
  });

  // ── Exact match ───────────────────────────────────────────────────────

  describe('exact matching', () => {
    it('matches exact file path', () => {
      const result = validateScope(
        ['README.md'],
        ['README.md'],
        [],
      );
      expect(result.valid).toBe(true);
    });

    it('rejects non-matching exact path', () => {
      const result = validateScope(
        ['README.md', 'LICENSE'],
        ['README.md'],
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(['LICENSE']);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty allowed list allows everything', () => {
      const result = validateScope(
        ['anything/goes.ts'],
        [],
        [],
      );
      expect(result.valid).toBe(true);
    });

    it('empty file list is always valid', () => {
      const result = validateScope([], ['src/'], []);
      expect(result.valid).toBe(true);
    });

    it('denied takes precedence over allowed', () => {
      const result = validateScope(
        ['src/secret.ts'],
        ['src/'],
        ['src/secret.ts'],
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(['src/secret.ts']);
    });

    it('collects all violations, not just the first', () => {
      const result = validateScope(
        ['bad1.js', 'src/good.ts', 'bad2.js'],
        ['src/'],
        [],
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(['bad1.js', 'bad2.js']);
    });
  });
});
