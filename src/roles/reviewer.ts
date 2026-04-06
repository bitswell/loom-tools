/**
 * Tools available to reviewer agents.
 *
 * Reviewers are read-only. They can read assignments and query status
 * but cannot commit, push, compile, or modify anything.
 */
export const REVIEWER_TOOLS = [
  'read-assignment',
  'status-query',
  'tool-request',
] as const;

export type ReviewerToolName = (typeof REVIEWER_TOOLS)[number];
