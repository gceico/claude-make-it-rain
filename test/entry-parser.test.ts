'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import { parseUsageEntry, hashProjectKey } from '../src/lib/entry-parser';

const NOW_ISO = new Date(2026, 5, 15, 12, 0, 0).toISOString();

test('assistant entry: sessionId + projectKey (hash, not raw path)', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: NOW_ISO,
    requestId: 'r1',
    sessionId: 'session-abc',
    cwd: '/Users/me/secret-project',
    message: {
      id: 'm1',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed);
  assert.strictEqual(parsed!.kind, 'assistant');
  if (parsed!.kind !== 'assistant') throw new Error('unreachable');
  assert.strictEqual(parsed.sessionId, 'session-abc');
  assert.ok(parsed.projectKey, 'projectKey must be set');
  assert.notStrictEqual(
    parsed.projectKey,
    '/Users/me/secret-project',
    'projectKey must never be the raw path'
  );
  assert.strictEqual(
    parsed.projectKey,
    hashProjectKey('/Users/me/secret-project'),
    'projectKey must be the deterministic hash'
  );
});

test('assistant entry: sessionId/projectKey null when absent', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: NOW_ISO,
    requestId: 'r1',
    message: {
      id: 'm1',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed && parsed.kind === 'assistant');
  if (!parsed || parsed.kind !== 'assistant') throw new Error('unreachable');
  assert.strictEqual(parsed.sessionId, null);
  assert.strictEqual(parsed.projectKey, null);
});

test('hashProjectKey is deterministic and one-way (not reversible-looking)', () => {
  const a = hashProjectKey('/Users/me/project-a');
  const b = hashProjectKey('/Users/me/project-a');
  const c = hashProjectKey('/Users/me/project-b');
  assert.strictEqual(a, b, 'same input -> same hash');
  assert.notStrictEqual(a, c, 'different input -> different hash');
  assert.strictEqual(hashProjectKey(null), null);
  assert.strictEqual(hashProjectKey(''), null);
  assert.ok(a && !a.includes('/'), 'hash must not resemble a path');
});

test('user entry: userTextLength sums text blocks, discards content', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: NOW_ISO,
    sessionId: 's1',
    cwd: '/Users/me/proj',
    message: {
      content: [
        { type: 'text', text: 'hello world' }, // 11 chars
        { type: 'image', source: 'base64...' }, // ignored
        { type: 'text', text: 'more' }, // 4 chars
      ],
    },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed);
  assert.strictEqual(parsed!.kind, 'user');
  if (parsed!.kind !== 'user') throw new Error('unreachable');
  assert.strictEqual(parsed.userTextLength, 15);
  assert.strictEqual(parsed.sessionId, 's1');
  // The actual text must not appear anywhere on the parsed object.
  assert.ok(!JSON.stringify(parsed).includes('hello world'));
});

test('user entry: plain string content', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: NOW_ISO,
    message: { content: 'a giant paste'.repeat(100) },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed && parsed.kind === 'user');
  if (!parsed || parsed.kind !== 'user') throw new Error('unreachable');
  assert.strictEqual(parsed.userTextLength, 'a giant paste'.length * 100);
});

test('user entry: missing/malformed message -> null, never throws', () => {
  assert.strictEqual(
    parseUsageEntry(
      JSON.stringify({ type: 'user', timestamp: NOW_ISO, message: null })
    ),
    null
  );
  assert.strictEqual(
    parseUsageEntry(JSON.stringify({ type: 'user', timestamp: NOW_ISO })),
    null
  );
});

test('malformed lines still skipped (garbage JSON, missing timestamp, bad type)', () => {
  assert.strictEqual(parseUsageEntry('{ not json'), null);
  assert.strictEqual(
    parseUsageEntry(JSON.stringify({ type: 'assistant' })),
    null
  );
  assert.strictEqual(
    parseUsageEntry(JSON.stringify({ type: 'summary', timestamp: NOW_ISO })),
    null
  );
  assert.strictEqual(
    parseUsageEntry(
      JSON.stringify({ type: 'assistant', timestamp: 'not-a-date' })
    ),
    null
  );
});

