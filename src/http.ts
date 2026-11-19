// HTTP/1.1 on node:net, written for this forge's traffic: one request at a time per connection (pipelined
// requests wait their turn, so answers leave in order), Content-Length and chunked request bodies, keep-alive
// by default, and every answer leaves in one corked write. No Date header and no other clock reaches a reply.
// A repeated GET of something unchanged is answered from a cache of whole answers (AnswerCache below).

import { createServer, type Server, type Socket } from 'node:net';

export interface Request {
  readonly method: string;
  /** The request target's path, still percent-encoded. */
  readonly path: string;
  /** The query string without its '?', still encoded ('' when there is none). */
  readonly query: string;
  /** Header names lowercased; a repeated header keeps its last value. */
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export interface Reply {
  readonly status: number;
  /** Extra header lines, each `name: value\r\n`; content-length is added here. */
  readonly head: string;
  /** A string is sent as UTF-8; a list of buffers is written in order without being joined. */
  readonly body: string | Buffer | readonly Buffer[];
}

export type Handler = (request: Request) => Reply | Promise<Reply>;

const REASONS: Record<number, string> = {
  100: 'Continue', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 411: 'Length Required', 413: 'Payload Too Large',
  415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 431: 'Request Header Fields Too Large',
  500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
};

const MAX_HEAD_BYTES = 64 * 1024;
/** Replies up to this size are joined into one buffer before the write. */
const SMALL_REPLY = 64 * 1024;
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const HEAD_END = Buffer.from('\r\n\r\n', 'latin1');
const EMPTY = Buffer.alloc(0);

function statusLine(status: number): string {
  return `HTTP/1.1 ${status} ${REASONS[status] ?? 'Status'}\r\n`;
}

interface Pending {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  keepAlive: boolean;
  expectContinue: boolean;
  /** Bytes the body still needs (Content-Length framing), or -1 for chunked. */
  need: number;
  parts: Buffer[];
  got: number;
  /** The request head, when its answer may be kept in the answer cache. */
  key: string | null;
}

/** Why a request head was refused: the connection answers with it and closes. */
interface HeadError {
  readonly status: number;
  readonly message: string;
}

/** Parse a request head: the bytes before its blank line, read as latin1. */
function parseHead(text: string): Pending | HeadError {
  const lineEnd = text.indexOf('\r\n');
  const requestLine = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const firstSpace = requestLine.indexOf(' ');
  const lastSpace = requestLine.lastIndexOf(' ');
  if (firstSpace <= 0 || lastSpace <= firstSpace) return { status: 400, message: 'Malformed request line' };
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, lastSpace);
  const version = requestLine.slice(lastSpace + 1);
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  // Scan the header block in place: one indexOf per line, no array of lines, and a name is lowercased or a
  // value trimmed only when it needs it.
  let at = lineEnd < 0 ? text.length : lineEnd + 2;
  while (at < text.length) {
    let next = text.indexOf('\r\n', at);
    if (next < 0) next = text.length;
    const colon = text.indexOf(':', at);
    if (colon > at && colon < next) {
      let name = text.slice(at, colon);
      if (/[A-Z\s]/.test(name)) name = name.trim().toLowerCase();
      let from = colon + 1;
      while (from < next && (text.charCodeAt(from) === 32 || text.charCodeAt(from) === 9)) from += 1;
      let to = next;
      while (to > from && (text.charCodeAt(to - 1) === 32 || text.charCodeAt(to - 1) === 9)) to -= 1;
      headers[name] = text.slice(from, to);
    }
    at = next + 2;
  }
  const question = target.indexOf('?');
  const rawPath = question < 0 ? target : target.slice(0, question);
  const path = rawPath.startsWith('/') ? rawPath : rawPath.replace(/^[a-z]+:\/\/[^/]*/i, '') || '/';
  const connection = (headers.connection ?? '').toLowerCase();
  const keepAlive = version === 'HTTP/1.0' ? connection.includes('keep-alive') : !connection.includes('close');
  const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
  const lengthText = headers['content-length'];
  let need = 0;
  if (chunked) need = -1;
  else if (lengthText !== undefined) {
    if (!/^\d+$/.test(lengthText)) return { status: 400, message: 'Bad Content-Length' };
    need = Number(lengthText);
    if (need > MAX_BODY_BYTES) return { status: 413, message: 'Request body too large' };
  }
  const expectContinue = (headers.expect ?? '').toLowerCase() === '100-continue';
  return { method, path, query: question < 0 ? '' : target.slice(question + 1), headers, keepAlive, expectContinue, need, parts: [], got: 0, key: null };
}

