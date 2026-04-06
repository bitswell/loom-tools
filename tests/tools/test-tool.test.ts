import { describe, it, expect } from 'vitest';
import { parseCounts, buildTestCommand } from '../../src/tools/test.js';

describe('parseCounts', () => {
  it('parses vitest output', () => {
    const stdout = `
 ✓ tests/foo.test.ts (3 tests) 5ms
 ✓ tests/bar.test.ts (2 tests) 3ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  10:00:00
   Duration  500ms
`;
    const result = parseCounts('typescript', stdout, '');
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('parses vitest output with failures', () => {
    const stdout = `
 Test Files  1 passed | 1 failed (2)
      Tests  3 passed | 2 failed (5)
`;
    const result = parseCounts('typescript', stdout, '');
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(2);
  });

  it('parses vitest output with skipped', () => {
    const stdout = `
      Tests  3 passed | 1 skipped (4)
`;
    const result = parseCounts('typescript', stdout, '');
    expect(result.passed).toBe(3);
    expect(result.skipped).toBe(1);
  });

  it('parses cargo test output', () => {
    const stdout = `
test result: ok. 10 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out
`;
    const result = parseCounts('rust', stdout, '');
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it('parses go test output', () => {
    const stdout = `
--- PASS: TestFoo (0.00s)
--- PASS: TestBar (0.01s)
--- FAIL: TestBaz (0.00s)
--- SKIP: TestQux (0.00s)
FAIL
`;
    const result = parseCounts('go', stdout, '');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('returns zeros when output is unparseable', () => {
    const result = parseCounts('rust', 'no tests found', '');
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe('buildTestCommand', () => {
  it('builds rust test command', () => {
    const { cmd, args } = buildTestCommand('rust');
    expect(cmd).toBe('cargo');
    expect(args).toEqual(['test']);
  });

  it('builds rust test command with filter', () => {
    const { cmd, args } = buildTestCommand('rust', 'my_test');
    expect(cmd).toBe('cargo');
    expect(args).toEqual(['test', '--', 'my_test']);
  });

  it('builds typescript test command', () => {
    const { cmd, args } = buildTestCommand('typescript');
    expect(cmd).toBe('npx');
    expect(args).toEqual(['vitest', 'run']);
  });

  it('builds typescript test command with filter', () => {
    const { cmd, args } = buildTestCommand('typescript', 'scope');
    expect(cmd).toBe('npx');
    expect(args).toEqual(['vitest', 'run', '-t', 'scope']);
  });

  it('builds go test command', () => {
    const { cmd, args } = buildTestCommand('go');
    expect(cmd).toBe('go');
    expect(args).toEqual(['test', './...']);
  });

  it('builds go test command with filter', () => {
    const { cmd, args } = buildTestCommand('go', 'TestFoo');
    expect(cmd).toBe('go');
    expect(args).toEqual(['test', './...', '-run', 'TestFoo']);
  });
});