test('user entry: toolUseResult.file yields fileRead with numLines + ext, never the path', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: NOW_ISO,
    sessionId: 's1',
    message: { content: 'tool result' },
    toolUseResult: {
      file: {
        filePath: '/Users/me/secret-project/src/big-module.ts',
        content: 'const x = 1;\n'.repeat(500),
        numLines: 500,
        startLine: 1,
        totalLines: 500,
      },
    },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed && parsed.kind === 'user');
  if (!parsed || parsed.kind !== 'user') throw new Error('unreachable');
  assert.ok(parsed.fileRead);
  assert.strictEqual(parsed.fileRead!.lines, 500);
  assert.strictEqual(parsed.fileRead!.totalLines, 500);
  assert.strictEqual(parsed.fileRead!.ext, '.ts');
  assert.ok(
    !JSON.stringify(parsed).includes('secret-project'),
    'the raw file path must never appear on the parsed object'
  );
  assert.ok(
    !JSON.stringify(parsed).includes('const x = 1'),
    'file content must never appear on the parsed object'
  );
});

test('user entry: a 499-line read does not look different from a 500-line one at parse time', () => {
  // The 500-line threshold is enforced by habits.ts/usage-monitor.ts, not the
  // parser — the parser just reports numLines as-is.
  const line = (numLines: number) =>
    JSON.stringify({
      type: 'user',
      timestamp: NOW_ISO,
      message: { content: 'tool result' },
      toolUseResult: {
        file: {
          filePath: '/x/y.py',
          numLines,
          startLine: 1,
          totalLines: numLines,
        },
      },
    });
  const p499 = parseUsageEntry(line(499));
  const p500 = parseUsageEntry(line(500));
  assert.ok(p499 && p499.kind === 'user' && p499.fileRead);
  assert.ok(p500 && p500.kind === 'user' && p500.fileRead);
  if (p499?.kind !== 'user' || p500?.kind !== 'user')
    throw new Error('unreachable');
  assert.strictEqual(p499.fileRead!.lines, 499);
  assert.strictEqual(p500.fileRead!.lines, 500);
});

test('user entry: no toolUseResult.file -> fileRead is null', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: NOW_ISO,
    message: { content: 'hi' },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed && parsed.kind === 'user');
  if (!parsed || parsed.kind !== 'user') throw new Error('unreachable');
  assert.strictEqual(parsed.fileRead, null);
});

test('projectDir carries the raw cwd in-memory only, alongside the hashed projectKey', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: NOW_ISO,
    requestId: 'r1',
    cwd: '/Users/me/secret-project',
    message: {
      id: 'm1',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed && parsed.kind === 'assistant');
  if (!parsed || parsed.kind !== 'assistant') throw new Error('unreachable');
  assert.strictEqual(parsed.projectDir, '/Users/me/secret-project');
  assert.strictEqual(parsed.projectKey, hashProjectKey(parsed.projectDir));
});

test('assistant entry still returns all pre-existing fields unchanged', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: NOW_ISO,
    requestId: 'r9',
    message: {
      id: 'm9',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 6,
      },
    },
  });
  const parsed = parseUsageEntry(line);
  assert.ok(parsed && parsed.kind === 'assistant');
  if (!parsed || parsed.kind !== 'assistant') throw new Error('unreachable');
  assert.strictEqual(parsed.key, 'r9:m9');
  assert.strictEqual(parsed.model, 'claude-opus-4-8');
  assert.strictEqual(parsed.inputTokens, 10);
  assert.strictEqual(parsed.outputTokens, 20);
  assert.strictEqual(parsed.usage.cacheReadInputTokens, 5);
  assert.strictEqual(parsed.usage.cacheCreationInputTokens, 6);
});
