# Anvil: plan

A GitHub-compatible git forge in one Node 22 process, written in strippable TypeScript on the standard
library alone: no binary, no child process, no dependency, no network beyond the suite.

## What the kit actually grades

The suite ships in the kit (`program/env/src`), so the checks below are read from its source, not the prose.

- **Boot.** `node main.ts`; `listen(0)` (never 8080); POST `{"port"}` to `$MAKEFUN_ENV_URL/register` at once;
  answer `GET /healthz` 200 twice within 10 s; poll `GET /done` (the env answers at once, so it is a short
  poll with backoff, not a held request) and exit 0 on `{"done":true}`.
- **Identity.** The token is random (`shpat_<hex>`) and names no one. Every check acts as the scenario's
  viewer, `users[0]` of the fixed `SCENARIO_SEED` (`adaiversen`). The forge derives that login with the same
  seeded generator the contract publishes (`src/identity.ts`), overridable by `ANVIL_VIEWER`.
- **Checks, in run order:** git 30, repos 15, issues 15, pulls 20, protocol 5, graphql 20, mcp 15 (120).
  `feature = round(600 x passed/120)`, `agent = round(200 x mcp/15)`.
- **Perf:** four workloads, each `round(clamp(25 - 12.5 log2(t/T_ref), 0, 50))`, T_ref from the kit's
  calibration: push 1640.8 ms, clone 266.9 ms, read 2759.7 ms, write 349.0 ms.
- **Replay.** A final trial runs twice and `state.json` (pass bits only) must match byte for byte, so every
  check must pass deterministically: no flaky timeouts, no order-dependent races.

Where the brief and the kit differ, the kit wins: GraphQL is `POST /api/graphql` (not `/graphql`), and
`/done` is polled, not long-held.

## Layout

```
main.ts                 lifecycle: bind, register, poll /done, exit 0
src/identity.ts         the viewer login, derived from the published scenario seed
src/http.ts             HTTP/1.1 on node:net: keep-alive, Content-Length and chunked bodies, pipelining
src/store.ts            objects, refs, repos, issues, pulls; the journal; the logical clock and counters
src/git/objects.ts      SHA-1 object model: parse/build commit, tree, tag; reachability
src/git/pack.ts         packfile v2 read (OFS/REF deltas) and write (with ofs-delta encoding)
src/git/smart.ts        info/refs, upload-pack v2 (ls-refs, fetch, shallow), v0 fallback, receive-pack v0
src/rest.ts             REST v3 router and handlers
src/graphql.ts          a small GraphQL parser, schema, introspection and executor
src/mcp.ts              MCP JSON-RPC over Streamable HTTP (2026-07-28 discover + legacy initialize)
LICENSE                 MIT
```

## The four surfaces

**Git smart HTTP** (`/<owner>/<repo>.git/...`)
- `info/refs?service=git-upload-pack` with `Git-Protocol: version=2`: `version 2` + `agent`, `ls-refs=unborn`,
  `fetch=shallow`, `object-format=sha1`. Without it: v0 advertisement with the `# service=` preamble,
  `symref=HEAD:...`, peeled tags, `side-band-64k`, `shallow`, `ofs-delta`, `multi_ack_detailed`, `thin-pack`.
- `info/refs?service=git-receive-pack`: v0, `report-status`, `report-status-v2`, `side-band-64k`,
  `delete-refs`, `ofs-delta`; an empty repo advertises `capabilities^{}`.
- `ls-refs`: `peel`, `symrefs`, `unborn`, `ref-prefix`, filtered on the server.
- `fetch`: wants/haves/done, `shallow`/`deepen N`, `shallow-info` with `shallow`/`unshallow` lines, packfile
  in side-band-64k frames under 65520 bytes. The have-closure respects the client's shallow boundary.
- `receive-pack`: command list, pack decode (plain, OFS_DELTA, REF_DELTA, thin bases from the store),
  per-ref fast-forward check (ancestry walk from the new tip, bounded by commit generation), atomic
  apply of the accepted refs, `ok`/`ng <ref> non-fast-forward` report in band 1.
- Missing repo: 404 on both services. A malformed body: 400, the process stays up.

**REST v3** (`/api/v3`): root (`X-OAuth-Scopes`), `meta`, `user`, `user/repos` (Link `rel="next"` paging),
repos CRUD, `git/refs` (create, get), `git/blobs`, `git/trees`, `git/commits`, branches, commits (walk from a
ref), contents (get file or directory, PUT create/update with 409 on a stale sha, DELETE), labels, issues
(create with 422 on an unknown label, list with state/sort/direction/paging, get, patch), comments, pulls
(create, get, list, files with diff counts, squash merge with 405 on conflict, 404 on unknown). Every reply is
JSON with `X-GitHub-Request-Id`; 401 without the token; another owner's name is 404; malformed JSON is 400.
GET replies carry an `ETag` and honour `If-None-Match` with 304.

