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