// ---------------------------------------------------------------- the answer cache

/** Answers larger than this are never kept. */
const CACHE_MAX_ANSWER = 64 * 1024;
const CACHE_MAX_ENTRIES = 1024;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
/** The REST request id line: its 8 hex digits are renewed in every answer sent from the cache. */
const REQUEST_ID_MARK = 'x-github-request-id: ANVIL:';
const REQUEST_ID_DIGITS = 8;

interface CachedAnswer {
  readonly bytes: Buffer;
  /** Offset of the request id's hex digits in `bytes`, or -1 when the answer carries none. */
  readonly idAt: number;
}

/**
 * Whole answers to GET requests, keyed by the request's exact head (request line and every header, the
 * token, Accept and If-None-Match among them), so a repeated read of something unchanged is answered without
 * parsing, routing or rendering.
 *
 * Why a kept answer is always the one the handler would build again: every GET handler of this forge is a
 * function of the store and the request head alone (nothing reads a clock, a random source or the
 * connection; the store's logical clock moves only in mutations), and the cache is emptied before any
 * request that may change the store is handled: every method but GET and HEAD, except a git-upload-pack
 * POST, which only reads. Only a 200 answer to a keep-alive GET with no body and no Expect, built
 * synchronously, is kept. The REST request id is the one value that differs per answer, so an answer sent
 * again from the cache gets the next id, exactly as a freshly built one would.
 */
class AnswerCache {
  private readonly answers = new Map<string, CachedAnswer>();
  private bytes = 0;
  private readonly nextRequestId: (() => string) | undefined;

  constructor(nextRequestId: (() => string) | undefined) {
    this.nextRequestId = nextRequestId;
  }

  has(key: string): boolean {
    return this.answers.has(key);
  }

  get(key: string): CachedAnswer | undefined {
    return this.answers.get(key);
  }

  put(key: string, bytes: Buffer): void {
    if (bytes.length > CACHE_MAX_ANSWER) return;
    const headEnd = bytes.indexOf(HEAD_END);
    const mark = headEnd < 0 ? -1 : bytes.subarray(0, headEnd).indexOf(REQUEST_ID_MARK, 0, 'latin1');
    let idAt = -1;
    if (mark >= 0) {
      idAt = mark + REQUEST_ID_MARK.length;
      // Renewable only as the fixed-width id REST writes, and only when there is a source of new ids.
      if (this.nextRequestId === undefined || bytes.toString('latin1', idAt + REQUEST_ID_DIGITS, idAt + REQUEST_ID_DIGITS + 2) !== '\r\n') return;
    }
    if (this.answers.size >= CACHE_MAX_ENTRIES || this.bytes + bytes.length > CACHE_MAX_BYTES) this.clear();
    this.answers.set(key, { bytes, idAt });
    this.bytes += bytes.length;
  }

  clear(): void {
    if (this.answers.size === 0) return;
    this.answers.clear();
    this.bytes = 0;
  }

  /** The bytes to send for a kept answer: as kept, or a copy carrying the next request id. */
  answer(entry: CachedAnswer): Buffer {
    if (entry.idAt < 0) return entry.bytes;
    const id = (this.nextRequestId as () => string)();
    if (id.length !== REQUEST_ID_DIGITS) return entry.bytes;
    const out = Buffer.allocUnsafe(entry.bytes.length);
    entry.bytes.copy(out);
    out.write(id, entry.idAt, 'latin1');
    return out;
  }
}

/** Whether handling `request` can leave the store unchanged for certain. */
function readsOnly(request: Request): boolean {
  const method = request.method;
  return method === 'GET' || method === 'HEAD' || (method === 'POST' && request.path.endsWith('/git-upload-pack'));
}

interface Queued {
  /** null for a request whose head was in the answer cache when it was read: parsed only if needed. */
  request: Request | null;
  keepAlive: boolean;
  /** The head to keep this request's answer under (or to look it up by), or null. */
  key: string | null;
}

