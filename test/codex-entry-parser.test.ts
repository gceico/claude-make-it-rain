'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import { parseCodexLine } from '../src/lib/codex-entry-parser';

const ts = '2026-07-29T10:00:00.000Z';

test('parses session_meta into sessionId + hashed projectKey', () => {
  const rec = parseCodexLine(
    JSON.stringify({
      type: 'session_meta',
      timestamp: ts,
      payload: { id: 'sess-1', cwd: '/home/me/project' },
    })
  );
  assert.ok(rec && rec.kind === 'session_meta');
  assert.strictEqual(rec.sessionId, 'sess-1');
  // projectKey is a hash, never the raw path.
  assert.ok(rec.projectKey && rec.projectKey.length === 16);
  assert.ok(!JSON.stringify(rec).includes('/home/me/project'));
});

test('parses turn_context model', () => {
  const rec = parseCodexLine(
    JSON.stringify({
      type: 'turn_context',
      timestamp: ts,
      payload: { model: 'gpt-5-codex', cwd: '/x' },
    })
  );
  assert.ok(rec && rec.kind === 'turn_context');
  assert.strictEqual(rec.model, 'gpt-5-codex');
});

test('parses token_count from info.total_token_usage (input includes cached)', () => {
  const rec = parseCodexLine(
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            output_tokens: 200,
            reasoning_output_tokens: 50,
            total_tokens: 1200,
          },
          last_token_usage: { input_tokens: 10 },
        },
      },
    })
  );
  assert.ok(rec && rec.kind === 'token_count');
  assert.strictEqual(rec.total.inputTokens, 1000);
  assert.strictEqual(rec.total.cachedInputTokens, 400);
  // output already includes reasoning tokens; we keep it as-is (no double add).
  assert.strictEqual(rec.total.outputTokens, 200);
});

test('token_count with null info is skipped', () => {
  const rec = parseCodexLine(
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'token_count', info: null },
    })
  );
  assert.strictEqual(rec, null);
});

test('parses a user message response_item into length-only (text discarded)', () => {
  const rec = parseCodexLine(
    JSON.stringify({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello world' },
          { type: 'input_image', image_url: 'x' },
        ],
      },
    })
  );
  assert.ok(rec && rec.kind === 'user_turn');
  assert.strictEqual(rec.userTextLength, 'hello world'.length);
  assert.ok(!JSON.stringify(rec).includes('hello world'));
});

test('assistant message response_item is ignored', () => {
  const rec = parseCodexLine(
    JSON.stringify({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }],
      },
    })
  );
  assert.strictEqual(rec, null);
});

test('non-token_count event_msg and malformed lines return null', () => {
  assert.strictEqual(
    parseCodexLine(
      JSON.stringify({
        type: 'event_msg',
        timestamp: ts,
        payload: { type: 'agent_message', message: 'x' },
      })
    ),
    null
  );
  assert.strictEqual(parseCodexLine('not json'), null);
  assert.strictEqual(
    parseCodexLine(JSON.stringify({ type: 'whatever' })),
    null
  );
});
