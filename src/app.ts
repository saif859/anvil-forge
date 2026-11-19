// The forge's front door: one handler routing /healthz, /api/v3, /api/graphql, /mcp and the git smart-HTTP
// paths to their surfaces, all over the one store. Anything else is GitHub's JSON 404.

import { createHttpServer, decodeSegment, parseQuery, type Reply, type Request } from './http.ts';
import type { Server } from 'node:net';
import { resolveViewer } from './identity.ts';
import { Store } from './store.ts';
import { RestApi } from './rest.ts';
import { McpServer } from './mcp.ts';
import { GraphQLApi } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './git/smart.ts';

const HEALTH: Reply = { status: 200, head: 'content-type: application/json; charset=utf-8\r\n', body: '{"ok":true}' };
const NOT_FOUND_BODY = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}';
const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export interface Forge {
  readonly server: Server;
  readonly store: Store;
}

export function createForge(env: Readonly<Record<string, string | undefined>>): Forge {
  const store = new Store(resolveViewer(env), env);
  const rest = new RestApi(store, env.MAKEFUN_SHOP_TOKEN ?? '');
  const mcp = new McpServer(rest);
  const graphql = new GraphQLApi(store, rest);

  const notFound = (): Reply => ({ status: 404, head: rest.head(), body: NOT_FOUND_BODY });

  const git = (request: Request, match: RegExpExecArray): Reply => {
    const auth = rest.authorize(request);
    if (auth !== 'ok') {
      return { status: 401, head: 'content-type: text/plain; charset=utf-8\r\nwww-authenticate: Basic realm="anvil"\r\n', body: 'Authentication required\n' };
    }
    const owner = decodeSegment(match[1] as string);
    const name = decodeSegment(match[2] as string);
    const action = match[3] as string;
    const repo = store.findRepo(owner, name);
    if (repo === undefined) return { status: 404, head: 'content-type: text/plain; charset=utf-8\r\n', body: 'Repository not found\n' };
    if (action === 'info/refs') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, head: 'allow: GET\r\n', body: '' };
      const service = parseQuery(request.query).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return { status: 403, head: 'content-type: text/plain; charset=utf-8\r\n', body: 'Only the smart HTTP protocol is served\n' };
      }
      return infoRefs(store, repo, service, (request.headers['git-protocol'] ?? '').includes('version=2'));
    }
    if (request.method !== 'POST') return { status: 405, head: 'allow: POST\r\n', body: '' };
    return action === 'git-upload-pack' ? uploadPack(store, repo, request) : receivePack(store, repo, request);
  };

  const handler = (request: Request): Reply | Promise<Reply> => {
    const path = request.path;
    if (path === '/healthz') return HEALTH;
    const origin = `http://${request.headers.host ?? 'localhost'}`;
    if (path === '/api/v3' || path.startsWith('/api/v3/')) return rest.handle(request, path.slice(7), origin);
    if (path === '/api/graphql' || path === '/graphql') return graphql.handle(request, origin);
    if (path === '/mcp' || path === '/mcp/') return mcp.handle(request, origin);
    const match = GIT_PATH.exec(path);
    if (match !== null) return git(request, match);
    return notFound();
  };

  return { server: createHttpServer(handler, { nextRequestId: () => rest.nextRequestId() }), store };
}
