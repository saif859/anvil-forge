// The forge's one store: git objects by id, refs per repository, and the GitHub records (repositories,
// issues, comments, labels, pull requests) every surface reads and writes. Git, REST, GraphQL and MCP all
// act on this object, so a change made through one is what the others see.
//
// Determinism: nothing here reads the wall clock or a random source. `tick()` is a logical clock that starts
// at the scenario epoch and advances one second per mutation; ids come from counters. The same requests in
// the same order build the same store, the same commit ids and the same JSON.

import { deflateSync } from 'node:zlib';
import type { Viewer } from './identity.ts';
import { Journal, type JournalRecord } from './journal.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isTreeMode,
  parseCommit,
  parseTag,
  parseTree,
  type Commit,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './git/objects.ts';

export const EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

export function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

export interface Label {
  readonly id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  readonly id: number;
  readonly repoId: number;
  readonly number: number;
  body: string;
  readonly createdAt: number;
  updatedAt: number;
}

export interface Issue {
  readonly kind: 'Issue';
  readonly id: number;
  readonly number: number;
  readonly repo: Repo;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: Label[];
  readonly comments: Comment[];
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** Bumped on every change: the key of the cached REST rendering. */
  rev: number;
  cache: { rev: number; body: string; etag: string } | null;
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly sha: string;
  readonly patch: string | null;
}

export interface Pull {
  readonly kind: 'PullRequest';
  readonly id: number;
  readonly number: number;
  readonly repo: Repo;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  readonly head: string;
  base: string;
  /** The tips at the moment of the merge (live tips are read from the refs while open). */
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: number | null;
  closedAt: number | null;
  readonly createdAt: number;
  updatedAt: number;
  labels: Label[];
  readonly comments: Comment[];
  /** Frozen at merge time; computed from the live tips while open. */
  files: PullFile[] | null;
  rev: number;
}

export interface Repo {
  readonly kind: 'Repository';
  readonly id: number;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  private: boolean;
  defaultBranch: string;
  hasIssues: boolean;
  readonly createdAt: number;
  updatedAt: number;
  pushedAt: number | null;
  readonly refs: Map<string, string>;
  /** Bumped on every ref change: the key of every cache that depends on the refs. */
  version: number;
  nextNumber: number;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  /** Per-repository caches keyed by `version`, cleared whenever it moves. */
  readonly memo: Map<string, unknown>;
  memoVersion: number;
}

export type Merge = { readonly ok: true; readonly tree: string } | { readonly ok: false; readonly conflicts: readonly string[] };

export class StoreError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface FlatEntry {
  readonly mode: string;
  readonly oid: string;
}

export class Store {
  readonly viewer: Viewer;
  readonly journal: Journal;
  clock = EPOCH_SEC;
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  nextLabelId = 1;
  readonly objects = new Map<string, GitObject>();
  readonly deflated = new Map<string, Buffer>();
  readonly commits = new Map<string, Commit>();
  readonly generations = new Map<string, number>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  replaying = false;

  constructor(viewer: Viewer, env: Readonly<Record<string, string | undefined>>) {
    this.viewer = viewer;
    this.journal = new Journal(env);
    if (this.journal.replayed.length > 0) this.replay(this.journal.replayed);
  }

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  log(record: JournalRecord): void {
    if (!this.replaying) this.journal.append({ ...record, at: this.clock });
  }

  // ------------------------------------------------------------ objects

