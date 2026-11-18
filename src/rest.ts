// GitHub REST v3 under /api/v3: repositories, contents, the Git Data API, branches and commits, labels,
// issues and comments, pull requests with files and merges. Every answer is JSON with a request id; GETs
// carry an ETag and answer If-None-Match with 304; lists page with a Link header on the request's origin.

import { createHash } from 'node:crypto';
import { JSON_TYPE, decodeSegment, parseQuery, type Reply, type Request } from './http.ts';
import { StoreError, isoOf, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import { OID_RE, ZERO_OID, buildCommit, isTreeMode, type ObjectType } from './git/objects.ts';
import {
  api,
  commentJson,
  commitJson,
  gitCommitJson,
  html,
  issueJson,
  labelJson,
  nodeId,
  pullAsIssueJson,
  pullCommitList,
  pullFileJson,
  pullJson,
  repoJson,
  userJson,
  wrappedBase64,
  type View,
} from './render.ts';

const DOCS = 'https://docs.github.com/rest';
const VERSION = 'anvil 1.0.0';

export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function invalid(resource: string, field: string, code = 'invalid', value?: unknown): HttpError {
  const error: Record<string, unknown> = { resource, field, code };
  if (value !== undefined) error.value = value;
  return new HttpError(422, 'Validation Failed', { errors: [error] });
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Body should be a JSON object');
  return value as Json;
}

function str(body: Json, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function bool(body: Json, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function nullableString(body: Json, key: string): string | null | undefined {
  const value = body[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class RestApi {
  readonly store: Store;
  readonly token: string;
  requestId = 0;

  constructor(store: Store, token: string) {
    this.store = store;
    this.token = token;
  }

  /** Whether a request carries the trial's credential: Bearer, token or Basic (git's credential form). */
  authorize(request: Request): 'ok' | 'missing' | 'bad' {
    const header = request.headers.authorization;
    if (header === undefined || header === '') return 'missing';
    if (this.token === '') return 'ok';
    const space = header.indexOf(' ');
    const scheme = (space < 0 ? header : header.slice(0, space)).toLowerCase();
    const value = space < 0 ? '' : header.slice(space + 1).trim();
    if ((scheme === 'bearer' || scheme === 'token') && value === this.token) return 'ok';
    if (scheme === 'basic') {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (decoded.slice(colon + 1) === this.token || decoded.slice(0, colon) === this.token) return 'ok';
    }
    return 'bad';
  }

  head(extra = ''): string {
    this.requestId += 1;
    return `${JSON_TYPE}x-github-request-id: ANVIL:${this.requestId.toString(16).toUpperCase().padStart(8, '0')}\r\nx-github-api-version-selected: 2022-11-28\r\n${extra}`;
  }

  json(status: number, body: unknown, extra = ''): Reply {
    return { status, head: this.head(extra), body: typeof body === 'string' ? body : JSON.stringify(body) };
  }

  /** A 200 GET answer with its ETag; a matching If-None-Match is a 304. */
  cached(request: Request, text: string, etag: string, extra = ''): Reply {
    if (request.headers['if-none-match'] === etag) return { status: 304, head: this.head(`etag: ${etag}\r\n${extra}`), body: '' };
    return { status: 200, head: this.head(`etag: ${etag}\r\n${extra}`), body: text };
  }

  ok(request: Request, body: unknown, extra = ''): Reply {
    const text = JSON.stringify(body);
    if (request.method !== 'GET' && request.method !== 'HEAD') return this.json(200, text, extra);
    return this.cached(request, text, `"${createHash('sha1').update(text).digest('hex')}"`, extra);
  }

  error(status: number, message: string, extra: Record<string, unknown> = {}): Reply {
    const auth = status === 401 ? 'www-authenticate: Bearer realm="anvil"\r\n' : '';
    return this.json(status, { message, ...extra, documentation_url: DOCS }, auth);
  }

  body(request: Request): Json {
    if (request.body.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Problems parsing JSON');
    }
    return asObject(parsed);
  }

  handle(request: Request, path: string, origin: string): Reply {
    const auth = this.authorize(request);
    if (auth !== 'ok') return this.error(401, auth === 'missing' ? 'Requires authentication' : 'Bad credentials');
    const view: View = { store: this.store, origin };
    try {
      const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);
      return this.route(request, view, segments);
    } catch (err) {
      if (err instanceof HttpError) return this.error(err.status, err.message, err.extra);
      if (err instanceof StoreError) return this.error(err.status, err.message);
      throw err;
    }
  }

  route(request: Request, view: View, s: readonly string[]): Reply {
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const [first, second, third] = s;
    const viewer = this.store.viewer;
    switch (first) {
      case undefined:
        if (method === 'GET') {
          return this.ok(request, {
            current_user_url: api(view, '/user'),
            repository_url: api(view, '/repos/{owner}/{repo}'),
            user_repositories_url: api(view, '/users/{user}/repos'),
            issues_url: api(view, '/issues'),
            rate_limit_url: api(view, '/rate_limit'),
          }, 'x-oauth-scopes: repo, read:org\r\nx-accepted-oauth-scopes: \r\n');
        }
        break;
      case 'meta':
        if (s.length === 1 && method === 'GET') return this.ok(request, { verifiable_password_authentication: false, installed_version: VERSION });
        break;
      case 'rate_limit':
        if (s.length === 1 && method === 'GET') {
          const core = { limit: 5000, used: 0, remaining: 5000, reset: 0 };
          return this.ok(request, { resources: { core, graphql: core, search: core }, rate: core });
        }
        break;
      case 'user':
        if (s.length === 1 && method === 'GET') return this.ok(request, { ...userJson(view, viewer.login), name: viewer.name, email: viewer.email });
        if (second === 'repos' && s.length === 2) {
          if (method === 'GET') return this.listRepos(request, view, (repo) => repo.owner.toLowerCase() === viewer.login.toLowerCase(), '/user/repos');
          if (method === 'POST') return this.createRepo(request, view, viewer.login);
        }
        break;
      case 'users':
        if (second !== undefined && s.length === 2 && method === 'GET') return this.ownerJson(request, view, second);
        if (second !== undefined && third === 'repos' && s.length === 3 && method === 'GET') {
          return this.listRepos(request, view, (repo) => repo.owner.toLowerCase() === second.toLowerCase(), `/users/${second}/repos`);
        }
        break;
      case 'orgs':
        if (second !== undefined && s.length === 2 && method === 'GET') return this.ownerJson(request, view, second);
        if (second !== undefined && third === 'repos' && s.length === 3) {
          if (method === 'GET') return this.listRepos(request, view, (repo) => repo.owner.toLowerCase() === second.toLowerCase(), `/orgs/${second}/repos`);
          if (method === 'POST') return this.createRepo(request, view, second);
        }
        break;
      case 'repositories':
        if (second !== undefined && s.length === 2 && method === 'GET') {
          const repo = this.store.reposById.get(Number(second));
          if (repo !== undefined) return this.ok(request, repoJson(view, repo));
        }
        break;
      case 'repos': {
        if (second === undefined || third === undefined) break;
        const repo = this.store.findRepo(second, third);
        if (repo === undefined) throw new HttpError(404, 'Not Found');
        return this.repoRoute(request, view, repo, method, s.slice(3));
      }
      default:
        break;
    }
    throw new HttpError(404, 'Not Found');
  }

  ownerJson(request: Request, view: View, login: string): Reply {
    const known = login.toLowerCase() === this.store.viewer.login.toLowerCase() || [...this.store.repos.values()].some((repo) => repo.owner.toLowerCase() === login.toLowerCase());
    if (!known) throw new HttpError(404, 'Not Found');
    return this.ok(request, userJson(view, login));
  }

  // ------------------------------------------------------------ paging

  paged<T>(request: Request, view: View, items: readonly T[], path: string): { items: T[]; link: string } {
    const query = parseQuery(request.query);
    const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
    const pageNumber = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const last = Math.max(1, Math.ceil(items.length / perPage));
    const slice = items.slice((pageNumber - 1) * perPage, pageNumber * perPage);
    const url = (target: number): string => {
      const params: string[] = [];
      for (const [key, value] of query) if (key !== 'page' && key !== 'per_page') params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      params.push(`per_page=${perPage}`, `page=${target}`);
      return `<${api(view, path)}?${params.join('&')}>`;
    };
    const rels: string[] = [];
    if (pageNumber < last) rels.push(`${url(pageNumber + 1)}; rel="next"`, `${url(last)}; rel="last"`);
    if (pageNumber > 1) rels.push(`${url(1)}; rel="first"`, `${url(Math.min(pageNumber - 1, last))}; rel="prev"`);
    return { items: slice, link: rels.length === 0 ? '' : `link: ${rels.join(', ')}\r\n` };
  }

  list<T>(request: Request, view: View, items: readonly T[], path: string, render: (item: T) => unknown): Reply {
    const page = this.paged(request, view, items, path);
    return this.ok(request, page.items.map(render), page.link);
  }

  // ------------------------------------------------------------ repositories

  listRepos(request: Request, view: View, filter: (repo: Repo) => boolean, path: string): Reply {
    const query = parseQuery(request.query);
    const visibility = query.get('visibility') ?? query.get('type') ?? 'all';
    const repos = [...this.store.repos.values()].filter(filter).filter((repo) => (visibility === 'private' ? repo.private : visibility === 'public' ? !repo.private : true));
    const sort = query.get('sort') ?? 'full_name';
    const key = (repo: Repo): number | string => (sort === 'created' ? repo.createdAt : sort === 'updated' ? repo.updatedAt : sort === 'pushed' ? repo.pushedAt ?? 0 : `${repo.owner}/${repo.name}`.toLowerCase());
    const direction = query.get('direction') ?? (sort === 'full_name' ? 'asc' : 'desc');
    repos.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const order = x < y ? -1 : x > y ? 1 : a.id - b.id;
      return direction === 'asc' ? order : -order;
    });
    return this.list(request, view, repos, path, (repo) => repoJson(view, repo));
  }

  createRepo(request: Request, view: View, owner: string): Reply {
    const body = this.body(request);
    const name = str(body, 'name');
    if (name === undefined || name === '') throw invalid('Repository', 'name', 'missing_field');
    if (!REPO_NAME_RE.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) throw invalid('Repository', 'name', 'invalid', name);
    if (this.store.findRepo(owner, name) !== undefined) {
      throw new HttpError(422, 'Repository creation failed: name already exists on this account', {
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
    }
    const visibility = str(body, 'visibility');
    const repo = this.store.createRepo(owner, name, {
      description: nullableString(body, 'description') ?? null,
      homepage: nullableString(body, 'homepage') ?? null,
      private: bool(body, 'private') ?? (visibility === undefined ? false : visibility !== 'public'),
      hasIssues: bool(body, 'has_issues'),
      autoInit: bool(body, 'auto_init'),
    });
    return this.json(201, repoJson(view, repo), `location: ${api(view, `/repos/${repo.owner}/${repo.name}`)}\r\n`);
  }

  repoRoute(request: Request, view: View, repo: Repo, method: string, s: readonly string[]): Reply {
    const [section, a] = s;
    switch (section) {
      case undefined:
        if (method === 'GET') return this.ok(request, repoJson(view, repo));
        if (method === 'PATCH') {
          const body = this.body(request);
          const name = str(body, 'name');
          if (name !== undefined && !REPO_NAME_RE.test(name)) throw invalid('Repository', 'name', 'invalid', name);
          const defaultBranch = str(body, 'default_branch');
          if (defaultBranch !== undefined && repo.refs.size > 0 && !repo.refs.has(`refs/heads/${defaultBranch}`)) throw invalid('Repository', 'default_branch');
          const visibility = str(body, 'visibility');
          this.store.updateRepo(repo, {
            name,
            description: nullableString(body, 'description'),
            homepage: nullableString(body, 'homepage'),
            private: bool(body, 'private') ?? (visibility === undefined ? undefined : visibility !== 'public'),
            defaultBranch,
            hasIssues: bool(body, 'has_issues'),
          });
          return this.json(200, repoJson(view, repo));
        }
        if (method === 'DELETE') {
          this.store.deleteRepo(repo);
          return { status: 204, head: this.head(), body: '' };
        }
        break;
      case 'branches':
        if (method === 'GET') {
          if (s.length === 1) {
            const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
            return this.list(request, view, branches, `/repos/${repo.owner}/${repo.name}/branches`, (ref) => {
              const name = ref.slice(11);
              const sha = repo.refs.get(ref) as string;
              return { name, commit: { sha, url: api(view, `/repos/${repo.owner}/${repo.name}/commits/${sha}`) }, protected: false };
            });
          }
          const name = s.slice(1).join('/');
          const sha = this.store.branchTip(repo, name);
          const commit = sha === null ? undefined : this.store.commit(sha);
          if (sha === null || commit === undefined) throw new HttpError(404, 'Branch not found');
          return this.ok(request, {
            name,
            commit: commitJson(view, repo, sha, commit),
            _links: { self: api(view, `/repos/${repo.owner}/${repo.name}/branches/${name}`), html: html(view, `/${repo.owner}/${repo.name}/tree/${name}`) },
            protected: false,
            protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
            protection_url: api(view, `/repos/${repo.owner}/${repo.name}/branches/${name}/protection`),
          });
        }
        break;
      case 'tags':
        if (method === 'GET' && s.length === 1) {
          const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
          return this.list(request, view, tags, `/repos/${repo.owner}/${repo.name}/tags`, (ref) => {
            const sha = this.store.peel(repo.refs.get(ref) as string);
            return { name: ref.slice(10), commit: { sha, url: api(view, `/repos/${repo.owner}/${repo.name}/commits/${sha}`) }, node_id: nodeId('Ref', `${repo.id}:${ref}`) };
          });
        }
        break;
      case 'commits':
        if (method === 'GET') return this.commits(request, view, repo, s.slice(1));
        break;
      case 'contents':
        return this.contents(request, view, repo, method, s.slice(1).join('/'));
      case 'readme':
        if (method === 'GET') {
          const tip = this.store.resolveRef(repo, parseQuery(request.query).get('ref'));
          const tree = tip === null ? null : this.store.commit(tip)?.tree ?? null;
          const entry = tree === null ? undefined : (this.store.tree(tree) ?? []).find((candidate) => /^readme(\.|$)/i.test(candidate.name) && !isTreeMode(candidate.mode));
          if (entry === undefined) throw new HttpError(404, 'Not Found');
          return this.contents(request, view, repo, 'GET', entry.name);
        }
        break;
      case 'git':
        return this.gitData(request, view, repo, method, s.slice(1));
      case 'labels':
        return this.labels(request, view, repo, method, s.slice(1));
      case 'issues':
        return this.issues(request, view, repo, method, s.slice(1));
      case 'pulls':
        return this.pulls(request, view, repo, method, s.slice(1));
      default:
        void a;
        break;
    }
    throw new HttpError(404, 'Not Found');
  }

  // ------------------------------------------------------------ commits

  commits(request: Request, view: View, repo: Repo, s: readonly string[]): Reply {
    if (repo.refs.size === 0) throw new HttpError(409, 'Git Repository is empty.');
    if (s.length > 0) {
      const ref = s.join('/');
      const sha = this.store.resolveRef(repo, ref);
      const commit = sha === null ? undefined : this.store.commit(sha);
      if (sha === null || commit === undefined) throw new HttpError(422, `No commit found for SHA: ${ref}`);
      const parent = commit.parents[0];
      const parentTree = parent === undefined ? null : this.store.commit(parent)?.tree ?? null;
      const files = this.store.diffTrees(parentTree, commit.tree);
      let additions = 0;
      let deletions = 0;
      for (const file of files) {
        additions += file.additions;
        deletions += file.deletions;
      }
      return this.ok(request, {
        ...commitJson(view, repo, sha, commit),
        stats: { total: additions + deletions, additions, deletions },
        files: files.map((file) => pullFileJson(view, repo, file, sha)),
      });
    }
    const query = parseQuery(request.query);
    const start = this.store.resolveRef(repo, query.get('sha'));
    if (start === null) throw new HttpError(404, 'Not Found');
    const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
    const pageNumber = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    let shas = this.store.history(start, pageNumber * perPage + 1 + (query.has('path') ? 10_000 : 0));
    const path = query.get('path');
    if (path !== undefined && path !== '') {
      shas = shas.filter((sha) => {
        const commit = this.store.commit(sha);
        if (commit === undefined) return false;
        const mine = this.store.entryAt(commit.tree, path)?.oid ?? null;
        const parent = commit.parents[0];
        const theirs = parent === undefined ? null : this.store.entryAt(this.store.commit(parent)?.tree ?? '', path)?.oid ?? null;
        return mine !== theirs;
      });
    }
    return this.list(request, view, shas, `/repos/${repo.owner}/${repo.name}/commits`, (sha) => commitJson(view, repo, sha, this.store.commit(sha) as never));
  }

  // ------------------------------------------------------------ contents

  contentEntry(view: View, repo: Repo, path: string, oid: string, mode: string, ref: string): Json {
    const full = `/repos/${repo.owner}/${repo.name}`;
    const object = this.store.object(oid);
    const dir = isTreeMode(mode);
    const type = dir ? 'dir' : mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
    const name = path.slice(path.lastIndexOf('/') + 1);
    const self = api(view, `${full}/contents/${path}?ref=${ref}`);
    const git = api(view, `${full}/git/${dir ? 'trees' : 'blobs'}/${oid}`);
    const htmlUrl = html(view, `/${repo.owner}/${repo.name}/${dir ? 'tree' : 'blob'}/${ref}/${path}`);
    return {
      name,
      path,
      sha: oid,
      size: dir || object === undefined ? 0 : object.data.length,
      url: self,
      html_url: htmlUrl,
      git_url: git,
      download_url: dir ? null : html(view, `/${repo.owner}/${repo.name}/raw/${ref}/${path}`),
      type,
      _links: { self, git, html: htmlUrl },
    };
  }

  contents(request: Request, view: View, repo: Repo, method: string, rawPath: string): Reply {
    const path = rawPath.replace(/^\/+|\/+$/g, '');
    if (path.split('/').some((segment) => segment === '..' || segment === '.')) throw new HttpError(422, 'Invalid path');
    if (method === 'GET') {
      const ref = parseQuery(request.query).get('ref');
      if (repo.refs.size === 0) throw new HttpError(404, 'This repository is empty.');
      const tip = this.store.resolveRef(repo, ref);
      const commit = tip === null ? undefined : this.store.commit(tip);
      if (commit === undefined) throw new HttpError(404, `No commit found for the ref ${ref ?? repo.defaultBranch}`);
      const entry = this.store.entryAt(commit.tree, path);
      if (entry === null) throw new HttpError(404, 'Not Found');
      const refName = ref ?? repo.defaultBranch;
      if (isTreeMode(entry.mode)) {
        const entries = this.store.tree(entry.oid) ?? [];
        return this.ok(request, entries.map((child) => this.contentEntry(view, repo, path === '' ? child.name : `${path}/${child.name}`, child.oid, child.mode, refName)));
      }
      const object = this.store.object(entry.oid);
      if (object === undefined) throw new HttpError(404, 'Not Found');
      return this.ok(request, { ...this.contentEntry(view, repo, path, entry.oid, entry.mode, refName), content: wrappedBase64(object.data), encoding: 'base64' });
    }
    if (method !== 'PUT' && method !== 'DELETE') throw new HttpError(404, 'Not Found');
    if (path === '') throw new HttpError(422, 'Invalid path');
    const body = this.body(request);
    const message = str(body, 'message');
    if (message === undefined || message === '') throw new HttpError(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    let parent = this.store.branchTip(repo, branch);
    if (parent === null && repo.refs.size > 0) {
      // A write to a branch that does not exist yet starts it from the default branch.
      parent = this.store.branchTip(repo, repo.defaultBranch);
      if (parent === null) throw new HttpError(404, `Branch ${branch} not found`);
    }
    const parentTree = parent === null ? null : this.store.commit(parent)?.tree ?? null;
    const existing = parentTree === null ? null : this.store.entryAt(parentTree, path);
    const sha = str(body, 'sha');
    const segments = path.split('/');
    if (method === 'PUT') {
      const content = str(body, 'content');
      if (content === undefined) throw new HttpError(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
      if (existing !== null && isTreeMode(existing.mode)) throw new HttpError(422, `${path} is a directory`);
      if (existing !== null) {
        if (sha === undefined) throw new HttpError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
        if (sha !== existing.oid) throw new HttpError(409, `${path} does not match ${sha}`);
      }
      const blob = this.store.putObject('blob', Buffer.from(content, 'base64'));
      const tree = this.store.withPath(parentTree, segments, { mode: existing?.mode ?? '100644', oid: blob }) as string;
      const commitSha = this.store.makeCommit(tree, parent === null ? [] : [parent], message);
      this.store.setRefs(repo, [[`refs/heads/${branch}`, commitSha]]);
      const commit = this.store.commit(commitSha);
      if (commit === undefined) throw new Error('the commit just written is missing');
      return this.json(existing === null ? 201 : 200, {
        content: { ...this.contentEntry(view, repo, path, blob, '100644', branch), encoding: 'base64' },
        commit: gitCommitJson(view, repo, commitSha, commit),
      });
    }
    if (existing === null || isTreeMode(existing.mode)) throw new HttpError(404, 'Not Found');
    if (sha === undefined) throw new HttpError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (sha !== existing.oid) throw new HttpError(409, `${path} does not match ${sha}`);
    const tree = this.store.withPath(parentTree, segments, null) ?? this.store.emptyTree();
    const commitSha = this.store.makeCommit(tree, parent === null ? [] : [parent], message);
    this.store.setRefs(repo, [[`refs/heads/${branch}`, commitSha]]);
    return this.json(200, { content: null, commit: gitCommitJson(view, repo, commitSha, this.store.commit(commitSha) as never) });
  }

  // ------------------------------------------------------------ the Git Data API

  refJson(view: View, repo: Repo, ref: string, sha: string): Json {
    const type = this.store.object(sha)?.type ?? 'commit';
    return {
      ref,
      node_id: nodeId('Ref', `${repo.id}:${ref}`),
      url: api(view, `/repos/${repo.owner}/${repo.name}/git/${ref}`),
      object: { sha, type, url: api(view, `/repos/${repo.owner}/${repo.name}/git/${type}s/${sha}`) },
    };
  }

  gitData(request: Request, view: View, repo: Repo, method: string, s: readonly string[]): Reply {
    const [kind, ...rest] = s;
    const store = this.store;
    if (kind === 'refs' || kind === 'ref' || kind === 'matching-refs') {
      const name = rest.join('/');
      const full = name === '' ? 'refs' : name.startsWith('refs/') ? name : `refs/${name}`;
      if (method === 'POST' && kind === 'refs' && rest.length === 0) {
        const body = this.body(request);
        const ref = str(body, 'ref');
        const sha = str(body, 'sha');
        if (ref === undefined || !ref.startsWith('refs/') || ref.split('/').length < 3) throw new HttpError(422, 'Reference name must start with \'refs/\' and have at least two slashes.');
        if (sha === undefined || !OID_RE.test(sha) || store.object(sha) === undefined) throw new HttpError(422, 'Object does not exist');
        if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
        store.setRefs(repo, [[ref, sha]]);
        return this.json(201, this.refJson(view, repo, ref, sha), `location: ${api(view, `/repos/${repo.owner}/${repo.name}/git/${ref}`)}\r\n`);
      }
      if (method === 'GET') {
        const exact = repo.refs.get(full);
        if (exact !== undefined && kind !== 'matching-refs') return this.ok(request, this.refJson(view, repo, full, exact));
        const prefix = kind === 'matching-refs' ? full : `${full}/`;
        const matches = [...repo.refs.entries()].filter(([ref]) => ref.startsWith(prefix) || (kind === 'matching-refs' && ref === full)).sort(([x], [y]) => (x < y ? -1 : 1));
        if (matches.length === 0 && kind !== 'matching-refs') throw new HttpError(404, 'Not Found');
        return this.ok(request, matches.map(([ref, sha]) => this.refJson(view, repo, ref, sha)));
      }
      if (method === 'PATCH' && kind === 'refs') {
        const body = this.body(request);
        const sha = str(body, 'sha');
        const current = repo.refs.get(full);
        if (current === undefined) throw new HttpError(422, 'Reference does not exist');
        if (sha === undefined || store.object(sha) === undefined) throw new HttpError(422, 'Object does not exist');
        if (body.force !== true && !(store.commit(store.peel(current)) !== undefined && store.isAncestor(store.peel(current), store.peel(sha)))) throw new HttpError(422, 'Update is not a fast forward');
        store.setRefs(repo, [[full, sha]]);
        return this.json(200, this.refJson(view, repo, full, sha));
      }
      if (method === 'DELETE' && kind === 'refs') {
        if (!repo.refs.has(full)) throw new HttpError(422, 'Reference does not exist');
        store.setRefs(repo, [[full, null]]);
        return { status: 204, head: this.head(), body: '' };
      }
      throw new HttpError(404, 'Not Found');
    }
    const base = `/repos/${repo.owner}/${repo.name}/git`;
    if (kind === 'blobs') {
      if (method === 'POST' && rest.length === 0) {
        const body = this.body(request);
        const content = str(body, 'content');
        if (content === undefined) throw invalid('Blob', 'content', 'missing_field');
        const encoding = str(body, 'encoding') ?? 'utf-8';
        const sha = store.putObject('blob', Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8'));
        return this.json(201, { sha, url: api(view, `${base}/blobs/${sha}`) });
      }
      const sha = rest[0];
      const object = sha === undefined ? undefined : store.object(sha);
      if (method === 'GET' && sha !== undefined && object?.type === 'blob') {
        return this.ok(request, { sha, node_id: nodeId('Blob', `${repo.id}:${sha}`), size: object.data.length, url: api(view, `${base}/blobs/${sha}`), content: wrappedBase64(object.data), encoding: 'base64' });
      }
      throw new HttpError(404, 'Not Found');
    }
    if (kind === 'trees') {
      if (method === 'POST' && rest.length === 0) {
        const body = this.body(request);
        if (!Array.isArray(body.tree)) throw invalid('Tree', 'tree', 'missing_field');
        const baseTree = str(body, 'base_tree');
        let tree: string | null = baseTree !== undefined && store.tree(baseTree) !== undefined ? baseTree : null;
        for (const raw of body.tree as unknown[]) {
          const entry = asObject(raw);
          const path = str(entry, 'path');
          const mode = str(entry, 'mode') ?? '100644';
          if (path === undefined || path === '') throw invalid('Tree', 'tree.path', 'missing_field');
          let oid: string | null;
          if (typeof entry.content === 'string') oid = store.putObject('blob', Buffer.from(entry.content, 'utf8'));
          else if (entry.sha === null) oid = null;
          else {
            const sha = str(entry, 'sha');
            if (sha === undefined || store.object(sha) === undefined) throw new HttpError(422, `tree.sha ${String(sha)} is not a valid object`);
            oid = sha;
          }
          tree = store.withPath(tree, path.split('/'), oid === null ? null : { mode: mode === '040000' ? '40000' : mode, oid });
        }
        const sha = tree ?? store.emptyTree();
        return this.json(201, this.treeJson(view, repo, sha, false));
      }
      const sha = rest[0];
      if (method === 'GET' && sha !== undefined) {
        const resolved = store.tree(sha) !== undefined ? sha : store.commit(store.resolveRef(repo, sha) ?? '')?.tree;
        if (resolved === undefined || store.tree(resolved) === undefined) throw new HttpError(404, 'Not Found');
        const recursive = parseQuery(request.query).get('recursive');
        return this.ok(request, this.treeJson(view, repo, resolved, recursive !== undefined && recursive !== '0' && recursive !== 'false'));
      }
      throw new HttpError(404, 'Not Found');
    }
    if (kind === 'commits') {
      if (method === 'POST' && rest.length === 0) {
        const body = this.body(request);
        const message = str(body, 'message');
        const tree = str(body, 'tree');
        if (message === undefined) throw invalid('Commit', 'message', 'missing_field');
        if (tree === undefined || store.tree(tree) === undefined) throw new HttpError(422, 'Tree SHA does not exist');
        const parents = Array.isArray(body.parents) ? (body.parents as unknown[]).filter((parent): parent is string => typeof parent === 'string') : [];
        for (const parent of parents) if (store.commit(parent) === undefined) throw new HttpError(422, 'Parent SHA does not exist or is not a commit object');
        const who = (key: string): { name: string; email: string; time: number; tz: string } => {
          const fallback = store.signature();
          const given = body[key];
          if (typeof given !== 'object' || given === null) return fallback;
          const record = given as Json;
          const date = str(record, 'date');
          const parsed = date === undefined ? Number.NaN : Date.parse(date);
          return { name: str(record, 'name') ?? fallback.name, email: str(record, 'email') ?? fallback.email, time: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback.time, tz: '+0000' };
        };
        store.tick();
        const author = who('author');
        const committer = body.committer === undefined ? author : who('committer');
        const sha = store.putObject('commit', buildCommit({ tree, parents, author, committer, message: message.endsWith('\n') ? message : `${message}\n` }));
        return this.json(201, gitCommitJson(view, repo, sha, store.commit(sha) as never));
      }
      const sha = rest[0];
      const commit = sha === undefined ? undefined : store.commit(sha);
      if (method === 'GET' && sha !== undefined && commit !== undefined) return this.ok(request, gitCommitJson(view, repo, sha, commit));
      throw new HttpError(404, 'Not Found');
    }
    if (kind === 'tags' && method === 'GET' && rest[0] !== undefined) {
      const object = store.object(rest[0]);
      if (object?.type !== 'tag') throw new HttpError(404, 'Not Found');
      const text = object.data.toString('utf8');
      const target = /^object ([0-9a-f]{40})$/m.exec(text)?.[1] ?? ZERO_OID;
      return this.ok(request, { sha: rest[0], tag: /^tag (.*)$/m.exec(text)?.[1] ?? '', message: text.slice(text.indexOf('\n\n') + 2), object: { sha: target, type: store.object(target)?.type ?? 'commit' } });
    }
    throw new HttpError(404, 'Not Found');
  }

  treeJson(view: View, repo: Repo, sha: string, recursive: boolean): Json {
    const base = `/repos/${repo.owner}/${repo.name}/git`;
    const entries: Json[] = [];
    const walk = (treeOid: string, prefix: string): void => {
      for (const entry of this.store.tree(treeOid) ?? []) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const dir = isTreeMode(entry.mode);
        const type: ObjectType | 'commit' = dir ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob';
        const item: Json = { path, mode: dir ? '040000' : entry.mode, type, sha: entry.oid };
        if (type === 'blob') item.size = this.store.object(entry.oid)?.data.length ?? 0;
        item.url = api(view, `${base}/${type === 'tree' ? 'trees' : 'blobs'}/${entry.oid}`);
        entries.push(item);
        if (dir && recursive) walk(entry.oid, path);
      }
    };
    walk(sha, '');
    return { sha, url: api(view, `${base}/trees/${sha}`), tree: entries, truncated: false };
  }

  // ------------------------------------------------------------ labels

  labels(request: Request, view: View, repo: Repo, method: string, s: readonly string[]): Reply {
    if (s.length === 0) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()].sort((a, b) => a.id - b.id);
        return this.list(request, view, labels, `/repos/${repo.owner}/${repo.name}/labels`, (label) => labelJson(view, repo, label));
      }
      if (method === 'POST') {
        const body = this.body(request);
        const name = str(body, 'name');
        if (name === undefined || name.trim() === '') throw invalid('Label', 'name', 'missing_field');
        if (repo.labels.has(name.toLowerCase())) throw invalid('Label', 'name', 'already_exists', name);
        const color = (str(body, 'color') ?? 'ededed').replace(/^#/, '');
        const label = this.store.createLabel(repo, name, color, nullableString(body, 'description') ?? null);
        return this.json(201, labelJson(view, repo, label));
      }
      throw new HttpError(404, 'Not Found');
    }
    const label = repo.labels.get(s.join('/').toLowerCase());
    if (label === undefined) throw new HttpError(404, 'Not Found');
    if (method === 'GET') return this.ok(request, labelJson(view, repo, label));
    if (method === 'PATCH') {
      const body = this.body(request);
      const newName = str(body, 'new_name') ?? str(body, 'name');
      if (newName !== undefined && newName.toLowerCase() !== label.name.toLowerCase()) {
        if (repo.labels.has(newName.toLowerCase())) throw invalid('Label', 'name', 'already_exists', newName);
        repo.labels.delete(label.name.toLowerCase());
        repo.labels.set(newName.toLowerCase(), label);
      }
      if (newName !== undefined) label.name = newName;
      const color = str(body, 'color');
      if (color !== undefined) label.color = color.replace(/^#/, '');
      const description = nullableString(body, 'description');
      if (description !== undefined) label.description = description;
      this.store.tick();
      this.store.touchIssues(repo);
      this.store.log({ e: 'label', repo: repo.id, id: label.id, name: label.name, color: label.color, description: label.description });
      return this.json(200, labelJson(view, repo, label));
    }
    if (method === 'DELETE') {
      repo.labels.delete(label.name.toLowerCase());
      for (const issue of repo.issues.values()) {
        if (issue.labels.includes(label)) this.store.updateIssue(issue, { labels: issue.labels.filter((other) => other !== label) });
      }
      return { status: 204, head: this.head(), body: '' };
    }
    throw new HttpError(404, 'Not Found');
  }

  labelNames(value: unknown): string[] {
    if (!Array.isArray(value)) throw invalid('Issue', 'labels');
    return value.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (typeof entry === 'object' && entry !== null && typeof (entry as Json).name === 'string') return (entry as Json).name as string;
      throw invalid('Issue', 'labels', 'invalid', entry);
    });
  }

  labelsFor(repo: Repo, value: unknown): Label[] {
    const names = this.labelNames(value);
    const missing = names.filter((name) => !repo.labels.has(name.toLowerCase()));
    if (missing.length > 0) {
      throw new HttpError(422, `Validation Failed: the label${missing.length > 1 ? 's' : ''} ${missing.map((name) => JSON.stringify(name)).join(', ')} do${missing.length > 1 ? '' : 'es'} not exist`, {
        errors: missing.map((name) => ({ value: name, resource: 'Label', field: 'labels', code: 'invalid' })),
      });
    }
    return this.store.resolveLabels(repo, names);
  }

  // ------------------------------------------------------------ issues

  issueReply(request: Request, view: View, issue: Issue): Reply {
    let cache = issue.cache;
    if (cache === null || cache.rev !== issue.rev || !cache.body.includes(view.origin)) {
      const body = JSON.stringify(issueJson(view, issue));
      cache = { rev: issue.rev, body, etag: `"${createHash('sha1').update(body).digest('hex')}"` };
      issue.cache = cache;
    }
    return this.cached(request, cache.body, cache.etag);
  }

  issues(request: Request, view: View, repo: Repo, method: string, s: readonly string[]): Reply {
    const [first, second] = s;
    if (first === undefined) {
      if (method === 'POST') {
        const body = this.body(request);
        const title = body.title;
        if (typeof title !== 'string' && typeof title !== 'number') throw invalid('Issue', 'title', 'missing_field');
        if (String(title).trim() === '') throw invalid('Issue', 'title', 'missing_field');
        if (!repo.hasIssues) throw new HttpError(410, 'Issues are disabled for this repo');
        const labels = body.labels === undefined || body.labels === null ? [] : this.labelsFor(repo, body.labels);
        const issue = this.store.createIssue(repo, { title: String(title), body: nullableString(body, 'body') ?? null, labels });
        const text = JSON.stringify(issueJson(view, issue));
        issue.cache = { rev: issue.rev, body: text, etag: `"${createHash('sha1').update(text).digest('hex')}"` };
        return { status: 201, head: this.head(`location: ${api(view, `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`)}\r\n`), body: text };
      }
      if (method === 'GET') {
        const query = parseQuery(request.query);
        const state = query.get('state') ?? 'open';
        const labelFilter = (query.get('labels') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '');
        const since = query.has('since') ? Date.parse(query.get('since') as string) / 1000 : Number.NaN;
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const items = [...repo.issues.values()].filter((issue) => {
          if (state !== 'all' && issue.state !== state) return false;
          if (labelFilter.length > 0 && !labelFilter.every((name) => issue.labels.some((label) => label.name.toLowerCase() === name))) return false;
          if (Number.isFinite(since) && issue.updatedAt < since) return false;
          return true;
        });
        const key = (issue: Issue): number => (sort === 'updated' ? issue.updatedAt : sort === 'comments' ? issue.comments.length : issue.createdAt);
        items.sort((a, b) => {
          const order = key(a) - key(b) || a.number - b.number;
          return direction === 'asc' ? order : -order;
        });
        return this.list(request, view, items, `/repos/${repo.owner}/${repo.name}/issues`, (issue) => issueJson(view, issue));
      }
      throw new HttpError(404, 'Not Found');
    }
    if (first === 'comments') {
      if (second === undefined && method === 'GET') {
        const all = [...repo.issues.values(), ...repo.pulls.values()].flatMap((target) => target.comments).sort((a, b) => a.id - b.id);
        return this.list(request, view, all, `/repos/${repo.owner}/${repo.name}/issues/comments`, (comment) => commentJson(view, repo, comment));
      }
      const found = second === undefined ? null : this.store.findComment(repo, Number(second));
      if (found === null) throw new HttpError(404, 'Not Found');
      if (method === 'GET') return this.ok(request, commentJson(view, repo, found.comment));
      if (method === 'PATCH') {
        const text = str(this.body(request), 'body');
        if (text === undefined) throw invalid('IssueComment', 'body', 'missing_field');
        found.comment.body = text;
        found.comment.updatedAt = this.store.tick();
        found.target.rev += 1;
        this.store.log({ e: 'comment-edit', repo: repo.id, id: found.comment.id, body: text });
        return this.json(200, commentJson(view, repo, found.comment));
      }
      if (method === 'DELETE') {
        const index = found.target.comments.indexOf(found.comment);
        if (index >= 0) found.target.comments.splice(index, 1);
        found.target.rev += 1;
        this.store.tick();
        return { status: 204, head: this.head(), body: '' };
      }
      throw new HttpError(404, 'Not Found');
    }
    if (!/^\d+$/.test(first)) throw new HttpError(404, 'Not Found');
    const number = Number(first);
    const issue = repo.issues.get(number);
    const pull = issue === undefined ? repo.pulls.get(number) : undefined;
    if (issue === undefined && pull === undefined) throw new HttpError(404, 'Not Found');
    const target = (issue ?? pull) as Issue | Pull;
    if (second === undefined) {
      if (method === 'GET') return issue !== undefined ? this.issueReply(request, view, issue) : this.ok(request, pullAsIssueJson(view, pull as Pull));
      if (method === 'PATCH') {
        const body = this.body(request);
        const state = str(body, 'state');
        if (state !== undefined && state !== 'open' && state !== 'closed') throw invalid('Issue', 'state', 'invalid', state);
        const title = str(body, 'title');
        if (title !== undefined && title.trim() === '') throw invalid('Issue', 'title', 'missing_field');
        const labels = body.labels === undefined ? undefined : this.labelsFor(repo, body.labels);
        if (issue !== undefined) {
          this.store.updateIssue(issue, { title, body: nullableString(body, 'body'), state: state as 'open' | 'closed' | undefined, stateReason: nullableString(body, 'state_reason'), labels });
          return this.issueReply(request, view, issue);
        }
        const p = pull as Pull;
        if (labels !== undefined) p.labels = labels;
        this.store.updatePull(p, { title, body: nullableString(body, 'body'), state: state as 'open' | 'closed' | undefined });
        return this.json(200, pullAsIssueJson(view, p));
      }
      throw new HttpError(404, 'Not Found');
    }
    if (second === 'comments' && s.length === 2) {
      if (method === 'POST') {
        const text = str(this.body(request), 'body');
        if (text === undefined || text === '') throw invalid('IssueComment', 'body', 'missing_field');
        const comment = this.store.addComment(repo, target, text);
        return this.json(201, commentJson(view, repo, comment), `location: ${api(view, `/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`)}\r\n`);
      }
      if (method === 'GET') return this.list(request, view, target.comments, `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, (comment) => commentJson(view, repo, comment));
    }
    if (second === 'labels') {
      if (s.length === 2) {
        if (method === 'GET') return this.ok(request, target.labels.map((label) => labelJson(view, repo, label)));
        if (method === 'POST' || method === 'PUT') {
          const body = request.body.length === 0 ? {} : this.parseAny(request);
          const names = Array.isArray(body) ? body : (body as Json).labels;
          const labels = this.labelsFor(repo, names ?? []);
          const next = method === 'PUT' ? labels : [...target.labels, ...labels.filter((label) => !target.labels.includes(label))];
          if (issue !== undefined) this.store.updateIssue(issue, { labels: next });
          else {
            (pull as Pull).labels = next;
            this.store.updatePull(pull as Pull, {});
          }
          return this.json(200, next.map((label) => labelJson(view, repo, label)));
        }
        if (method === 'DELETE') {
          if (issue !== undefined) this.store.updateIssue(issue, { labels: [] });
          else (pull as Pull).labels = [];
          return { status: 204, head: this.head(), body: '' };
        }
      } else if (method === 'DELETE') {
        const name = s.slice(2).join('/').toLowerCase();
        const next = target.labels.filter((label) => label.name.toLowerCase() !== name);
        if (next.length === target.labels.length) throw new HttpError(404, 'Label does not exist');
        if (issue !== undefined) this.store.updateIssue(issue, { labels: next });
        else (pull as Pull).labels = next;
        return this.json(200, next.map((label) => labelJson(view, repo, label)));
      }
    }
    throw new HttpError(404, 'Not Found');
  }

  parseAny(request: Request): unknown {
    try {
      return JSON.parse(request.body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Problems parsing JSON');
    }
  }

  // ------------------------------------------------------------ pull requests

  pulls(request: Request, view: View, repo: Repo, method: string, s: readonly string[]): Reply {
    const [first, second] = s;
    const store = this.store;
    if (first === undefined) {
      if (method === 'POST') {
        const body = this.body(request);
        const title = str(body, 'title');
        let head = str(body, 'head');
        const base = str(body, 'base');
        if (title === undefined || title.trim() === '') throw invalid('PullRequest', 'title', 'missing_field');
        if (head === undefined) throw invalid('PullRequest', 'head', 'missing_field');
        if (base === undefined) throw invalid('PullRequest', 'base', 'missing_field');
        if (head.includes(':')) head = head.slice(head.indexOf(':') + 1);
        if (store.branchTip(repo, base) === null) throw invalid('PullRequest', 'base');
        if (store.branchTip(repo, head) === null) throw invalid('PullRequest', 'head');
        if (head === base) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${base} and ${head}` }] });
        let pull: Pull;
        try {
          pull = store.createPull(repo, { title, body: nullableString(body, 'body') ?? null, head, base, draft: bool(body, 'draft') ?? false });
        } catch (err) {
          if (err instanceof StoreError) throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'custom', message: err.message }] });
          throw err;
        }
        return this.json(201, pullJson(view, pull, true), `location: ${api(view, `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`)}\r\n`);
      }
      if (method === 'GET') {
        const query = parseQuery(request.query);
        const state = query.get('state') ?? 'open';
        let headFilter = query.get('head');
        if (headFilter !== undefined && headFilter.includes(':')) headFilter = headFilter.slice(headFilter.indexOf(':') + 1);
        const baseFilter = query.get('base');
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        const items = [...repo.pulls.values()].filter((pull) => (state === 'all' || pull.state === state) && (headFilter === undefined || pull.head === headFilter) && (baseFilter === undefined || pull.base === baseFilter));
        const key = (pull: Pull): number => (sort === 'updated' ? pull.updatedAt : pull.createdAt);
        items.sort((a, b) => {
          const order = key(a) - key(b) || a.number - b.number;
          return direction === 'asc' ? order : -order;
        });
        return this.list(request, view, items, `/repos/${repo.owner}/${repo.name}/pulls`, (pull) => pullJson(view, pull, false));
      }
      throw new HttpError(404, 'Not Found');
    }
    if (!/^\d+$/.test(first)) throw new HttpError(404, 'Not Found');
    const pull = repo.pulls.get(Number(first));
    if (pull === undefined) throw new HttpError(404, 'Not Found');
    if (second === undefined) {
      if (method === 'GET') return this.ok(request, pullJson(view, pull, true));
      if (method === 'PATCH') {
        const body = this.body(request);
        const state = str(body, 'state');
        if (state !== undefined && state !== 'open' && state !== 'closed') throw invalid('PullRequest', 'state', 'invalid', state);
        const base = str(body, 'base');
        if (base !== undefined && store.branchTip(repo, base) === null) throw invalid('PullRequest', 'base');
        store.updatePull(pull, { title: str(body, 'title'), body: nullableString(body, 'body'), state: state as 'open' | 'closed' | undefined, base });
        return this.json(200, pullJson(view, pull, true));
      }
      throw new HttpError(404, 'Not Found');
    }
    if (second === 'files' && method === 'GET') {
      const files = store.pullFiles(pull);
      const ref = store.pullTips(pull).head;
      return this.list(request, view, files, `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/files`, (file) => pullFileJson(view, repo, file, ref));
    }
    if (second === 'commits' && method === 'GET') {
      return this.list(request, view, pullCommitList(store, pull), `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`, (sha) => commitJson(view, repo, sha, store.commit(sha) as never));
    }
    if (second === 'merge') {
      if (method === 'GET') {
        if (pull.merged) return { status: 204, head: this.head(), body: '' };
        throw new HttpError(404, 'Not Found');
      }
      if (method === 'PUT') {
        const body = this.body(request);
        if (pull.merged || pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
        const mergeMethod = str(body, 'merge_method') ?? 'merge';
        if (mergeMethod !== 'merge' && mergeMethod !== 'squash' && mergeMethod !== 'rebase') throw invalid('PullRequest', 'merge_method', 'invalid', mergeMethod);
        const tips = store.pullTips(pull);
        const expected = str(body, 'sha');
        if (expected !== undefined && expected !== tips.head) throw new HttpError(409, 'Head branch was modified. Review and try the merge again.');
        const sha = store.mergePull(pull, mergeMethod, str(body, 'commit_title'), str(body, 'commit_message'));
        return this.json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
      }
    }
    throw new HttpError(404, 'Not Found');
  }
}
