// git smart HTTP: info/refs, upload-pack (protocol v2's ls-refs and fetch, with v0 kept for old clients) and
// receive-pack (v0, report-status in side-band-64k). Answers that depend only on a repository's refs and the
// request bytes are memoised per ref version, so 50 identical shallow clones cost one pack build.

import type { Reply, Request } from '../http.ts';
import type { Repo, Store } from '../store.ts';
import { ZERO_OID, OID_RE, isTreeMode, type GitObject } from './objects.ts';
import { readPack, writePack, type PackInput } from './pack.ts';

const AGENT = 'agent=anvil/1.0';
const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');
const MAX_SIDEBAND_DATA = 65515;

const UPLOAD_V0_CAPS = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 ${AGENT}`;
const RECEIVE_CAPS = `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 ${AGENT}`;

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, data]);
}

function pktText(payload: string): string {
  return `${(Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0')}${payload}`;
}

const V2_ADVERTISEMENT = Buffer.from(
  [
    pktText('version 2\n'),
    pktText(`${AGENT}\n`),
    pktText('ls-refs=unborn\n'),
    pktText('fetch=shallow\n'),
    pktText('server-option\n'),
    pktText('object-format=sha1\n'),
    '0000',
  ].join(''),
  'latin1',
);

type Packet = Buffer | 'flush' | 'delim' | 'end';

/** Read pkt-lines from `body` at `start` until a flush (inclusive) or the end; throws on a malformed length. */
function readPackets(body: Buffer, start: number, stopAtFlush: boolean): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = start;
  while (at + 4 <= body.length) {
    const lengthText = body.toString('latin1', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error(`bad pkt-line length ${JSON.stringify(lengthText)}`);
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) {
      packets.push('flush');
      at += 4;
      if (stopAtFlush) return { packets, next: at };
      continue;
    }
    if (length === 1) {
      packets.push('delim');
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push('end');
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) throw new Error('truncated pkt-line');
    packets.push(body.subarray(at + 4, at + length));
    at += length;
  }
  if (at !== body.length && !stopAtFlush) throw new Error('trailing bytes after the last pkt-line');
  return { packets, next: at };
}

function line(packet: Packet): string {
  return typeof packet === 'string' ? '' : packet.toString('utf8').replace(/\n$/, '');
}

function gitReply(service: string, kind: 'advertisement' | 'result', body: Buffer | readonly Buffer[]): Reply {
  return {
    status: 200,
    head: `content-type: application/x-${service}-${kind}\r\ncache-control: no-cache\r\n`,
    body,
  };
}

function gitError(status: number, message: string): Reply {
  return { status, head: 'content-type: text/plain; charset=utf-8\r\n', body: `${message}\n` };
}

