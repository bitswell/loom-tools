/** Events emitted by tools during execution. */
export type EventType =
  | 'branch-updated'
  | 'state-changed'
  | 'agent-blocked'
  | 'agent-completed'
  | 'agent-failed'
  | 'tool-requested'
  | 'review-submitted'
  | 'scope-violation';

/** A typed event emitted by a tool. */
export interface LoomEvent {
  type: EventType;
  branch: string;
  agentId: string;
  sessionId: string;
  timestamp: string; // ISO-8601
  payload: Record<string, unknown>;
}