/** Decode a complete chunked body; null while it is incomplete, or 'bad' when it is malformed. */
function decodeChunked(data: Buffer): { body: Buffer; used: number } | null | 'bad' {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = data.indexOf('\r\n', at, 'latin1');
    if (lineEnd < 0) return data.length - at > 1024 ? 'bad' : null;
    const sizeText = data.toString('latin1', at, lineEnd).split(';')[0]?.trim() ?? '';
    if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) return 'bad';
    const size = Number.parseInt(sizeText, 16);
    at = lineEnd + 2;
    if (size === 0) {
      // Trailers, then an empty line.
      for (;;) {
        const end = data.indexOf('\r\n', at, 'latin1');
        if (end < 0) return null;
        const empty = end === at;
        at = end + 2;
        if (empty) return { body: parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts), used: at };
      }
    }
    if (data.length < at + size + 2) return null;
    parts.push(data.subarray(at, at + size));
    at += size + 2;
  }
}

/** Serve one connection: parse, dispatch in order, answer, repeat. */
function serveSocket(socket: Socket, handler: Handler, cache: AnswerCache): void {
  socket.setNoDelay(true);
  let buffered: Buffer = EMPTY;
  let pending: Pending | null = null;
  let busy = false;
  let closing = false;
  const queue: Queued[] = [];

  const fail = (status: number, message: string): void => {
    if (closing) return;
    closing = true;
    const body = `${JSON.stringify({ message })}\n`;
    socket.end(`${statusLine(status)}content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  };

  /** Send an answer; `key` (a GET's head) keeps a 200 answer in the answer cache. */
  const write = (reply: Reply, keepAlive: boolean, isHead: boolean, key: string | null): void => {
    if (socket.destroyed) return;
    const body = reply.body;
    let length: number;
    if (typeof body === 'string') length = Buffer.byteLength(body);
    else if (Buffer.isBuffer(body)) length = body.length;
    else {
      length = 0;
      for (const part of body as readonly Buffer[]) length += part.length;
    }
    const head = `${statusLine(reply.status)}${reply.head}content-length: ${length}\r\n${keepAlive ? '' : 'connection: close\r\n'}\r\n`;
    const keep = key !== null && reply.status === 200 && keepAlive && !isHead && length <= CACHE_MAX_ANSWER;
    if (isHead || length === 0 || reply.status === 204 || reply.status === 304) {
      socket.write(head, 'latin1');
    } else if (typeof body === 'string') {
      if (keep) {
        const bytes = Buffer.from(head + body, 'utf8');
        cache.put(key, bytes);
        socket.write(bytes);
      } else {
        socket.write(head + body, 'utf8');
      }
    } else if (length <= SMALL_REPLY) {
      // One buffer, one write: a small binary answer never costs a writev of many parts.
      const out = Buffer.allocUnsafe(head.length + length);
      out.write(head, 0, 'latin1');
      let at = head.length;
      for (const part of Buffer.isBuffer(body) ? [body] : (body as readonly Buffer[])) {
        part.copy(out, at);
        at += part.length;
      }
      if (keep) cache.put(key, out);
      socket.write(out);
    } else {
      socket.cork();
      socket.write(head, 'latin1');
      for (const part of Buffer.isBuffer(body) ? [body] : (body as readonly Buffer[])) socket.write(part);
      socket.uncork();
    }
    if (!keepAlive) {
      closing = true;
      socket.end();
    }
  };

  const internal = (err: unknown): Reply => {
    process.stderr.write(`[anvil] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return { status: 500, head: 'content-type: application/json; charset=utf-8\r\n', body: '{"message":"Internal Server Error"}\n' };
  };

  const drain = (): void => {
    while (!busy && queue.length > 0 && !closing) {
      const next = queue.shift() as Queued;
      let request = next.request;
      if (request === null) {
        // Its head was in the cache when it was read; whatever ran since may have emptied the cache.
        const kept = cache.get(next.key as string);
        if (kept !== undefined) {
          if (!socket.destroyed) socket.write(cache.answer(kept));
          continue;
        }
        const head = parseHead(next.key as string) as Pending; // it was kept, so it parsed before
        request = { method: head.method, path: head.path, query: head.query, headers: head.headers, body: EMPTY };
      }
      if (!readsOnly(request)) cache.clear();
      const isHead = request.method === 'HEAD';
      let result: Reply | Promise<Reply>;
      try {
        result = handler(request);
      } catch (err) {
        result = internal(err);
      }
      if (result instanceof Promise) {
        // An answer built asynchronously is never kept: the store may have moved meanwhile.
        busy = true;
        result.then(
          (reply) => {
            busy = false;
            write(reply, next.keepAlive, isHead, null);
            drain();
          },
          (err: unknown) => {
            busy = false;
            write(internal(err), next.keepAlive, isHead, null);
            drain();
          },
        );
        return;
      }
      write(result, next.keepAlive, isHead, next.key);
    }
  };

  const enqueue = (p: Pending, body: Buffer): void => {
    queue.push({ request: { method: p.method, path: p.path, query: p.query, headers: p.headers, body }, keepAlive: p.keepAlive, key: p.key });
  };

  /** Parse as many whole requests out of `buffered` as it holds. */
  const parse = (): void => {
    for (;;) {
      if (closing) return;
      if (pending === null) {
        if (buffered.length === 0) return;
        const end = buffered.indexOf(HEAD_END);
        if (end < 0) {
          if (buffered.length > MAX_HEAD_BYTES) fail(431, 'Request header fields too large');
          return;
        }
        const text = buffered.toString('latin1', 0, end);
        buffered = buffered.subarray(end + 4);
        if (cache.has(text)) {
          // A head the cache holds an answer for: a keep-alive GET with no body, so framing needs no parse.
          queue.push({ request: null, keepAlive: true, key: text });
          continue;
        }
        const head = parseHead(text);
        if ('message' in head) {
          fail(head.status, head.message);
          return;
        }
        if (head.expectContinue) socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
        else if (head.method === 'GET' && head.need === 0 && head.keepAlive) head.key = text;
        pending = head;
      }
      const p: Pending = pending;
      if (p.need === 0) {
        pending = null;
        enqueue(p, EMPTY);
        continue;
      }
      if (p.need < 0) {
        const decoded = decodeChunked(buffered);
        if (decoded === 'bad') {
          fail(400, 'Malformed chunked body');
          return;
        }
        if (decoded === null) {
          if (buffered.length > MAX_BODY_BYTES) fail(413, 'Request body too large');
          return;
        }
        buffered = buffered.subarray(decoded.used);
        pending = null;
        enqueue(p, decoded.body);
        continue;
      }
      const want = p.need - p.got;
      if (buffered.length === 0) return;
      if (buffered.length < want) {
        p.parts.push(buffered);
        p.got += buffered.length;
        buffered = EMPTY;
        return;
      }
      p.parts.push(buffered.subarray(0, want));
      buffered = buffered.subarray(want);
      pending = null;
      enqueue(p, p.parts.length === 1 ? (p.parts[0] as Buffer) : Buffer.concat(p.parts, p.need));
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (closing) return;
    if (pending !== null && pending.need > 0 && buffered.length === 0) {
      // Body bytes go straight into the body's parts: a large push is joined once, not per packet.
      buffered = chunk;
    } else {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    }
    parse();
    drain();
  });
  socket.on('error', () => {
    closing = true;
  });
  socket.on('close', () => {
    closing = true;
  });
}

export interface ServerOptions {
  /** The next REST request id (8 hex digits), for an answer sent again from the answer cache. */
  readonly nextRequestId?: () => string;
}

export function createHttpServer(handler: Handler, options: ServerOptions = {}): Server {
  const cache = new AnswerCache(options.nextRequestId);
  const server = createServer({ noDelay: true, keepAlive: true }, (socket) => serveSocket(socket, handler, cache));
  server.on('error', (err) => process.stderr.write(`[anvil] listener error: ${err.message}\n`));
  return server;
}

// ---------------------------------------------------------------- reply helpers

export const JSON_TYPE = 'content-type: application/json; charset=utf-8\r\n';

export function reply(status: number, head: string, body: string | Buffer | readonly Buffer[]): Reply {
  return { status, head, body };
}

export function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  if (query === '') return out;
  // Without '%' or '+' decoding changes nothing, so a plain query (?service=git-upload-pack) skips it.
  const plain = !query.includes('%') && !query.includes('+');
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    if (plain) {
      out.set(rawKey, rawValue);
      continue;
    }
    try {
      out.set(decodeURIComponent(rawKey.replace(/\+/g, ' ')), decodeURIComponent(rawValue.replace(/\+/g, ' ')));
    } catch {
      out.set(rawKey, rawValue);
    }
  }
  return out;
}

export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
