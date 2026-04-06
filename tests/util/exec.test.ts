import { describe, it, expect } from 'vitest';
import { exec } from '../../src/util/exec.js';

describe('exec', () => {
  it('returns stdout for a successful command', async () => {
    const result = await exec('echo', ['hello'], '/tmp');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('returns non-zero exit code without rejecting', async () => {
    const result = await exec('false', [], '/tmp');
    expect(result.exitCode).not.toBe(0);
  });

  it('captures stderr', async () => {
    const result = await exec('ls', ['--nonexistent-flag-xyz'], '/tmp');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('respects cwd', async () => {
    const result = await exec('pwd', [], '/tmp');
    // Resolve symlinks — /tmp may be /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });
});
