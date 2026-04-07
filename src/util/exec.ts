import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command and return its output. Never rejects on non-zero exit.
 */
export function exec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      // execFile calls back with an error on non-zero exit, but we still
      // get stdout/stderr. Normalize to a plain result.
      const exitCode =
        error && 'code' in error && typeof error.code === 'number'
          ? error.code
          : error
            ? 1
            : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}
