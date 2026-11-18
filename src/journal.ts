// The append-only journal: one canonical JSON line per mutation, written in batches off the request path.
//
// ANVIL_DATA_DIR names a directory whose journal.ndjson is replayed at boot and appended to from then on, so
// the forge survives a restart. Without it the forge journals into a fresh private directory under the OS
// temp dir and replays nothing: a trial pod always starts empty, and two runs on one machine never see each
// other's data. A directory that cannot be written turns journalling off and the forge runs from memory.

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, write } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** JSON with object keys sorted at every depth: the same record always writes the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export type JournalRecord = Record<string, unknown> & { readonly e: string };

export class Journal {
  fd: number | null = null;
  path: string | null = null;
  queue: string[] = [];
  writing = false;
  replayed: JournalRecord[] = [];

  constructor(env: Readonly<Record<string, string | undefined>>) {
    const configured = env.ANVIL_DATA_DIR?.trim();
    try {
      let dir: string;
      if (configured !== undefined && configured !== '') {
        dir = configured;
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'journal.ndjson');
        if (existsSync(file)) this.replayed = Journal.read(file);
      } else {
        dir = mkdtempSync(join(tmpdir(), 'anvil-'));
      }
      this.path = join(dir, 'journal.ndjson');
      this.fd = openSync(this.path, 'a');
    } catch (err) {
      this.fd = null;
      process.stderr.write(`[anvil] journal off, running from memory (${err instanceof Error ? err.message : String(err)})\n`);
    }
  }

  static read(file: string): JournalRecord[] {
    const records: JournalRecord[] = [];
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        break; // a torn last line from a crash ends the replay
      }
    }
    return records;
  }

  append(record: JournalRecord): void {
    if (this.fd === null) return;
    this.queue.push(`${canonicalJson(record)}\n`);
    if (!this.writing) this.flush();
  }

  flush(): void {
    if (this.fd === null || this.queue.length === 0) {
      this.writing = false;
      return;
    }
    this.writing = true;
    const batch = this.queue.join('');
    this.queue = [];
    write(this.fd, batch, null, 'utf8', (err) => {
      if (err !== null) {
        process.stderr.write(`[anvil] journal write failed, journal off: ${err.message}\n`);
        this.close();
        return;
      }
      this.flush();
    });
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // already gone
    }
    this.fd = null;
    this.queue = [];
    this.writing = false;
  }
}