/** Wrap bytes as side-band-64k band-1 packets; the caller appends the closing flush. */
function sideband(band: number, data: Buffer, out: Buffer[]): void {
  for (let at = 0; at < data.length; at += MAX_SIDEBAND_DATA) {
    const piece = data.subarray(at, Math.min(data.length, at + MAX_SIDEBAND_DATA));
    const head = Buffer.alloc(5);
    head.write((piece.length + 5).toString(16).padStart(4, '0'), 0, 'latin1');
    head[4] = band;
    out.push(head, piece);
  }
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function infoRefs(store: Store, repo: Repo, service: string, v2: boolean): Reply {
  if (service === 'git-upload-pack' && v2) return gitReply(service, 'advertisement', V2_ADVERTISEMENT);
  const body = store.memo(repo, `adv:${service}`, () => {
    const lines: string[] = [pktText(`# service=${service}\n`), '0000'];
    const refs = sortedRefs(repo);
    const advertised: Array<[string, string]> = [];
    let caps: string;
    if (service === 'git-upload-pack') {
      const head = repo.refs.get(headTarget(repo));
      if (head !== undefined) advertised.push([head, 'HEAD']);
      for (const [name, oid] of refs) {
        advertised.push([oid, name]);
        const peeled = store.peel(oid);
        if (peeled !== oid) advertised.push([peeled, `${name}^{}`]);
      }
      caps = `${UPLOAD_V0_CAPS} symref=HEAD:${headTarget(repo)}`;
    } else {
      for (const [name, oid] of refs) advertised.push([oid, name]);
      caps = RECEIVE_CAPS;
    }
    if (advertised.length === 0) {
      lines.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      advertised.forEach(([oid, name], index) => lines.push(pktText(index === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`)));
    }
    lines.push('0000');
    return Buffer.from(lines.join(''), 'utf8');
  });
  return gitReply(service, 'advertisement', body);
}

// ---------------------------------------------------------------- object selection

interface Selection {
  readonly objects: PackInput[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly common: string[];
}

function walkTree(store: Store, treeOid: string, seen: Set<string>, onObject: (oid: string, object: GitObject, name: string) => void, name: string): void {
  const stack: Array<[string, string]> = [[treeOid, name]];
  while (stack.length > 0) {
    const [oid, entryName] = stack.pop() as [string, string];
    if (seen.has(oid)) continue;
    const object = store.object(oid);
    if (object === undefined) continue;
    seen.add(oid);
    onObject(oid, object, entryName);
    if (object.type !== 'tree') continue;
    const entries = store.tree(oid) ?? [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as { mode: string; name: string; oid: string };
      if (entry.mode === '160000') continue;
      stack.push([entry.oid, entry.name]);
    }
  }
}

/**
 * What a fetch must send: the commits the wants reach that the client lacks (cut at `depth` when deepening),
 * with their trees and blobs minus everything the client's haves already reach. The client's own shallow
 * boundary bounds what its haves reach.
 */
function select(store: Store, repo: Repo, wants: readonly string[], haves: readonly string[], clientShallow: ReadonlySet<string>, depth: number | null, includeTag: boolean): Selection {
  const hasCommits = new Set<string>();
  const hasObjects = new Set<string>();
  const common: string[] = [];
  const stack: string[] = [];
  for (const have of haves) {
    if (store.commit(have) !== undefined) {
      common.push(have);
      stack.push(have);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (hasCommits.has(oid)) continue;
    const commit = store.commit(oid);
    if (commit === undefined) continue;
    hasCommits.add(oid);
    hasObjects.add(oid);
    walkTree(store, commit.tree, hasObjects, () => undefined, '');
    if (!clientShallow.has(oid)) for (const parent of commit.parents) stack.push(parent);
  }

  const tags: string[] = [];
  const directs: string[] = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    let oid = want;
    for (let depthGuard = 0; depthGuard < 16; depthGuard += 1) {
      const object = store.object(oid);
      if (object === undefined) break;
      if (object.type === 'tag') {
        if (!hasObjects.has(oid) && !tags.includes(oid)) tags.push(oid);
        const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('latin1'))?.[1];
        if (target === undefined) break;
        oid = target;
        continue;
      }
      if (object.type === 'commit') wantCommits.push(oid);
      else if (!hasObjects.has(oid)) directs.push(oid);
      break;
    }
  }

  const sendCommits: string[] = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    const seen = new Set<string>();
    const queue = [...wantCommits];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid) || hasCommits.has(oid)) continue;
      seen.add(oid);
      const commit = store.commit(oid);
      if (commit === undefined) continue;
      sendCommits.push(oid);
      for (const parent of commit.parents) queue.push(parent);
    }
  } else {
    const level = new Map<string, number>();
    const queue: string[] = [];
    for (const oid of wantCommits) {
      if (!level.has(oid)) {
        level.set(oid, 1);
        queue.push(oid);
      }
    }
    const boundary = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head] as string;
      const commit = store.commit(oid);
      if (commit === undefined) continue;
      const at = level.get(oid) as number;
      if (!hasCommits.has(oid)) sendCommits.push(oid);
      if (at >= depth) {
        if (commit.parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of commit.parents) {
        if (level.has(parent)) continue;
        level.set(parent, at + 1);
        queue.push(parent);
      }
    }
    for (const oid of queue) if (boundary.has(oid) && !clientShallow.has(oid)) shallow.push(oid);
    for (const oid of clientShallow) if (level.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }

  if (includeTag) {
    const sent = new Set(sendCommits);
    for (const [name, oid] of sortedRefs(repo)) {
      if (!name.startsWith('refs/tags/') || tags.includes(oid) || hasObjects.has(oid)) continue;
      const object = store.object(oid);
      if (object?.type === 'tag' && sent.has(store.peel(oid))) tags.push(oid);
    }
  }

  // Order: commits, tags, trees, blobs; blobs grouped by name, larger first, each a delta candidate against
  // the previous blob of the same name.
  const objects: PackInput[] = [];
  const sentObjects = new Set<string>(hasObjects);
  const trees: PackInput[] = [];
  const blobs: Array<{ oid: string; object: GitObject; name: string }> = [];
  for (const oid of sendCommits) {
    const object = store.object(oid) as GitObject;
    sentObjects.add(oid);
    objects.push({ oid, object });
  }
  for (const oid of tags) {
    sentObjects.add(oid);
    objects.push({ oid, object: store.object(oid) as GitObject });
  }
  const collect = (oid: string, object: GitObject, name: string): void => {
    if (object.type === 'tree') trees.push({ oid, object });
    else if (object.type === 'blob') blobs.push({ oid, object, name });
  };
  for (const oid of sendCommits) walkTree(store, (store.commit(oid) as { tree: string }).tree, sentObjects, collect, '');
  for (const oid of directs) walkTree(store, oid, sentObjects, collect, '');
  objects.push(...trees);
  blobs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : b.object.data.length - a.object.data.length || (a.oid < b.oid ? -1 : 1)));
  let previous: { oid: string; name: string } | null = null;
  for (const blob of blobs) {
    const delta = previous !== null && previous.name === blob.name && blob.object.data.length >= 512 ? previous.oid : undefined;
    objects.push(delta === undefined ? { oid: blob.oid, object: blob.object } : { oid: blob.oid, object: blob.object, deltaBase: delta });
    previous = { oid: blob.oid, name: blob.name };
  }
  return { objects, shallow, unshallow, common };
}

function packBytes(store: Store, objects: readonly PackInput[], deltas: boolean): Buffer {
  const inputs = deltas ? objects : objects.map((input) => ({ oid: input.oid, object: input.object }));
  return Buffer.concat(writePack(inputs, (oid, object) => store.deflatedOf(oid, object)));
}

function wantsAreOurs(store: Store, wants: readonly string[]): string | null {
  for (const want of wants) {
    if (!OID_RE.test(want) || store.object(want) === undefined) return want;
  }
  return null;
}

// ---------------------------------------------------------------- upload-pack

export function uploadPack(store: Store, repo: Repo, request: Request): Reply {
  const v2 = (request.headers['git-protocol'] ?? '').includes('version=2');
  const key = `up:${v2 ? 2 : 0}:${request.body.toString('latin1')}`;
  try {
    const body = store.memo(repo, key, () => (v2 ? uploadPackV2(store, repo, request.body) : uploadPackV0(store, repo, request.body)));
    return gitReply('git-upload-pack', 'result', body);
  } catch (err) {
    return gitError(400, `upload-pack: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function uploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer[] {
  const { packets } = readPackets(body, 0, false);
  let command = '';
  let index = 0;
  for (; index < packets.length; index += 1) {
    const packet = packets[index] as Packet;
    if (packet === 'delim' || packet === 'flush') break;
    const text = line(packet);
    if (text.startsWith('command=')) command = text.slice(8);
  }
  const args: string[] = [];
  if (packets[index] === 'delim') {
    for (index += 1; index < packets.length; index += 1) {
      const packet = packets[index] as Packet;
      if (packet === 'flush') break;
      if (typeof packet !== 'string') args.push(line(packet));
    }
  }
  if (command === 'ls-refs') return [lsRefs(store, repo, args)];
  if (command === 'fetch') return fetchV2(store, repo, args);
  if (command === '') return [FLUSH];
  throw new Error(`unknown command ${JSON.stringify(command)}`);
}

function lsRefs(store: Store, repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice(11));
  const wanted = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const target = headTarget(repo);
  if (wanted('HEAD')) {
    const head = repo.refs.get(target);
    if (head !== undefined) out.push(pktText(`${head} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    else if (unborn) out.push(pktText(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!wanted(name)) continue;
    const peeled = peel ? store.peel(oid) : oid;
    out.push(pktText(`${oid} ${name}${peeled !== oid ? ` peeled:${peeled}` : ''}\n`));
  }
  out.push('0000');
  return Buffer.from(out.join(''), 'utf8');
}

function fetchV2(store: Store, repo: Repo, args: readonly string[]): Buffer[] {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let done = false;
  let includeTag = false;
  let ofsDelta = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Math.max(1, Number.parseInt(arg.slice(7), 10) || 1);
    else if (arg === 'done') done = true;
    else if (arg === 'include-tag') includeTag = true;
    else if (arg === 'ofs-delta') ofsDelta = true;
  }
  const missing = wantsAreOurs(store, wants);
  if (missing !== null) return [pkt(`ERR upload-pack: not our ref ${missing}\n`), FLUSH];
  const selection = select(store, repo, wants, haves, clientShallow, depth, includeTag);
  const out: Buffer[] = [];
  if (!done) {
    out.push(pkt('acknowledgments\n'));
    if (selection.common.length === 0) out.push(pkt('NAK\n'));
    for (const oid of selection.common) out.push(pkt(`ACK ${oid}\n`));
    out.push(pkt('ready\n'), DELIM);
  }
  if (depth !== null || clientShallow.size > 0) {
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      out.push(pkt('shallow-info\n'));
      for (const oid of selection.shallow) out.push(pkt(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) out.push(pkt(`unshallow ${oid}\n`));
      out.push(DELIM);
    }
  }
  out.push(pkt('packfile\n'));
  sideband(1, packBytes(store, selection.objects, ofsDelta), out);
  out.push(FLUSH);
  return out;
}

function uploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer[] {
  const first = readPackets(body, 0, true);
  const wants: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let caps = '';
  for (const packet of first.packets) {
    if (typeof packet === 'string') continue;
    const text = line(packet);
    if (text.startsWith('want ')) {
      const [oid, ...rest] = text.slice(5).split(' ');
      wants.push(oid as string);
      if (rest.length > 0) caps = rest.join(' ');
    } else if (text.startsWith('shallow ')) clientShallow.add(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Math.max(1, Number.parseInt(text.slice(7), 10) || 1);
  }
  const haves: string[] = [];
  if (first.next < body.length) {
    const second = readPackets(body, first.next, false);
    for (const packet of second.packets) {
      if (typeof packet === 'string') continue;
      const text = line(packet);
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  if (wants.length === 0) return [];
  const missing = wantsAreOurs(store, wants);
  if (missing !== null) return [pkt(`ERR upload-pack: not our ref ${missing}\n`)];
  const capList = caps.split(' ');
  const selection = select(store, repo, wants, haves, clientShallow, depth, capList.includes('include-tag'));
  const out: Buffer[] = [];
  if (depth !== null) {
    for (const oid of selection.shallow) out.push(pkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) out.push(pkt(`unshallow ${oid}\n`));
    out.push(FLUSH);
  }
  const last = selection.common[selection.common.length - 1];
  out.push(pkt(last === undefined ? 'NAK\n' : `ACK ${last}\n`));
  const pack = packBytes(store, selection.objects, capList.includes('ofs-delta'));
  if (capList.includes('side-band-64k') || capList.includes('side-band')) {
    sideband(1, pack, out);
    out.push(FLUSH);
  } else {
    out.push(pack);
  }
  return out;
}

// ---------------------------------------------------------------- receive-pack

interface Command {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length > 255) return false;
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock') || ref.includes('@{')) return false;
  return true;
}

export function receivePack(store: Store, repo: Repo, request: Request): Reply {
  const body = request.body;
  let commands: Command[] = [];
  let caps: string[] = [];
  let next = 0;
  try {
    const head = readPackets(body, 0, true);
    next = head.next;
    for (const packet of head.packets) {
      if (typeof packet === 'string') continue;
      let text = packet.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        caps = text.slice(nul + 1).replace(/\n$/, '').split(' ').filter((cap) => cap !== '');
        text = text.slice(0, nul);
      }
      text = text.replace(/\n$/, '');
      if (text.startsWith('shallow ')) continue;
      const [oldOid, newOid, ref] = text.split(' ');
      if (oldOid === undefined || newOid === undefined || ref === undefined || !OID_RE.test(oldOid) || !OID_RE.test(newOid)) {
        throw new Error(`bad command ${JSON.stringify(text.slice(0, 120))}`);
      }
      commands.push({ oldOid, newOid, ref });
    }
    if (caps.includes('push-options') && next < body.length && body.toString('latin1', next, next + 4) !== 'PACK') {
      next = readPackets(body, next, true).next;
    }
  } catch (err) {
    return gitError(400, `receive-pack: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (commands.length === 0) return gitReply('git-receive-pack', 'result', FLUSH);

  let unpack = 'ok';
  if (next < body.length) {
    try {
      const objects = readPack(body.subarray(next), (oid) => store.object(oid));
      for (const object of objects) store.putObject(object.type, object.data, object.oid);
    } catch (err) {
      unpack = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
    }
  }

  const results: Array<{ ref: string; error: string | null }> = [];
  const updates: Array<[string, string | null]> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let error: string | null = null;
    if (unpack !== 'ok') error = 'unpacker error';
    else if (!validRefName(command.ref)) error = 'funny refname';
    else if (command.oldOid !== current) error = current === ZERO_OID ? 'stale info' : 'fetch first';
    else if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) error = 'no such ref';
      else if (command.ref === headTarget(repo) && repo.refs.size > 1) error = 'refusing to delete the current branch';
    } else if (store.object(command.newOid) === undefined) {
      error = 'missing necessary objects';
    } else if (current !== ZERO_OID) {
      const from = store.peel(current);
      const to = store.peel(command.newOid);
      if (store.commit(from) === undefined || store.commit(to) === undefined || !store.isAncestor(from, to)) error = 'non-fast-forward';
    } else if (command.ref.startsWith('refs/heads/') && store.commit(command.newOid) === undefined) {
      error = 'not a commit';
    }
    results.push({ ref: command.ref, error });
    if (error === null) updates.push([command.ref, command.newOid === ZERO_OID ? null : command.newOid]);
  }
  if (caps.includes('atomic') && results.some((result) => result.error !== null)) {
    for (const result of results) if (result.error === null) result.error = 'atomic push failed';
    updates.length = 0;
  }
  store.setRefs(repo, updates);

  const report: string[] = [pktText(`unpack ${unpack}\n`)];
  for (const result of results) report.push(pktText(result.error === null ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.error}\n`));
  report.push('0000');
  const reportBytes = Buffer.from(report.join(''), 'utf8');
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    const out: Buffer[] = [];
    sideband(1, reportBytes, out);
    out.push(FLUSH);
    return gitReply('git-receive-pack', 'result', out);
  }
  return gitReply('git-receive-pack', 'result', reportBytes);
}

/** Whether a tree entry mode names a directory (re-exported for the contents API). */
export const isDirectory = isTreeMode;
