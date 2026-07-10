'use strict';

import * as fs from 'fs';
import * as path from 'path';

export const DEFAULTS: Record<string, unknown> = { muted: false };

/**
 * Tiny JSON-backed preferences store. Reads once on construction and writes
 * synchronously on every change. Missing or corrupt files fall back to
 * DEFAULTS rather than throwing, so a bad config can never crash the app.
 *
 * The file is SHARED with other writers in this process — the leaderboard
 * client (lib/leaderboard-client.ts) persists gamerTag/telemetry keys to the
 * same config.json. `set()` therefore re-reads the file before writing, so a
 * mute toggle can never overwrite a newer gamer tag with a stale copy, and
 * `_load()`/`_save()` always carry unknown keys through untouched.
 */
export class Config {
  filePath: string;
  data: Record<string, unknown>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this._load();
  }

  _load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.data = { ...DEFAULTS, ...parsed };
      }
    } catch {
      // No file yet, or unreadable/corrupt — keep defaults.
    }
  }

  get(key: string): unknown {
    return this.data[key];
  }

  set(key: string, value: unknown): unknown {
    // Pick up keys another writer persisted since our last read (see class
    // doc) before layering our change on top and writing the merged result.
    this._load();
    this.data[key] = value;
    this._save();
    return value;
  }

  _save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.data, null, 2) + '\n'
      );
    } catch {
      // Best-effort persistence; a failed write shouldn't break the UI.
    }
  }
}
