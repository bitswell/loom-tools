/**
 * Protocol roles in the LOOM lifecycle.
 *
 * Each role gets a scoped set of tools:
 * - writer:       commit, push, compile, test, read-assignment, tool-request
 * - reviewer:     read-assignment, status-query (read-only, no commits)
 * - orchestrator: everything (assign, dispatch, merge, plus all writer/reviewer tools)
 */
export type ProtocolRole = 'writer' | 'reviewer' | 'orchestrator';

/** All valid roles. */
export const PROTOCOL_ROLES: readonly ProtocolRole[] = [
  'writer',
  'reviewer',
  'orchestrator',
] as const;

/**
 * Check if a role can access a tool.
 * Orchestrator can access everything.
 * Otherwise the tool must explicitly list the role.
 */
export function canAccess(
  agentRole: ProtocolRole,
  toolRoles: readonly ProtocolRole[],
): boolean {
  if (agentRole === 'orchestrator') return true;
  return toolRoles.includes(agentRole);
}
