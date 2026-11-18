// HTTP/1.1 on node:net, written for this forge's traffic: one request at a time per connection (pipelined
// requests wait their turn, so answers leave in order), Content-Length and chunked request bodies, keep-alive
// by default, and every answer leaves in one corked write. No Date header and no other clock reaches a reply.

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
  /** Bytes the body still needs (Content-Length framing), or -1 for chunked. */
  need: number;
  parts: Buffer[];
  got: number;
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
function serveSocket(socket: Socket, handler: Handler): void {
  socket.setNoDelay(true);
  let buffered: Buffer = EMPTY;
  let pending: Pending | null = null;
  let busy = false;
  let closing = false;
  const queue: Array<{ request: Request; keepAlive: boolean }> = [];

  const fail = (status: number, message: string): void => {
    if (closing) return;
    closing = true;
    const body = `${JSON.stringify({ message })}\n`;
    socket.end(`${statusLine(status)}content-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  };

  const write = (reply: Reply, keepAlive: boolean, isHead: boolean): void => {
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
    if (isHead || length === 0 || reply.status === 204 || reply.status === 304) {
      socket.write(head, 'latin1');
    } else if (typeof body === 'string') {
      socket.write(head + body, 'utf8');
    } else if (length <= SMALL_REPLY) {
      // One buffer, one write: a small binary answer never costs a writev of many parts.
      const out = Buffer.allocUnsafe(head.length + length);
      out.write(head, 0, 'latin1');
      let at = head.length;
      for (const part of Buffer.isBuffer(body) ? [body] : (body as readonly Buffer[])) {
        part.copy(out, at);
        at += part.length;
      }
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
      const next = queue.shift() as { request: Request; keepAlive: boolean };
      let result: Reply | Promise<Reply>;
      try {
        result = handler(next.request);
      } catch (err) {
        result = internal(err);
      }
      if (result instanceof Promise) {
        busy = true;
        result.then(
          (reply) => {
            busy = false;
            write(reply, next.keepAlive, next.request.method === 'HEAD');
            drain();
          },
          (err: unknown) => {
            busy = false;
            write(internal(err), next.keepAlive, next.request.method === 'HEAD');
            drain();
          },
        );
        return;
      }
      write(result, next.keepAlive, next.request.method === 'HEAD');
    }
  };

  const enqueue = (p: Pending, body: Buffer): void => {
    queue.push({ request: { method: p.method, path: p.path, query: p.query, headers: p.headers, body }, keepAlive: p.keepAlive });
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
        const lineEnd = text.indexOf('\r\n');
        const requestLine = lineEnd < 0 ? text : text.slice(0, lineEnd);
        const firstSpace = requestLine.indexOf(' ');
        const lastSpace = requestLine.lastIndexOf(' ');
        if (firstSpace <= 0 || lastSpace <= firstSpace) {
          fail(400, 'Malformed request line');
          return;
        }
        const method = requestLine.slice(0, firstSpace);
        const target = requestLine.slice(firstSpace + 1, lastSpace);
        const version = requestLine.slice(lastSpace + 1);
        const headers: Record<string, string> = Object.create(null) as Record<string, string>;
        // Scan the header block in place: one indexOf per line, no array of lines, and a name is
        // lowercased or a value trimmed only when it needs it.
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
          if (!/^\d+$/.test(lengthText)) {
            fail(400, 'Bad Content-Length');
            return;
          }
          need = Number(lengthText);
          if (need > MAX_BODY_BYTES) {
            fail(413, 'Request body too large');
            return;
          }
        }
        if ((headers.expect ?? '').toLowerCase() === '100-continue') socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
        pending = { method, path, query: question < 0 ? '' : target.slice(question + 1), headers, keepAlive, need, parts: [], got: 0 };
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

export function createHttpServer(handler: Handler): Server {
  const server = createServer({ noDelay: true, keepAlive: true }, (socket) => serveSocket(socket, handler));
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
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
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
