// Model Context Protocol over Streamable HTTP at POST /mcp: JSON-RPC 2.0, the 2026-07-28 revision
// (server/discover, a revision on every request, no session) and the handshake revisions before it
// (initialize + notifications/initialized). Every tool is a thin adapter over a REST route of this forge, so
// a tool call and the matching REST call run the same code and answer the same objects.

import type { Reply, Request } from './http.ts';
import type { RestApi } from './rest.ts';

const MODERN = '2026-07-28';
const SUPPORTED = [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'anvil', title: 'Anvil git forge', version: '1.0.0' };
const INSTRUCTIONS = 'Anvil is a GitHub-compatible git forge. Tools act on its repositories, issues and pull requests; arguments follow github-mcp-server.';
const CAPABILITIES = { tools: { listChanged: false } };

interface Property {
  readonly type: 'string' | 'number' | 'boolean' | 'array';
  readonly description: string;
  readonly enum?: readonly string[];
  readonly items?: { readonly type: 'string' };
}

interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, Property>>;
  readonly required: readonly string[];
  readonly readOnly: boolean;
  /** The REST call the tool makes: method, path (under /api/v3), and the JSON body. */
  readonly call: (args: Readonly<Record<string, unknown>>) => { method: string; path: string; body?: unknown };
}

const s = (description: string, extra: Partial<Property> = {}): Property => ({ type: 'string', description, ...extra });
const n = (description: string): Property => ({ type: 'number', description });
const b = (description: string): Property => ({ type: 'boolean', description });
const list = (description: string): Property => ({ type: 'array', description, items: { type: 'string' } });

const OWNER = s('Repository owner (user or organization login)');
const REPO = s('Repository name');

const seg = (value: unknown): string => encodeURIComponent(String(value));
const repoPath = (args: Readonly<Record<string, unknown>>): string => `/repos/${seg(args.owner)}/${seg(args.repo)}`;

function query(entries: ReadonlyArray<readonly [string, unknown]>): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(value) ? value.join(',') : String(value))}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

const lower = (value: unknown): unknown => (typeof value === 'string' ? value.toLowerCase() : value);

