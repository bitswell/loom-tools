import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../../src/tools/index.js';

describe('tool input/output schemas', () => {
  const registry = createDefaultRegistry();

  it('commit schema accepts valid input', () => {
    const tool = registry.get('commit')!;
    const parsed = tool.definition.inputSchema.safeParse({
      message: 'fix: something',
    });
    expect(parsed.success).toBe(true);
  });

  it('commit schema accepts input with files and trailers', () => {
    const tool = registry.get('commit')!;
    const parsed = tool.definition.inputSchema.safeParse({
      message: 'fix: something',
      files: ['src/foo.ts'],
      trailers: { 'Task-Status': 'IMPLEMENTING' },
    });
    expect(parsed.success).toBe(true);
  });

  it('commit schema rejects missing message', () => {
    const tool = registry.get('commit')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('push schema accepts empty input', () => {
    const tool = registry.get('push')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('push schema accepts remote and force', () => {
    const tool = registry.get('push')!;
    const parsed = tool.definition.inputSchema.safeParse({
      remote: 'upstream',
      force: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('read-assignment schema accepts empty input', () => {
    const tool = registry.get('read-assignment')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('compile schema accepts empty input', () => {
    const tool = registry.get('compile')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('compile schema accepts language override', () => {
    const tool = registry.get('compile')!;
    const parsed = tool.definition.inputSchema.safeParse({
      language: 'rust',
    });
    expect(parsed.success).toBe(true);
  });

  it('compile schema rejects unknown language', () => {
    const tool = registry.get('compile')!;
    const parsed = tool.definition.inputSchema.safeParse({
      language: 'cobol',
    });
    expect(parsed.success).toBe(false);
  });

  it('test schema accepts empty input', () => {
    const tool = registry.get('test')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('test schema accepts filter', () => {
    const tool = registry.get('test')!;
    const parsed = tool.definition.inputSchema.safeParse({
      filter: 'my-test',
    });
    expect(parsed.success).toBe(true);
  });

  it('status-query schema accepts empty input', () => {
    const tool = registry.get('status-query')!;
    const parsed = tool.definition.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('status-query schema accepts pattern', () => {
    const tool = registry.get('status-query')!;
    const parsed = tool.definition.inputSchema.safeParse({
      pattern: 'loom/ratchet-*',
    });
    expect(parsed.success).toBe(true);
  });
});