  putObject(type: ObjectType, data: Buffer, known?: string): string {
    const oid = known ?? hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.log({ e: 'object', type, data: data.toString('base64') });
    }
    return oid;
  }

  object(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  deflatedOf(oid: string, object: GitObject): Buffer {
    let packed = this.deflated.get(oid);
    if (packed === undefined) {
      packed = deflateSync(object.data, { level: 1 });
      this.deflated.set(oid, packed);
    }
    return packed;
  }

  commit(oid: string): Commit | undefined {
    let parsed = this.commits.get(oid);
    if (parsed === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return undefined;
      parsed = parseCommit(object.data);
      this.commits.set(oid, parsed);
    }
    return parsed;
  }

  tree(oid: string): TreeEntry[] | undefined {
    let entries = this.trees.get(oid);
    if (entries === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return undefined;
      entries = parseTree(object.data);
      this.trees.set(oid, entries);
    }
    return entries;
  }

  /** A commit's generation (1 for a root): ancestry walks stop at commits older than their target. */
  generation(oid: string): number {
    const known = this.generations.get(oid);
    if (known !== undefined) return known;
    const stack = [oid];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as string;
      if (this.generations.has(top)) {
        stack.pop();
        continue;
      }
      const commit = this.commit(top);
      if (commit === undefined) {
        this.generations.set(top, 0);
        stack.pop();
        continue;
      }
      let ready = true;
      let best = 0;
      for (const parent of commit.parents) {
        const gen = this.generations.get(parent);
        if (gen === undefined) {
          ready = false;
          stack.push(parent);
        } else if (gen > best) best = gen;
      }
      if (ready) {
        this.generations.set(top, best + 1);
        stack.pop();
      }
    }
    return this.generations.get(oid) ?? 0;
  }

  /** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const floor = this.generation(ancestor);
    if (floor === 0) return false;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (this.generation(oid) <= floor) continue;
      for (const parent of this.commit(oid)?.parents ?? []) stack.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits, or null when their histories never meet. */
  mergeBase(a: string, b: string): string | null {
    if (this.isAncestor(a, b)) return a;
    if (this.isAncestor(b, a)) return b;
    const fromA = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      for (const parent of this.commit(oid)?.parents ?? []) stack.push(parent);
    }
    // Walk b's history newest generation first; the first commit a also reaches is the merge base.
    const frontier = [b];
    const seen = new Set<string>();
    while (frontier.length > 0) {
      frontier.sort((x, y) => this.generation(y) - this.generation(x) || (x < y ? -1 : 1));
      const oid = frontier.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (fromA.has(oid)) return oid;
      for (const parent of this.commit(oid)?.parents ?? []) frontier.push(parent);
    }
    return null;
  }

  /** Follow tags to the object they name. */
  peel(oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  // ------------------------------------------------------------ trees

  /** The entry at `path` in a tree, or null. '' is the tree itself. */
  entryAt(treeOid: string, path: string): FlatEntry | null {
    if (path === '') return { mode: '40000', oid: treeOid };
    let current = treeOid;
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.tree(current);
      if (entries === undefined) return null;
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
      if (!isTreeMode(entry.mode)) return null;
      current = entry.oid;
    }
    return null;
  }

  /** A tree with `path` set to `entry` (or removed when null); empty directories disappear. */
  withPath(treeOid: string | null, segments: readonly string[], entry: FlatEntry | null): string | null {
    const entries = treeOid === null ? [] : [...(this.tree(treeOid) ?? [])];
    const [head, ...rest] = segments;
    if (head === undefined) return treeOid;
    const index = entries.findIndex((candidate) => candidate.name === head);
    if (rest.length === 0) {
      if (index >= 0) entries.splice(index, 1);
      if (entry !== null) entries.push({ mode: entry.mode, name: head, oid: entry.oid });
    } else {
      const existing = index >= 0 ? entries[index] : undefined;
      const child = this.withPath(existing !== undefined && isTreeMode(existing.mode) ? existing.oid : null, rest, entry);
      if (index >= 0) entries.splice(index, 1);
      if (child !== null) entries.push({ mode: '40000', name: head, oid: child });
    }
    if (entries.length === 0) return null;
    return this.putObject('tree', buildTree(entries));
  }

  /** Every file of a tree by its full path. */
  flatten(treeOid: string | null, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
    if (treeOid === null) return out;
    for (const entry of this.tree(treeOid) ?? []) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isTreeMode(entry.mode)) this.flatten(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Build the nested trees for a flat path map; null for an empty map. */
  treeFromFlat(files: ReadonlyMap<string, FlatEntry>): string | null {
    interface Dir {
      files: TreeEntry[];
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let dir = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        let child = dir.dirs.get(name);
        if (child === undefined) {
          child = { files: [], dirs: new Map() };
          dir.dirs.set(name, child);
        }
        dir = child;
      }
      dir.files.push({ mode: entry.mode, name: segments[segments.length - 1] as string, oid: entry.oid });
    }
    const build = (dir: Dir): string => {
      const entries = [...dir.files];
      for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return files.size === 0 ? null : build(root);
  }

  emptyTree(): string {
    return this.putObject('tree', Buffer.alloc(0));
  }

  /** A three-way merge at file level: each path takes the side that changed it; both changing it differently conflicts. */
  mergeTrees(baseTree: string | null, oursTree: string, theirsTree: string): Merge {
    const base = this.flatten(baseTree);
    const ours = this.flatten(oursTree);
    const theirs = this.flatten(theirsTree);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = new Map<string, FlatEntry>();
    const conflicts: string[] = [];
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
      x === undefined ? y === undefined : y !== undefined && x.oid === y.oid && x.mode === y.mode;
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      let pick: FlatEntry | undefined;
      if (same(o, t)) pick = o;
      else if (same(b, o)) pick = t;
      else if (same(b, t)) pick = o;
      else {
        conflicts.push(path);
        continue;
      }
      if (pick !== undefined) merged.set(path, pick);
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    return { ok: true, tree: this.treeFromFlat(merged) ?? this.emptyTree() };
  }

  // ------------------------------------------------------------ commits the forge makes

  signature(): { name: string; email: string; time: number; tz: string } {
    return { name: this.viewer.name, email: this.viewer.email, time: this.clock, tz: '+0000' };
  }

  makeCommit(tree: string, parents: readonly string[], message: string): string {
    this.tick();
    const signature = this.signature();
    const body = message.endsWith('\n') ? message : `${message}\n`;
    return this.putObject('commit', buildCommit({ tree, parents, author: signature, committer: signature, message: body }));
  }

  // ------------------------------------------------------------ repositories

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string | null; private?: boolean; homepage?: string | null; hasIssues?: boolean; defaultBranch?: string; autoInit?: boolean }): Repo {
    if (this.findRepo(owner, name) !== undefined) throw new StoreError(422, 'name already exists on this account');
    const now = this.tick();
    const repo: Repo = {
      kind: 'Repository',
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? null,
      homepage: options.homepage ?? null,
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      hasIssues: options.hasIssues ?? true,
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      refs: new Map(),
      version: 0,
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      memo: new Map(),
      memoVersion: 0,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    this.reposById.set(repo.id, repo);
    this.logRepo(repo);
    if (options.autoInit === true) {
      const blob = this.putObject('blob', Buffer.from(`# ${name}\n${options.description ? `\n${options.description}\n` : ''}`, 'utf8'));
      const tree = this.putObject('tree', buildTree([{ mode: '100644', name: 'README.md', oid: blob }]));
      this.setRefs(repo, [[`refs/heads/${repo.defaultBranch}`, this.makeCommit(tree, [], 'Initial commit')]]);
    }
    return repo;
  }

  logRepo(repo: Repo): void {
    this.log({
      e: 'repo',
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      description: repo.description,
      homepage: repo.homepage,
      private: repo.private,
      defaultBranch: repo.defaultBranch,
      hasIssues: repo.hasIssues,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
      pushedAt: repo.pushedAt,
      nextNumber: repo.nextNumber,
    });
  }

  updateRepo(repo: Repo, changes: { name?: string; description?: string | null; homepage?: string | null; private?: boolean; defaultBranch?: string; hasIssues?: boolean }): void {
    if (changes.name !== undefined && changes.name.toLowerCase() !== repo.name.toLowerCase()) {
      if (this.findRepo(repo.owner, changes.name) !== undefined) throw new StoreError(422, 'name already exists on this account');
      this.repos.delete(this.repoKey(repo.owner, repo.name));
      repo.name = changes.name;
      this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    } else if (changes.name !== undefined) {
      repo.name = changes.name;
    }
    if (changes.description !== undefined) repo.description = changes.description;
    if (changes.homepage !== undefined) repo.homepage = changes.homepage;
    if (changes.private !== undefined) repo.private = changes.private;
    if (changes.hasIssues !== undefined) repo.hasIssues = changes.hasIssues;
    if (changes.defaultBranch !== undefined) repo.defaultBranch = changes.defaultBranch;
    repo.updatedAt = this.tick();
    this.touchIssues(repo);
    this.logRepo(repo);
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.id);
    this.tick();
    this.log({ e: 'repo-delete', id: repo.id });
  }

  /** Every cached issue rendering embeds repository fields: a repository change invalidates them. */
  touchIssues(repo: Repo): void {
    for (const issue of repo.issues.values()) issue.rev += 1;
  }

  /** A per-repository memo slot, dropped whenever the refs move. */
  memo<T>(repo: Repo, key: string, make: () => T): T {
    if (repo.memoVersion !== repo.version) {
      repo.memo.clear();
      repo.memoVersion = repo.version;
    }
    if (repo.memo.has(key)) return repo.memo.get(key) as T;
    const value = make();
    if (repo.memo.size > 256) repo.memo.clear();
    repo.memo.set(key, value);
    return value;
  }

  /** Apply ref updates (oid null deletes). The default branch follows the first branch an empty repo gets. */
  setRefs(repo: Repo, updates: ReadonlyArray<readonly [string, string | null]>): void {
    if (updates.length === 0) return;
    const wasEmpty = repo.refs.size === 0;
    for (const [ref, oid] of updates) {
      if (oid === null || oid === ZERO_OID) repo.refs.delete(ref);
      else repo.refs.set(ref, oid);
    }
    if (wasEmpty && !repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
      const firstBranch = updates.find(([ref, oid]) => ref.startsWith('refs/heads/') && oid !== null && oid !== ZERO_OID);
      if (firstBranch !== undefined) repo.defaultBranch = firstBranch[0].slice('refs/heads/'.length);
    }
    repo.version += 1;
    repo.pushedAt = this.tick();
    this.log({ e: 'refs', repo: repo.id, set: updates.map(([ref, oid]) => [ref, oid]), defaultBranch: repo.defaultBranch });
  }

  /** A branch name, tag name, full ref or commit id, resolved to a commit id. */
  resolveRef(repo: Repo, name: string | undefined): string | null {
    const wanted = name === undefined || name === '' ? repo.defaultBranch : name;
    for (const candidate of [wanted, `refs/heads/${wanted}`, `refs/tags/${wanted}`]) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) return this.peel(oid);
    }
    if (/^[0-9a-f]{40}$/i.test(wanted) && this.commit(wanted.toLowerCase()) !== undefined) return wanted.toLowerCase();
    return null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Commits reachable from `tip`, children before parents, newest committer time first among the ready. */
  history(tip: string, limit: number): string[] {
    const reachable: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && reachable.length < 50_000) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const commit = this.commit(oid);
      if (commit === undefined) continue;
      seen.add(oid);
      reachable.push(oid);
      for (const parent of commit.parents) stack.push(parent);
    }
    const children = new Map<string, number>();
    for (const oid of reachable) {
      for (const parent of this.commit(oid)?.parents ?? []) if (seen.has(parent)) children.set(parent, (children.get(parent) ?? 0) + 1);
    }
    const out: string[] = [];
    const ready = [tip];
    while (ready.length > 0 && out.length < limit) {
      let best = 0;
      for (let i = 1; i < ready.length; i += 1) {
        const a = this.commit(ready[i] as string)?.committer.time ?? 0;
        const b = this.commit(ready[best] as string)?.committer.time ?? 0;
        if (a > b || (a === b && (ready[i] as string) < (ready[best] as string))) best = i;
      }
      const oid = ready.splice(best, 1)[0] as string;
      out.push(oid);
      for (const parent of this.commit(oid)?.parents ?? []) {
        if (!seen.has(parent)) continue;
        const left = (children.get(parent) ?? 1) - 1;
        children.set(parent, left);
        if (left === 0) ready.push(parent);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ labels, issues, comments

  createLabel(repo: Repo, name: string, color: string, description: string | null): Label {
    if (repo.labels.has(name.toLowerCase())) throw new StoreError(422, 'Validation Failed');
    const label: Label = { id: this.nextLabelId++, name, color, description };
    repo.labels.set(name.toLowerCase(), label);
    this.tick();
    this.log({ e: 'label', repo: repo.id, id: label.id, name, color, description });
    return label;
  }

  resolveLabels(repo: Repo, names: readonly string[]): Label[] {
    const labels: Label[] = [];
    for (const name of names) {
      const label = repo.labels.get(name.toLowerCase());
      if (label === undefined) throw new StoreError(422, `Validation Failed: the label ${JSON.stringify(name)} does not exist`);
      if (!labels.includes(label)) labels.push(label);
    }
    return labels;
  }

  createIssue(repo: Repo, input: { title: string; body: string | null; labels: Label[] }): Issue {
    const now = this.tick();
    const issue: Issue = {
      kind: 'Issue',
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      repo,
      title: input.title,
      body: input.body,
      state: 'open',
      stateReason: null,
      labels: input.labels,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      rev: 0,
      cache: null,
    };
    repo.issues.set(issue.number, issue);
    this.logIssue(issue);
    return issue;
  }

  logIssue(issue: Issue): void {
    this.log({
      e: 'issue',
      repo: issue.repo.id,
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      labels: issue.labels.map((label) => label.id),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      closedAt: issue.closedAt,
    });
  }

  updateIssue(issue: Issue, changes: { title?: string; body?: string | null; state?: 'open' | 'closed'; stateReason?: string | null; labels?: Label[] }): void {
    const now = this.tick();
    if (changes.title !== undefined) issue.title = changes.title;
    if (changes.body !== undefined) issue.body = changes.body;
    if (changes.labels !== undefined) issue.labels = changes.labels;
    if (changes.state !== undefined && changes.state !== issue.state) {
      issue.state = changes.state;
      issue.closedAt = changes.state === 'closed' ? now : null;
      issue.stateReason = changes.state === 'closed' ? changes.stateReason ?? 'completed' : changes.stateReason ?? 'reopened';
    } else if (changes.stateReason !== undefined) {
      issue.stateReason = changes.stateReason;
    }
    issue.updatedAt = now;
    issue.rev += 1;
    this.logIssue(issue);
  }

  addComment(repo: Repo, target: Issue | Pull, body: string): Comment {
    const now = this.tick();
    const comment: Comment = { id: this.nextCommentId++, repoId: repo.id, number: target.number, body, createdAt: now, updatedAt: now };
    target.comments.push(comment);
    target.updatedAt = now;
    target.rev += 1;
    this.log({ e: 'comment', repo: repo.id, number: target.number, id: comment.id, body, createdAt: now });
    return comment;
  }

  findComment(repo: Repo, id: number): { comment: Comment; target: Issue | Pull } | null {
    for (const issue of repo.issues.values()) {
      const comment = issue.comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) return { comment, target: issue };
    }
    for (const pull of repo.pulls.values()) {
      const comment = pull.comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) return { comment, target: pull };
    }
    return null;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, input: { title: string; body: string | null; head: string; base: string; draft: boolean }): Pull {
    const headSha = this.branchTip(repo, input.head);
    const baseSha = this.branchTip(repo, input.base);
    if (headSha === null || baseSha === null) throw new StoreError(422, 'Validation Failed');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === input.head && pull.base === input.base) {
        throw new StoreError(422, `A pull request already exists for ${repo.owner}:${input.head}.`);
      }
    }
    const now = this.tick();
    const pull: Pull = {
      kind: 'PullRequest',
      id: this.nextPullId++,
      number: repo.nextNumber++,
      repo,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      draft: input.draft,
      head: input.head,
      base: input.base,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
      labels: [],
      comments: [],
      files: null,
      rev: 0,
    };
    repo.pulls.set(pull.number, pull);
    this.logPull(pull);
    return pull;
  }

  logPull(pull: Pull): void {
    this.log({
      e: 'pull',
      repo: pull.repo.id,
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      draft: pull.draft,
      head: pull.head,
      base: pull.base,
      headSha: pull.headSha,
      baseSha: pull.baseSha,
      mergeCommitSha: pull.mergeCommitSha,
      mergedAt: pull.mergedAt,
      closedAt: pull.closedAt,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
      files: pull.files,
    });
  }

  /** The tips an open pull compares (live), or the frozen tips of a closed one. */
  pullTips(pull: Pull): { head: string; base: string } {
    if (pull.state === 'open') {
      return { head: this.branchTip(pull.repo, pull.head) ?? pull.headSha, base: this.branchTip(pull.repo, pull.base) ?? pull.baseSha };
    }
    return { head: pull.headSha, base: pull.baseSha };
  }

  pullFiles(pull: Pull): PullFile[] {
    if (pull.files !== null) return pull.files;
    const tips = this.pullTips(pull);
    return this.memo(pull.repo, `files:${tips.base}:${tips.head}`, () => {
      const base = this.mergeBase(tips.base, tips.head);
      const baseTree = base === null ? null : this.commit(base)?.tree ?? null;
      const headTree = this.commit(tips.head)?.tree ?? null;
      return this.diffTrees(baseTree, headTree);
    });
  }

  diffTrees(fromTree: string | null, toTree: string | null): PullFile[] {
    const before = this.flatten(fromTree);
    const after = this.flatten(toTree);
    const files: PullFile[] = [];
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const path of paths) {
      const a = before.get(path);
      const b = after.get(path);
      if (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode) continue;
      const oldText = a === undefined ? '' : this.objects.get(a.oid)?.data.toString('utf8') ?? '';
      const newText = b === undefined ? '' : this.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const counts = lineChanges(oldText, newText);
      files.push({
        filename: path,
        status: a === undefined ? 'added' : b === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        sha: (b ?? a)?.oid ?? ZERO_OID,
        patch: a === undefined ? addedPatch(newText) : null,
      });
    }
    return files;
  }

  /** What merging a pull would produce right now: the merged tree, or the conflicting paths. */
  pullMerge(pull: Pull): Merge {
    const tips = this.pullTips(pull);
    return this.memo(pull.repo, `merge:${tips.base}:${tips.head}`, () => {
      const base = this.mergeBase(tips.base, tips.head);
      const headTree = this.commit(tips.head)?.tree ?? this.emptyTree();
      const baseTree = this.commit(tips.base)?.tree ?? this.emptyTree();
      if (base === tips.base) return { ok: true, tree: headTree } as Merge;
      if (base === tips.head) return { ok: true, tree: baseTree } as Merge;
      return this.mergeTrees(base === null ? null : this.commit(base)?.tree ?? null, baseTree, headTree);
    });
  }

  mergePull(pull: Pull, method: 'merge' | 'squash' | 'rebase', title: string | undefined, message: string | undefined): string {
    const tips = this.pullTips(pull);
    const merge = this.pullMerge(pull);
    if (!merge.ok) throw new StoreError(405, 'Pull Request is not mergeable');
    const files = this.pullFiles(pull);
    let sha: string;
    if (method === 'rebase' && this.isAncestor(tips.base, tips.head)) {
      sha = tips.head;
    } else if (method === 'merge') {
      const headline = title ?? `Merge pull request #${pull.number} from ${pull.repo.owner}/${pull.head}`;
      sha = this.makeCommit(merge.tree, [tips.base, tips.head], `${headline}\n\n${message ?? pull.title}`);
    } else {
      const headline = title ?? `${pull.title} (#${pull.number})`;
      sha = this.makeCommit(merge.tree, [tips.base], message === undefined || message === '' ? headline : `${headline}\n\n${message}`);
    }
    this.setRefs(pull.repo, [[`refs/heads/${pull.base}`, sha]]);
    const now = this.tick();
    pull.files = files;
    pull.headSha = tips.head;
    pull.baseSha = tips.base;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.mergeCommitSha = sha;
    pull.updatedAt = now;
    pull.rev += 1;
    this.logPull(pull);
    return sha;
  }

  updatePull(pull: Pull, changes: { title?: string; body?: string | null; state?: 'open' | 'closed'; base?: string }): void {
    const now = this.tick();
    if (changes.title !== undefined) pull.title = changes.title;
    if (changes.body !== undefined) pull.body = changes.body;
    if (changes.base !== undefined) pull.base = changes.base;
    if (changes.state !== undefined && changes.state !== pull.state && !pull.merged) {
      if (changes.state === 'closed') {
        const tips = this.pullTips(pull);
        pull.headSha = tips.head;
        pull.baseSha = tips.base;
        pull.closedAt = now;
      } else {
        pull.closedAt = null;
      }
      pull.state = changes.state;
    }
    pull.updatedAt = now;
    pull.rev += 1;
    this.logPull(pull);
  }

  // ------------------------------------------------------------ replay

  replay(records: readonly JournalRecord[]): void {
    this.replaying = true;
    try {
      for (const record of records) this.apply(record);
    } finally {
      this.replaying = false;
    }
    process.stderr.write(`[anvil] replayed ${records.length} journal record(s)\n`);
  }

  apply(record: JournalRecord): void {
    const r = record as Record<string, unknown>;
    if (typeof r.at === 'number' && r.at > this.clock) this.clock = r.at;
    const repoOf = (): Repo | undefined => this.reposById.get(r.repo as number);
    switch (record.e) {
      case 'object':
        this.putObject(r.type as ObjectType, Buffer.from(r.data as string, 'base64'));
        return;
      case 'repo': {
        const id = r.id as number;
        let repo = this.reposById.get(id);
        if (repo === undefined) {
          repo = {
            kind: 'Repository', id, owner: r.owner as string, name: r.name as string, description: null, homepage: null, private: false,
            defaultBranch: 'main', hasIssues: true, createdAt: r.createdAt as number, updatedAt: 0, pushedAt: null, refs: new Map(),
            version: 0, nextNumber: 1, issues: new Map(), pulls: new Map(), labels: new Map(), memo: new Map(), memoVersion: 0,
          };
          this.reposById.set(id, repo);
        } else {
          this.repos.delete(this.repoKey(repo.owner, repo.name));
        }
        repo.owner = r.owner as string;
        repo.name = r.name as string;
        repo.description = (r.description as string | null) ?? null;
        repo.homepage = (r.homepage as string | null) ?? null;
        repo.private = r.private === true;
        repo.defaultBranch = r.defaultBranch as string;
        repo.hasIssues = r.hasIssues !== false;
        repo.updatedAt = r.updatedAt as number;
        repo.pushedAt = (r.pushedAt as number | null) ?? null;
        repo.nextNumber = Math.max(repo.nextNumber, r.nextNumber as number);
        this.repos.set(this.repoKey(repo.owner, repo.name), repo);
        this.nextRepoId = Math.max(this.nextRepoId, id + 1);
        return;
      }
      case 'repo-delete': {
        const repo = this.reposById.get(r.id as number);
        if (repo !== undefined) {
          this.repos.delete(this.repoKey(repo.owner, repo.name));
          this.reposById.delete(repo.id);
        }
        return;
      }
      case 'refs': {
        const repo = repoOf();
        if (repo === undefined) return;
        for (const [ref, oid] of r.set as Array<[string, string | null]>) {
          if (oid === null || oid === ZERO_OID) repo.refs.delete(ref);
          else repo.refs.set(ref, oid);
        }
        repo.defaultBranch = r.defaultBranch as string;
        repo.version += 1;
        return;
      }
      case 'label': {
        const repo = repoOf();
        if (repo === undefined) return;
        repo.labels.set((r.name as string).toLowerCase(), { id: r.id as number, name: r.name as string, color: r.color as string, description: (r.description as string | null) ?? null });
        this.nextLabelId = Math.max(this.nextLabelId, (r.id as number) + 1);
        return;
      }
      case 'issue': {
        const repo = repoOf();
        if (repo === undefined) return;
        const labels = (r.labels as number[]).map((id) => [...repo.labels.values()].find((label) => label.id === id)).filter((label): label is Label => label !== undefined);
        const existing = repo.issues.get(r.number as number);
        if (existing === undefined) {
          repo.issues.set(r.number as number, {
            kind: 'Issue', id: r.id as number, number: r.number as number, repo, title: r.title as string, body: (r.body as string | null) ?? null,
            state: r.state as 'open' | 'closed', stateReason: (r.stateReason as string | null) ?? null, labels, comments: [], createdAt: r.createdAt as number,
            updatedAt: r.updatedAt as number, closedAt: (r.closedAt as number | null) ?? null, rev: 0, cache: null,
          });
        } else {
          existing.title = r.title as string;
          existing.body = (r.body as string | null) ?? null;
          existing.state = r.state as 'open' | 'closed';
          existing.stateReason = (r.stateReason as string | null) ?? null;
          existing.labels = labels;
          existing.updatedAt = r.updatedAt as number;
          existing.closedAt = (r.closedAt as number | null) ?? null;
          existing.rev += 1;
        }
        repo.nextNumber = Math.max(repo.nextNumber, (r.number as number) + 1);
        this.nextIssueId = Math.max(this.nextIssueId, (r.id as number) + 1);
        return;
      }
      case 'comment': {
        const repo = repoOf();
        if (repo === undefined) return;
        const target = repo.issues.get(r.number as number) ?? repo.pulls.get(r.number as number);
        if (target === undefined) return;
        target.comments.push({ id: r.id as number, repoId: repo.id, number: target.number, body: r.body as string, createdAt: r.createdAt as number, updatedAt: r.createdAt as number });
        this.nextCommentId = Math.max(this.nextCommentId, (r.id as number) + 1);
        return;
      }
      case 'pull': {
        const repo = repoOf();
        if (repo === undefined) return;
        const existing = repo.pulls.get(r.number as number);
        const fields = {
          title: r.title as string,
          body: (r.body as string | null) ?? null,
          state: r.state as 'open' | 'closed',
          merged: r.merged === true,
          draft: r.draft === true,
          base: r.base as string,
          headSha: r.headSha as string,
          baseSha: r.baseSha as string,
          mergeCommitSha: (r.mergeCommitSha as string | null) ?? null,
          mergedAt: (r.mergedAt as number | null) ?? null,
          closedAt: (r.closedAt as number | null) ?? null,
          updatedAt: r.updatedAt as number,
          files: (r.files as PullFile[] | null) ?? null,
        };
        if (existing === undefined) {
          repo.pulls.set(r.number as number, {
            kind: 'PullRequest', id: r.id as number, number: r.number as number, repo, head: r.head as string, createdAt: r.createdAt as number,
            labels: [], comments: [], rev: 0, ...fields,
          });
        } else {
          Object.assign(existing, fields);
          existing.rev += 1;
        }
        repo.nextNumber = Math.max(repo.nextNumber, (r.number as number) + 1);
        this.nextPullId = Math.max(this.nextPullId, (r.id as number) + 1);
        return;
      }
      default:
        return;
    }
  }
}

// ---------------------------------------------------------------- line diffs

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added and deleted line counts, from the shortest edit script (Myers), with a cheap bound for huge inputs. */
export function lineChanges(before: string, after: string): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { additions: m, deletions: n };
  const max = n + m;
  if (max > 20_000) return { additions: m, deletions: n };
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number)) ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const common = (n + m - d) / 2;
        return { additions: m - common, deletions: n - common };
      }
    }
  }
  return { additions: m, deletions: n };
}

function addedPatch(text: string): string | null {
  const lines = splitLines(text);
  if (lines.length === 0 || lines.length > 2000) return null;
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
}
