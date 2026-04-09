import { describe, it, expect, afterEach } from 'vitest';
import { exec } from '../../src/util/exec.js';
import { createFixtureRepo, assigned, type FixtureRepo } from './index.js';
import * as fs from 'node:fs/promises';

describe('fixture-repo harness smoke tests', () => {
  let repos: FixtureRepo[] = [];

  afterEach(async () => {
    for (const r of repos) await r.cleanup();
    repos = [];
  });

  it('creates a repo and commits with trailers that round-trip through git', async () => {
    const repo = await createFixtureRepo();
    repos.push(repo);

    const sha = await repo.commit({
      subject: 'test: a commit with trailers',
      trailers: {
        'Agent-Id': 'ratchet',
        'Key-Finding': ['finding one', 'finding two', 'finding three'],
      },
      allowEmpty: true,
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const trailers = await exec(
      'git',
      ['log', '-1', '--format=%(trailers)', sha],
      repo.path,
    );
    expect(trailers.exitCode).toBe(0);
    expect(trailers.stdout).toContain('Agent-Id: ratchet');
    expect(trailers.stdout).toContain('Key-Finding: finding one');
    expect(trailers.stdout).toContain('Key-Finding: finding two');
    expect(trailers.stdout).toContain('Key-Finding: finding three');
  });

  it('supports branch and checkout', async () => {
    const repo = await createFixtureRepo();
    repos.push(repo);

    const a = await repo.commit({ subject: 'a', allowEmpty: true });
    await repo.branch('feature', a);
    await repo.checkout('feature');

    const head = await exec(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      repo.path,
    );
    expect(head.stdout.trim()).toBe('feature');

    const sha = await exec('git', ['rev-parse', 'HEAD'], repo.path);
    expect(sha.stdout.trim()).toBe(a);
  });

  it('cleanup removes the tmp directory', async () => {
    const repo = await createFixtureRepo();
    const p = repo.path;
    await repo.cleanup();
    await expect(fs.stat(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('assigned() helper shape is a valid ASSIGNED commit', async () => {
    const repo = await createFixtureRepo();
    repos.push(repo);

    const opts = assigned({
      agent: 'ratchet',
      slug: 'protocol-enforce-phase-1',
      scope: 'src/tools/trailer-validate.ts',
    });
    const sha = await repo.commit(opts);

    const trailers = await exec(
      'git',
      ['log', '-1', '--format=%(trailers)', sha],
      repo.path,
    );
    expect(trailers.stdout).toContain('Agent-Id: ratchet');
    expect(trailers.stdout).toContain('Assigned-To: ratchet');
    expect(trailers.stdout).toContain('Assignment: protocol-enforce-phase-1');
    expect(trailers.stdout).toContain(
      'Scope: src/tools/trailer-validate.ts',
    );
    expect(trailers.stdout).toContain('Dependencies: none');
    expect(trailers.stdout).toContain('Budget: 60000');
    expect(trailers.stdout).toContain('Task-Status: ASSIGNED');
  });
});
