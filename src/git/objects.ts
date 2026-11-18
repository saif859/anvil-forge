// The git object model: SHA-1 ids exactly as git computes them, and the commit, tree and tag formats.

import { createHash } from 'node:crypto';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const OID_RE = /^[0-9a-f]{40}$/;

export const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: readonly (ObjectType | undefined)[] = [undefined, 'commit', 'tree', 'blob', 'tag'];

export function hashObject(type: ObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'latin1').update(data).digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.toString('latin1', at, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

/** git's tree order: bytewise by name, a directory compared as if its name ended in '/'. */
function treeKey(entry: TreeEntry): Buffer {
  return Buffer.from(isTreeMode(entry.mode) ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${isTreeMode(entry.mode) ? '40000' : entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface Signature {
  readonly name: string;
  readonly email: string;
  /** Unix seconds. */
  readonly time: number;
  readonly tz: string;
}

export interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
}

export function parseSignature(text: string): Signature {
  const match = /^(.*?) <([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', time: 0, tz: '+0000' };
  return { name: match[1] as string, email: match[2] as string, time: Number(match[3]), tz: match[4] as string };
}

export function formatSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.time} ${sig.tz}`;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!OID_RE.test(tree)) throw new Error('commit has no tree');
  return {
    tree,
    parents,
    author: parseSignature(author),
    committer: parseSignature(committer),
    message: blank < 0 ? '' : text.slice(blank + 2),
  };
}

export function buildCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatSignature(commit.author)}`, `committer ${formatSignature(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface Tag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly message: string;
}

export function parseTag(data: Buffer): Tag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of (blank < 0 ? text : text.slice(0, blank)).split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    message: blank < 0 ? '' : text.slice(blank + 2),
  };
}
