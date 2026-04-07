/**
 * Tools available to the orchestrator.
 *
 * The orchestrator has access to everything: all writer tools,
 * all reviewer tools, plus lifecycle and workflow management.
 *
 * In practice, the orchestrator role bypasses tool filtering entirely
 * (see canAccess() in role.ts). This list exists for documentation
 * and for explicit enumeration in tests.
 */
export const ORCHESTRATOR_TOOLS = [
  // Git tools (shared with writer)
  'commit',
  'push',
  'read-assignment',
  'status-query',

  // Build tools (shared with writer)
  'compile',
  'test',

  // Lifecycle tools (orchestrator only)
  'assign',
  'dispatch',
  'wait',
  'status',

  // Workflow tools (orchestrator only)
  'pr-create',
  'pr-retarget',
  'pr-merge',
  'review-request',
  'submodule',

  // Self-service (all roles)
  'tool-request',
] as const;

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOLS)[number];
