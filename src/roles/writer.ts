/**
 * Tools available to writer agents.
 *
 * Writers can: commit, push, compile, test, read their assignment,
 * query status, and request new tools. That's it.
 *
 * They cannot: assign, dispatch, merge, retarget PRs, or manage
 * other agents. The protocol enforces this via role scoping.
 */
export const WRITER_TOOLS = [
  'commit',
  'push',
  'read-assignment',
  'compile',
  'test',
  'status-query',
  'tool-request',
] as const;

export type WriterToolName = (typeof WRITER_TOOLS)[number];
