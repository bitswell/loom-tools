import { describe, it, expect, vi } from 'vitest';
import { dagCheckTool } from '../../src/tools/dag-check.js';
import type { ToolContext } from '../../src/types/context.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'test',
    sessionId: 'test-session',
    role: 'orchestrator',
    branch: 'loom/test',
    worktree: '/tmp/unused',
    scope: [],
    scopeDenied: [],
    emit: vi.fn(),
  };
}

type Agent = { id: string; dependencies: string[] };

async function run(agents: Agent[]) {
  const result = await dagCheckTool.handler({ agents }, makeCtx());
  if (!result.success) {
    throw new Error(`dag-check errored: ${result.error.message}`);
  }
  return result.data;
}

function ruleIds(violations: Array<{ rule: string }>): string[] {
  return violations.map((v) => v.rule);
}

// ---------- Positive cases ----------

describe('dag-check positive cases', () => {
  it('P1: empty input is valid', async () => {
    const data = await run([]);
    expect(data.ok).toBe(true);
    expect(data.integrationOrder).toEqual([]);
    expect(data.violations).toEqual([]);
  });

  it('P2: single agent, no deps', async () => {
    const data = await run([{ id: 'a', dependencies: [] }]);
    expect(data.ok).toBe(true);
    expect(data.integrationOrder).toEqual(['a']);
    expect(data.violations).toEqual([]);
  });

  it('P3: linear chain a->b->c', async () => {
    // a depends on b, b depends on c => integration order: c, b, a
    const data = await run([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['c'] },
      { id: 'c', dependencies: [] },
    ]);
    expect(data.ok).toBe(true);
    expect(data.violations).toEqual([]);
    // c must come before b, b before a
    const order = data.integrationOrder;
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
  });

  it('P4: diamond — a->{b,c}, b->d, c->d', async () => {
    const data = await run([
      { id: 'a', dependencies: ['b', 'c'] },
      { id: 'b', dependencies: ['d'] },
      { id: 'c', dependencies: ['d'] },
      { id: 'd', dependencies: [] },
    ]);
    expect(data.ok).toBe(true);
    expect(data.violations).toEqual([]);
    const order = data.integrationOrder;
    // d before b and c, both before a
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'));
  });

  it('P5: independent agents (no deps)', async () => {
    const data = await run([
      { id: 'x', dependencies: [] },
      { id: 'y', dependencies: [] },
      { id: 'z', dependencies: [] },
    ]);
    expect(data.ok).toBe(true);
    expect(data.violations).toEqual([]);
    expect(data.integrationOrder).toHaveLength(3);
    expect(new Set(data.integrationOrder)).toEqual(new Set(['x', 'y', 'z']));
  });

  it('P6: deterministic order — independent agents sorted alphabetically', async () => {
    const data = await run([
      { id: 'c', dependencies: [] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
    ]);
    expect(data.ok).toBe(true);
    // Kahn's with sorted queue should produce alphabetical order
    expect(data.integrationOrder).toEqual(['a', 'b', 'c']);
  });
});

// ---------- Negative cases ----------

describe('dag-check negative cases', () => {
  it('N1: 2-node cycle a->b, b->a', async () => {
    const data = await run([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ]);
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('dag-cycle');
    expect(data.integrationOrder).toEqual([]);
    // Cycle path should contain both nodes
    const detail = data.violations.find((v) => v.rule === 'dag-cycle')!.detail;
    expect(detail).toContain('a');
    expect(detail).toContain('b');
    expect(detail).toContain('->');
  });

  it('N2: 3-node cycle a->b, b->c, c->a', async () => {
    const data = await run([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['c'] },
      { id: 'c', dependencies: ['a'] },
    ]);
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('dag-cycle');
    const detail = data.violations.find((v) => v.rule === 'dag-cycle')!.detail;
    expect(detail).toContain('->');
  });

  it('N3: missing dependency', async () => {
    const data = await run([
      { id: 'a', dependencies: ['nonexistent'] },
    ]);
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('dag-missing-dep');
    const detail = data.violations.find((v) => v.rule === 'dag-missing-dep')!.detail;
    expect(detail).toContain('nonexistent');
    expect(detail).toContain('a');
  });

  it('N4: self-dependency', async () => {
    const data = await run([
      { id: 'a', dependencies: ['a'] },
    ]);
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('dag-self-dep');
    const detail = data.violations.find((v) => v.rule === 'dag-self-dep')!.detail;
    expect(detail).toContain('a');
  });

  it('N5: mixed — valid deps plus one cycle', async () => {
    // d is independent, a->b->c->a is a cycle
    const data = await run([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['c'] },
      { id: 'c', dependencies: ['a'] },
      { id: 'd', dependencies: [] },
    ]);
    expect(data.ok).toBe(false);
    expect(ruleIds(data.violations)).toContain('dag-cycle');
    // d should not appear in cycle detail
    const detail = data.violations.find((v) => v.rule === 'dag-cycle')!.detail;
    expect(detail).not.toContain('d');
  });

  it('N6: multiple missing deps reported individually', async () => {
    const data = await run([
      { id: 'a', dependencies: ['ghost1', 'ghost2'] },
    ]);
    expect(data.ok).toBe(false);
    const missing = data.violations.filter((v) => v.rule === 'dag-missing-dep');
    expect(missing).toHaveLength(2);
    expect(missing.map((v) => v.detail).join(' ')).toContain('ghost1');
    expect(missing.map((v) => v.detail).join(' ')).toContain('ghost2');
  });

  it('N7: self-dep does not also report as cycle', async () => {
    const data = await run([
      { id: 'a', dependencies: ['a'] },
    ]);
    expect(ruleIds(data.violations)).toContain('dag-self-dep');
    // Self-dep is caught early; Kahn's should not run
    expect(ruleIds(data.violations)).not.toContain('dag-cycle');
  });

  it('N8: cycle path forms a closed loop', async () => {
    const data = await run([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ]);
    const detail = data.violations.find((v) => v.rule === 'dag-cycle')!.detail;
    const parts = detail.split(' -> ');
    // Closed loop: first element equals last element
    expect(parts[0]).toBe(parts[parts.length - 1]);
  });
});

// ---------- Tool definition ----------

describe('dag-check tool definition', () => {
  it('D1: has correct name and role', () => {
    expect(dagCheckTool.definition.name).toBe('dag-check');
    expect(dagCheckTool.definition.roles).toEqual(['orchestrator']);
  });
});
