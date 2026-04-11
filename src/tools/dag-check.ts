import { z } from 'zod';
import type { Tool } from '../types/tool.js';
import { ok } from '../types/result.js';

const AgentEntry = z.object({
  id: z.string().describe('Agent assignment slug.'),
  dependencies: z
    .array(z.string())
    .describe('List of assignment slugs this agent depends on.'),
});

const DagCheckInput = z.object({
  agents: z.array(AgentEntry).describe('Set of agents with their dependencies.'),
});

const Violation = z.object({
  rule: z.enum(['dag-cycle', 'dag-missing-dep', 'dag-self-dep']),
  detail: z.string(),
});

const DagCheckOutput = z.object({
  ok: z.boolean(),
  integrationOrder: z
    .array(z.string())
    .describe('Topological sort order (valid only when ok is true).'),
  violations: z.array(Violation),
});

type DagCheckIn = z.infer<typeof DagCheckInput>;
type DagCheckOut = z.infer<typeof DagCheckOutput>;
type ViolationT = z.infer<typeof Violation>;

/**
 * Extract cycle path from remaining nodes after Kahn's algorithm.
 *
 * Walks the adjacency list starting from any remaining node,
 * following edges that stay within the remaining set, until
 * a node is revisited.
 */
function extractCyclePath(
  remaining: Set<string>,
  adjacency: Map<string, string[]>,
): string[] {
  if (remaining.size === 0) return [];

  const start = remaining.values().next().value!;
  const visited: string[] = [];
  const seen = new Set<string>();
  let current = start;

  while (!seen.has(current)) {
    seen.add(current);
    visited.push(current);
    const neighbors = adjacency.get(current) ?? [];
    const next = neighbors.find((n) => remaining.has(n));
    if (!next) break;
    current = next;
  }

  // Trim to the actual cycle: from the repeated node onward
  const cycleStart = visited.indexOf(current);
  if (cycleStart === -1) return visited;
  const cycle = visited.slice(cycleStart);
  cycle.push(current); // close the cycle
  return cycle;
}

/**
 * Validate that LOOM agent dependencies form a DAG.
 *
 * Uses Kahn's algorithm (BFS topological sort). Reports:
 * - dag-self-dep: agent depends on itself
 * - dag-missing-dep: dependency references unknown agent
 * - dag-cycle: cycle exists in the dependency graph
 *
 * On success, integrationOrder contains a valid topological sort
 * (dependencies before dependents).
 */
export const dagCheckTool: Tool<DagCheckIn, DagCheckOut> = {
  definition: {
    name: 'dag-check',
    description: 'Validate that LOOM agent dependencies form a DAG.',
    inputSchema: DagCheckInput,
    outputSchema: DagCheckOutput,
    roles: ['orchestrator'],
  },
  handler: async (input) => {
    const agents = input.agents;
    const violations: ViolationT[] = [];

    // Empty input is trivially valid
    if (agents.length === 0) {
      return ok({ ok: true, integrationOrder: [], violations: [] });
    }

    const ids = new Set(agents.map((a) => a.id));

    // 1. Check self-deps
    for (const agent of agents) {
      if (agent.dependencies.includes(agent.id)) {
        violations.push({
          rule: 'dag-self-dep',
          detail: `${agent.id} depends on itself`,
        });
      }
    }

    // 2. Check missing deps
    for (const agent of agents) {
      for (const dep of agent.dependencies) {
        if (dep !== agent.id && !ids.has(dep)) {
          violations.push({
            rule: 'dag-missing-dep',
            detail: `${agent.id} depends on ${dep}, which is not in the agent set`,
          });
        }
      }
    }

    // If we already have violations, skip Kahn's — the graph is malformed
    if (violations.length > 0) {
      return ok({ ok: false, integrationOrder: [], violations });
    }

    // 3. Build adjacency list and in-degree map
    // Edge: dependency -> dependent (dep must be integrated before dependent)
    const adjacency = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const id of ids) {
      adjacency.set(id, []);
      inDegree.set(id, 0);
    }

    for (const agent of agents) {
      for (const dep of agent.dependencies) {
        adjacency.get(dep)!.push(agent.id);
        inDegree.set(agent.id, (inDegree.get(agent.id) ?? 0) + 1);
      }
    }

    // 4. Kahn's algorithm
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }
    // Sort initial queue for deterministic output
    queue.sort();

    const order: string[] = [];

    while (queue.length > 0) {
      // Sort to ensure deterministic processing order
      queue.sort();
      const node = queue.shift()!;
      order.push(node);

      for (const neighbor of adjacency.get(node) ?? []) {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    // 5. Check for cycles
    if (order.length < ids.size) {
      const remaining = new Set<string>();
      for (const id of ids) {
        if (!order.includes(id)) {
          remaining.add(id);
        }
      }

      // Build reverse adjacency for cycle extraction (dependent -> dependency)
      // We want to follow dependency edges within the remaining set
      const depAdjacency = new Map<string, string[]>();
      for (const id of remaining) {
        depAdjacency.set(id, []);
      }
      for (const agent of agents) {
        if (!remaining.has(agent.id)) continue;
        for (const dep of agent.dependencies) {
          if (remaining.has(dep)) {
            depAdjacency.get(agent.id)!.push(dep);
          }
        }
      }

      const cyclePath = extractCyclePath(remaining, depAdjacency);
      violations.push({
        rule: 'dag-cycle',
        detail: cyclePath.join(' -> '),
      });

      return ok({ ok: false, integrationOrder: [], violations });
    }

    return ok({ ok: true, integrationOrder: order, violations: [] });
  },
};
