# Anvil

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, in strippable TypeScript on the standard library
alone: no compiled binary, no child process, no dependency. Real git clients clone from it and push to it,
`gh`-style REST and GraphQL calls read and write the same repositories, and an MCP endpoint gives agents the
same store as tools.

## Run it

```sh
node main.ts                                  # serves on an ephemeral port and prints it
ANVIL_PORT=8000 MAKEFUN_SHOP_TOKEN=secret node main.ts
git clone http://x:secret@127.0.0.1:8000/<viewer>/<repo>.git
```

Repositories are created through REST (`POST /api/v3/user/repos`). Every API call needs the bearer token in
`MAKEFUN_SHOP_TOKEN`; git accepts it as a Basic-auth password too. `ANVIL_DATA_DIR` makes the store durable:
its journal is replayed at boot.

## What it serves

| Surface | Where | What |
| --- | --- | --- |
| git smart HTTP | `/<owner>/<repo>.git` | upload-pack protocol v2 (`ls-refs`, `fetch` with shallow/deepen) and v0, receive-pack with report-status in side-band-64k, fast-forward enforcement per ref |
| REST v3 | `/api/v3` | repositories, contents, the Git Data API, branches, commits, labels, issues, comments, pull requests, files and merges, with ETags and Link paging |
| GraphQL v4 | `/api/graphql` | the schema `gh` and github-mcp-server query, introspection, batching, connections with cursors, and the issue and pull-request mutations |
| MCP | `/mcp` | JSON-RPC over Streamable HTTP, revision 2026-07-28 (`server/discover`) and the `initialize` handshake revisions, 17 tools |

## How it is built

- `src/http.ts`: HTTP/1.1 straight on `node:net`. Keep-alive, pipelining in order, one corked write a reply.
- `src/store.ts`: one store. Content-addressed git objects, refs per repository with a version counter that
  keys every derived cache, and the GitHub records. A logical clock (one tick per mutation, from the
  scenario epoch) stamps everything, so the same requests always build the same commit ids and JSON.
- `src/journal.ts`: an append-only, canonical-JSON journal written in batches off the request path.
- `src/git/`: the object model, packfiles (read with OFS/REF deltas and thin bases; write with self-verified
  OFS deltas) and the smart-HTTP protocol. Fetch answers are memoised per (ref version, request bytes), so
  fifty identical shallow clones build one pack.
- `src/graphql/`: a GraphQL lexer and parser, and an engine that validates a document against a schema
  written in SDL before running it. Introspection answers from the same definitions the executor uses.
- `src/mcp.ts`: every MCP tool is a thin adapter over a REST route, so the two surfaces cannot drift apart.

## License

MIT