**GraphQL** (`/api/graphql`): a real lexer and parser (operations, variables, fragments, inline fragments,
aliases, list/object/enum literals, batched array bodies), a typed schema used both for execution and for
`__type`/`__schema` introspection, and unknown fields reported as 200 + `errors`. Queries: `viewer`,
`repository(owner,name)` (null when unknown), `node(id)`, issues/pullRequests connections with
`first/after`, `states`, `orderBy`, `pageInfo`. Mutations: `createIssue`, `closeIssue`, `addComment`,
`createPullRequest`, `mergePullRequest`. Global ids are opaque and stable (`R_`, `I_`, `PR_`, `IC_` prefixes
over base64url of the database id).

**MCP** (`/mcp`): JSON-RPC 2.0 over Streamable HTTP. `server/discover` (2026-07-28, `supportedVersions`
newest first) and the legacy `initialize` + `notifications/initialized` handshake both work. `tools/list`
returns a fixed, pre-serialised list (byte-identical every call) of github-mcp-server-named tools:
`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`, `add_issue_comment`,
`create_pull_request`, `get_pull_request`, `list_pull_requests`, `merge_pull_request`, `create_branch`,
`get_file_contents`. Each acts on the same store as REST. Unknown tool: -32602; missing argument: -32602;
bad JSON: HTTP 400 + -32700; no token: 401. Answers as `application/json` (SSE when the client only accepts
`text/event-stream`).

## The store

- **Objects:** one content-addressed map `oid -> {type, raw bytes}` shared by every repository (git dedupes
  by hash anyway), plus a lazily filled cache of each object's deflated form for pack output.
- **Refs:** per repository, an ordered map plus a `version` counter bumped on every ref change; every
  cache keyed by repository is keyed by that version, so a stale cache can never be served.
- **Domain records:** repositories by `owner/name` and by id; per repository an issue array indexed by
  number (O(1) reads), an open-issue index for list queries, labels, comments, pulls. Issue and pull numbers
  share one per-repo counter, as on GitHub.
- **Journal:** one append-only file (`$TMPDIR/anvil/journal.ndjson`), one canonical JSON line per mutation
  (keys sorted, objects by oid), written in one batched append per event-loop turn so a request never
  waits on the disk. At boot an existing journal is replayed to rebuild the store; a fresh trial starts
  empty. If the directory is not writable the forge runs in memory and says so on stderr.

## Determinism

- No wall clock, PID or random value reaches a response, an object or the journal. A logical clock starts
  at the scenario epoch (2025-01-01T00:00:00Z) and ticks one second per mutation, so commits the forge makes
  (contents API, merges) hash the same on every run, and `created_at`/`merged_at` are stable.
- Every id comes from a counter; request ids are a counter in hex; ETags are a SHA-1 of the body.
- JSON is serialised with a fixed key order per resource. The tool list and the GraphQL introspection
  answers are built once at boot.
- Proof: run the same practice instance twice and `diff` the two `state.json` exports.

## Performance budget

| Workload | What one op costs the forge | Plan | Server target |
| --- | --- | --- | --- |
| push, 200 sequential | GET receive-pack info/refs + POST receive-pack with a 3-object pack | advertisement bytes cached per ref version; inflate 3 objects; fast-forward is a one-step parent check; no repo walk | < 150 us |
| clone, 50 concurrent depth 1 | GET v2 info/refs + ls-refs + fetch deepen 1 | constant advertisement; ls-refs and the depth-1 fetch response cached per (repo version, request bytes), so after the first clone each answer is one socket write | < 50 us |
| read, 2,000 sequential | GET one issue | rendered issue bytes cached per issue revision; route matched without regex backtracking | < 20 us |
| write, 200 sequential | POST one issue | O(1) append, render once, batched journal append | < 60 us |

The suite's client (undici fetch in a gVisor pod) dominates every round trip, so the forge's job is to add as
little as possible: a raw `node:net` HTTP/1.1 server instead of `node:http`, `Nagle` off, one `write` per
response, no per-request allocation of header objects beyond what the route needs.

## Verification before any submission

1. `node cli/makefun.mjs check` clean; `grade-local` 120/120 on practice trials 0, 1 and 2.
2. The same trial twice, `state.json` diffed byte for byte.
3. Boot under 20 s, never binds 8080, `/healthz` 200; source under 16 MiB total and 8 MiB a file.
4. The four workload p50s recorded against T_ref, with the perf points they earn.
5. Bundle with the real declarations, every warning fixed, then submit.

## Time box

Deadline 2026-11-21 06:30 UTC. Target: a scoring entry by 2026-11-20 18:30 UTC, leaving room for one
failed check and a resubmit. Order of work: boot + store + REST (cheap checks, and every other surface
builds its fixtures through REST), then git, then MCP, then GraphQL, then performance.