const TOOLS: readonly Tool[] = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    properties: { name: s('Repository name'), description: s('Repository description'), private: b('Whether the repository is private'), autoInit: b('Initialize with a README commit') },
    required: ['name'],
    readOnly: false,
    call: (a) => ({ method: 'POST', path: '/user/repos', body: { name: a.name, description: a.description, private: a.private, auto_init: a.autoInit } }),
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Get a repository: its id, full name, visibility, default branch and description.',
    properties: { owner: OWNER, repo: REPO },
    required: ['owner', 'repo'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: repoPath(a) }),
  },
  {
    name: 'list_branches',
    title: 'List branches',
    description: 'List the branches of a repository with their tip commits.',
    properties: { owner: OWNER, repo: REPO, perPage: n('Results per page (1-100)'), page: n('Page number') },
    required: ['owner', 'repo'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/branches${query([['per_page', a.perPage], ['page', a.page]])}` }),
  },
  {
    name: 'create_branch',
    title: 'Create branch',
    description: 'Create a branch from another branch (the default branch when from_branch is omitted).',
    properties: { owner: OWNER, repo: REPO, branch: s('Name of the branch to create'), from_branch: s('Source branch (defaults to the default branch)') },
    required: ['owner', 'repo', 'branch'],
    readOnly: false,
    call: (a) => ({ method: 'POST', path: `${repoPath(a)}/git/refs`, body: { ref: `refs/heads/${String(a.branch)}`, sha: { fromBranch: a.from_branch ?? null } } }),
  },
  {
    name: 'list_commits',
    title: 'List commits',
    description: 'List the commits of a branch, tag or commit, newest first.',
    properties: { owner: OWNER, repo: REPO, sha: s('Branch, tag or commit SHA to list from'), perPage: n('Results per page (1-100)'), page: n('Page number') },
    required: ['owner', 'repo'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/commits${query([['sha', a.sha], ['per_page', a.perPage], ['page', a.page]])}` }),
  },
  {
    name: 'get_file_contents',
    title: 'Get file or directory contents',
    description: 'Get the contents of a file (base64) or the listing of a directory.',
    properties: { owner: OWNER, repo: REPO, path: s('Path to the file or directory (empty for the root)'), ref: s('Branch, tag or commit SHA') },
    required: ['owner', 'repo'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/contents/${String(a.path ?? '').split('/').map(seg).join('/')}${query([['ref', a.ref]])}` }),
  },
  {
    name: 'create_or_update_file',
    title: 'Create or update file',
    description: 'Create or update one file with a commit. Updating an existing file needs its current blob sha.',
    properties: { owner: OWNER, repo: REPO, path: s('Path of the file'), content: s('New file content (plain text)'), message: s('Commit message'), branch: s('Branch to commit to'), sha: s('Blob SHA of the file being replaced') },
    required: ['owner', 'repo', 'path', 'content', 'message'],
    readOnly: false,
    call: (a) => ({
      method: 'PUT',
      path: `${repoPath(a)}/contents/${String(a.path).split('/').map(seg).join('/')}`,
      body: { message: a.message, content: Buffer.from(String(a.content), 'utf8').toString('base64'), branch: a.branch, sha: a.sha },
    }),
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Create an issue in a repository.',
    properties: { owner: OWNER, repo: REPO, title: s('Issue title'), body: s('Issue body (Markdown)'), labels: list('Names of existing labels to apply') },
    required: ['owner', 'repo', 'title'],
    readOnly: false,
    call: (a) => ({ method: 'POST', path: `${repoPath(a)}/issues`, body: { title: a.title, body: a.body, labels: a.labels } }),
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, filtered by state and labels.',
    properties: {
      owner: OWNER,
      repo: REPO,
      state: s('Filter by state', { enum: ['open', 'closed', 'all'] }),
      labels: list('Only issues carrying all of these labels'),
      sort: s('Sort field', { enum: ['created', 'updated', 'comments'] }),
      direction: s('Sort direction', { enum: ['asc', 'desc'] }),
      perPage: n('Results per page (1-100)'),
      page: n('Page number'),
    },
    required: ['owner', 'repo'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/issues${query([['state', lower(a.state)], ['labels', a.labels], ['sort', lower(a.sort)], ['direction', lower(a.direction)], ['per_page', a.perPage], ['page', a.page]])}` }),
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Get one issue by its number.',
    properties: { owner: OWNER, repo: REPO, issue_number: n('Issue number') },
    required: ['owner', 'repo', 'issue_number'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/issues/${seg(a.issue_number)}` }),
  },
  {
    name: 'update_issue',
    title: 'Update issue',
    description: 'Edit an issue: its title, body, state or labels.',
    properties: { owner: OWNER, repo: REPO, issue_number: n('Issue number'), title: s('New title'), body: s('New body'), state: s('New state', { enum: ['open', 'closed'] }), labels: list('Replacement label names') },
    required: ['owner', 'repo', 'issue_number'],
    readOnly: false,
    call: (a) => ({ method: 'PATCH', path: `${repoPath(a)}/issues/${seg(a.issue_number)}`, body: { title: a.title, body: a.body, state: lower(a.state), labels: a.labels } }),
  },
  {
    name: 'add_issue_comment',
    title: 'Add issue comment',
    description: 'Add a comment to an issue or pull request.',
    properties: { owner: OWNER, repo: REPO, issue_number: n('Issue or pull request number'), body: s('Comment text') },
    required: ['owner', 'repo', 'issue_number', 'body'],
    readOnly: false,
    call: (a) => ({ method: 'POST', path: `${repoPath(a)}/issues/${seg(a.issue_number)}/comments`, body: { body: a.body } }),
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: { owner: OWNER, repo: REPO, title: s('Pull request title'), head: s('Branch with the changes'), base: s('Branch to merge into'), body: s('Pull request description'), draft: b('Open as a draft') },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    readOnly: false,
    call: (a) => ({ method: 'POST', path: `${repoPath(a)}/pulls`, body: { title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft } }),
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: OWNER,
      repo: REPO,
      state: s('Filter by state', { enum: ['open', 'closed', 'all'] }),
      head: s('Filter by head branch'),
      base: s('Filter by base branch'),
      perPage: n('Results per page (1-100)'),
      page: n('Page number'),
    },
    required: ['owner', 'repo'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/pulls${query([['state', lower(a.state)], ['head', a.head], ['base', a.base], ['per_page', a.perPage], ['page', a.page]])}` }),
  },
  {
    name: 'get_pull_request',
    title: 'Get pull request',
    description: 'Get one pull request: its state, refs, mergeability and merge result.',
    properties: { owner: OWNER, repo: REPO, pullNumber: n('Pull request number') },
    required: ['owner', 'repo', 'pullNumber'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/pulls/${seg(a.pullNumber)}` }),
  },
  {
    name: 'get_pull_request_files',
    title: 'Get pull request files',
    description: 'List the files a pull request changes, with their status and line counts.',
    properties: { owner: OWNER, repo: REPO, pullNumber: n('Pull request number') },
    required: ['owner', 'repo', 'pullNumber'],
    readOnly: true,
    call: (a) => ({ method: 'GET', path: `${repoPath(a)}/pulls/${seg(a.pullNumber)}/files` }),
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request (merge, squash or rebase).',
    properties: {
      owner: OWNER,
      repo: REPO,
      pullNumber: n('Pull request number'),
      merge_method: s('Merge method', { enum: ['merge', 'squash', 'rebase'] }),
      commit_title: s('Title of the merge commit'),
      commit_message: s('Extra detail for the merge commit'),
    },
    required: ['owner', 'repo', 'pullNumber'],
    readOnly: false,
    call: (a) => ({ method: 'PUT', path: `${repoPath(a)}/pulls/${seg(a.pullNumber)}/merge`, body: { merge_method: lower(a.merge_method) ?? 'squash', commit_title: a.commit_title, commit_message: a.commit_message } }),
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** tools/list's result, serialised once: the same bytes on every call. */
const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false },
  })),
});

type Id = string | number | null;

interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

class Failure extends Error {
  readonly error: RpcError;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.error = data === undefined ? { code, message } : { code, message, data };
  }
}

export class McpServer {
  readonly rest: RestApi;

  constructor(rest: RestApi) {
    this.rest = rest;
  }

  handle(request: Request, origin: string): Reply {
    if (request.method !== 'POST') {
      return { status: 405, head: 'content-type: application/json; charset=utf-8\r\nallow: POST\r\n', body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Method not allowed: this server answers POST only (no session stream)"}}' };
    }
    if (this.rest.authorize(request) !== 'ok') {
      return { status: 401, head: 'content-type: application/json; charset=utf-8\r\nwww-authenticate: Bearer realm="anvil"\r\n', body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Unauthorized: a Bearer token is required"}}' };
    }
    const sse = !(request.headers.accept ?? 'application/json').includes('application/json') && (request.headers.accept ?? '').includes('text/event-stream');
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body.toString('utf8'));
    } catch {
      return this.answer(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, false);
    }
    const headerVersion = request.headers['mcp-protocol-version'];
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return this.answer(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } }, false);
      const answers = parsed.map((message) => this.one(message, origin, headerVersion)).filter((answer) => answer !== null);
      if (answers.length === 0) return { status: 202, head: '', body: '' };
      return this.answer(200, answers, sse);
    }
    const answer = this.one(parsed, origin, headerVersion);
    if (answer === null) return { status: 202, head: '', body: '' };
    return this.answer(200, answer, sse);
  }

  answer(status: number, payload: unknown, sse: boolean): Reply {
    const text = JSON.stringify(payload);
    if (sse) return { status, head: 'content-type: text/event-stream\r\ncache-control: no-cache\r\n', body: `event: message\ndata: ${text}\n\n` };
    return { status, head: 'content-type: application/json; charset=utf-8\r\n', body: text };
  }

  /** One JSON-RPC message: its response, or null for a notification. */
  one(message: unknown, origin: string, headerVersion: string | undefined): Record<string, unknown> | null {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const record = message as Record<string, unknown>;
    const id = record.id as Id | undefined;
    const isNotification = id === undefined;
    if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') {
      if (isNotification && (record.result !== undefined || record.error !== undefined)) return null;
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (isNotification) return null;
    try {
      const result = this.dispatch(record.method, record.params, origin, headerVersion);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof Failure) return { jsonrpc: '2.0', id, error: err.error };
      return { jsonrpc: '2.0', id, error: { code: -32603, message: `Internal error: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  dispatch(method: string, params: unknown, origin: string, headerVersion: string | undefined): unknown {
    const p = typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    const meta = typeof p._meta === 'object' && p._meta !== null ? (p._meta as Record<string, unknown>) : {};
    const declared = (meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion ?? headerVersion) as unknown;
    if (method !== 'initialize' && typeof declared === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(declared) && !SUPPORTED.includes(declared)) {
      throw new Failure(-32022, `Unsupported protocol version ${declared}`, { supported: SUPPORTED, requested: declared });
    }
    switch (method) {
      case 'server/discover':
        return {
          supportedVersions: SUPPORTED,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        };
      case 'initialize': {
        const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
        const legacy = SUPPORTED.filter((version) => version !== MODERN);
        const chosen = legacy.includes(requested) ? requested : (legacy[0] as string);
        return { protocolVersion: chosen, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return JSON.parse(TOOLS_LIST_JSON) as unknown;
      case 'tools/call':
        return this.callTool(p, origin);
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new Failure(-32601, `Method not found: ${method}`);
    }
  }

  callTool(params: Record<string, unknown>, origin: string): unknown {
    const name = params.name;
    if (typeof name !== 'string' || name === '') throw new Failure(-32602, 'Invalid params: tools/call needs a tool name');
    const tool = BY_NAME.get(name) ?? BY_NAME.get(name.toLowerCase().replace(/^.*__/, ''));
    if (tool === undefined) throw new Failure(-32602, `Unknown tool: ${name}`);
    const raw = params.arguments;
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) throw new Failure(-32602, 'Invalid params: arguments must be an object');
    const args: Record<string, unknown> = { ...((raw ?? {}) as Record<string, unknown>) };
    const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) throw new Failure(-32602, `Invalid params: ${tool.name} is missing required argument(s): ${missing.join(', ')}`, { missing });
    for (const [key, property] of Object.entries(tool.properties)) {
      const value = args[key];
      if (value === undefined || value === null) continue;
      if (property.type === 'number') {
        const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
        if (typeof number !== 'number' || !Number.isFinite(number)) throw new Failure(-32602, `Invalid params: ${key} must be a number`);
        args[key] = number;
      } else if (property.type === 'boolean' && typeof value !== 'boolean') {
        if (value === 'true' || value === 'false') args[key] = value === 'true';
        else throw new Failure(-32602, `Invalid params: ${key} must be a boolean`);
      } else if (property.type === 'string' && typeof value !== 'string') {
        if (typeof value === 'number') args[key] = String(value);
        else throw new Failure(-32602, `Invalid params: ${key} must be a string`);
      } else if (property.type === 'array') {
        if (typeof value === 'string') args[key] = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
        else if (!Array.isArray(value)) throw new Failure(-32602, `Invalid params: ${key} must be an array`);
      }
    }
    let call = tool.call(args);
    if (tool.name === 'create_branch') {
      const source = typeof args.from_branch === 'string' && args.from_branch !== '' ? args.from_branch : null;
      const repo = this.rest.store.findRepo(String(args.owner), String(args.repo));
      const tip = repo === undefined ? null : this.rest.store.branchTip(repo, source ?? repo.defaultBranch);
      if (repo !== undefined && tip === null) return this.toolError(`The branch ${source ?? repo.defaultBranch} does not exist in ${String(args.owner)}/${String(args.repo)}.`);
      call = { ...call, body: { ref: `refs/heads/${String(args.branch)}`, sha: tip ?? '' } };
    }
    const reply = this.rest.handle(
      {
        method: call.method,
        path: `/api/v3${call.path.split('?')[0] as string}`,
        query: call.path.includes('?') ? call.path.slice(call.path.indexOf('?') + 1) : '',
        headers: { authorization: `Bearer ${this.rest.token}`, 'content-type': 'application/json', accept: 'application/vnd.github+json' },
        body: call.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(call.body), 'utf8'),
      },
      call.path.split('?')[0] as string,
      origin,
    );
    const text = typeof reply.body === 'string' ? reply.body : Buffer.isBuffer(reply.body) ? reply.body.toString('utf8') : Buffer.concat(reply.body as Buffer[]).toString('utf8');
    let value: unknown = null;
    try {
      value = text === '' ? null : JSON.parse(text);
    } catch {
      value = text;
    }
    if (reply.status >= 400) {
      const message = typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).message === 'string' ? (value as Record<string, unknown>).message : `HTTP ${reply.status}`;
      return this.toolError(`${tool.name} failed (HTTP ${reply.status}): ${String(message)}`);
    }
    if (tool.name === 'merge_pull_request' && value === null) value = { merged: true };
    const result: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) result.structuredContent = value;
    return result;
  }

  toolError(message: string): unknown {
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
