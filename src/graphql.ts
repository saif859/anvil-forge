// GitHub GraphQL v4 at POST /api/graphql: the schema gh and github-mcp-server read (written as SDL, so
// introspection describes exactly what executes), resolved over the forge's store. A batched body (a JSON
// array of operations) answers an array of results in order.

import { JSON_TYPE, type Reply, type Request } from './http.ts';
import { StoreError, isoOf, type Comment, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import { GraphQLError, Schema, type Args, type Resolver } from './graphql/engine.ts';
import { nodeId, parseNodeId, pullCommitList, stableNumber as stable, type View } from './render.ts';
import type { RestApi } from './rest.ts';

const SDL = `
"An object with an ID."
interface Node { id: ID! }
"An actor is a user or an organization."
interface Actor { login: String! avatarUrl(size: Int): String! url: String! }
"An owner of repositories."
interface RepositoryOwner { id: ID! login: String! url: String! avatarUrl(size: Int): String! repository(name: String!): Repository repositories(first: Int, after: String, last: Int, before: String): RepositoryConnection! }
"An object that can be closed."
interface Closable { closed: Boolean! closedAt: DateTime }
"A git object."
interface GitObject { id: ID! oid: GitObjectID! abbreviatedOid: String! }

scalar DateTime
scalar GitObjectID
scalar URI
scalar HTML
scalar GitTimestamp

type Query {
  "The currently authenticated user."
  viewer: User!
  "Look up a repository by owner and name."
  repository(owner: String!, name: String!, followRenames: Boolean = true): Repository
  repositoryOwner(login: String!): RepositoryOwner
  user(login: String!): User
  organization(login: String!): Organization
  "Fetches an object given its ID."
  node(id: ID!): Node
  nodes(ids: [ID!]!): [Node]!
  rateLimit(dryRun: Boolean = false): RateLimit
  search(query: String!, type: SearchType!, first: Int, after: String, last: Int, before: String): SearchResultItemConnection!
}

type RateLimit { cost: Int! limit: Int! nodeCount: Int! remaining: Int! resetAt: DateTime! used: Int! }

type User implements Node & Actor & RepositoryOwner {
  id: ID!
  databaseId: Int
  login: String!
  name: String
  email: String!
  bio: String
  company: String
  location: String
  url: String!
  avatarUrl(size: Int): String!
  createdAt: DateTime!
  isSiteAdmin: Boolean!
  repository(name: String!): Repository
  repositories(first: Int, after: String, last: Int, before: String, privacy: RepositoryPrivacy, ownerAffiliations: [RepositoryAffiliation], orderBy: RepositoryOrder): RepositoryConnection!
}

type Organization implements Node & Actor & RepositoryOwner {
  id: ID!
  databaseId: Int
  login: String!
  name: String
  url: String!
  avatarUrl(size: Int): String!
  repository(name: String!): Repository
  repositories(first: Int, after: String, last: Int, before: String, privacy: RepositoryPrivacy, orderBy: RepositoryOrder): RepositoryConnection!
}

enum RepositoryPrivacy { PUBLIC PRIVATE }
enum RepositoryAffiliation { OWNER COLLABORATOR ORGANIZATION_MEMBER }
enum RepositoryVisibility { PUBLIC PRIVATE INTERNAL }
"The access level a user has on a repository."
enum RepositoryPermission { ADMIN MAINTAIN WRITE TRIAGE READ }
input RepositoryOrder { field: RepositoryOrderField! direction: OrderDirection! }
enum RepositoryOrderField { CREATED_AT UPDATED_AT PUSHED_AT NAME STARGAZERS }
enum OrderDirection { ASC DESC }

type Repository implements Node {
  id: ID!
  databaseId: Int
  name: String!
  nameWithOwner: String!
  owner: RepositoryOwner!
  description: String
  url: URI!
  homepageUrl: URI
  sshUrl: String!
  isPrivate: Boolean!
  visibility: RepositoryVisibility!
  isArchived: Boolean!
  isFork: Boolean!
  isTemplate: Boolean!
  isEmpty: Boolean!
  isDisabled: Boolean!
  isLocked: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
  pushedAt: DateTime
  defaultBranchRef: Ref
  viewerPermission: RepositoryPermission
  viewerCanAdminister: Boolean!
  viewerHasStarred: Boolean!
  hasIssuesEnabled: Boolean!
  hasWikiEnabled: Boolean!
  hasProjectsEnabled: Boolean!
  hasDiscussionsEnabled: Boolean!
  mergeCommitAllowed: Boolean!
  squashMergeAllowed: Boolean!
  rebaseMergeAllowed: Boolean!
  deleteBranchOnMerge: Boolean!
  stargazerCount: Int!
  forkCount: Int!
  "Returns a single issue from the current repository by number."
  issue(number: Int!): Issue
  "A list of issues that have been opened in the repository."
  issues(first: Int, after: String, last: Int, before: String, states: [IssueState!], labels: [String!], orderBy: IssueOrder, filterBy: IssueFilters): IssueConnection!
  issueOrPullRequest(number: Int!): IssueOrPullRequest
  "Returns a single pull request from the current repository by number."
  pullRequest(number: Int!): PullRequest
  "A list of pull requests that have been opened in the repository."
  pullRequests(first: Int, after: String, last: Int, before: String, states: [PullRequestState!], labels: [String!], headRefName: String, baseRefName: String, orderBy: IssueOrder): PullRequestConnection!
  ref(qualifiedName: String!): Ref
  refs(refPrefix: String!, first: Int, after: String, last: Int, before: String, query: String, direction: OrderDirection, orderBy: RefOrder): RefConnection
  label(name: String!): Label
  labels(first: Int, after: String, last: Int, before: String, query: String, orderBy: LabelOrder): LabelConnection
  object(expression: String, oid: GitObjectID): GitObject
}

input RefOrder { field: RefOrderField! direction: OrderDirection! }
enum RefOrderField { TAG_COMMIT_DATE ALPHABETICAL }
input LabelOrder { field: LabelOrderField! direction: OrderDirection! }
enum LabelOrderField { NAME CREATED_AT }

type Ref implements Node {
  id: ID!
  name: String!
  prefix: String!
  target: GitObject
  repository: Repository!
}
type RefConnection { nodes: [Ref] edges: [RefEdge] pageInfo: PageInfo! totalCount: Int! }
type RefEdge { cursor: String! node: Ref }

type Commit implements Node & GitObject {
  id: ID!
  oid: GitObjectID!
  abbreviatedOid: String!
  message: String!
  messageHeadline: String!
  messageBody: String!
  committedDate: DateTime!
  authoredDate: DateTime!
  url: URI!
  author: GitActor
  committer: GitActor
  tree: Tree!
  parents(first: Int, after: String, last: Int, before: String): CommitConnection!
  history(first: Int, after: String, last: Int, before: String, path: String): CommitHistoryConnection!
}
type GitActor { name: String email: String date: GitTimestamp user: User }
type Tree implements Node & GitObject { id: ID! oid: GitObjectID! abbreviatedOid: String! }
type CommitConnection { nodes: [Commit] edges: [CommitEdge] pageInfo: PageInfo! totalCount: Int! }
type CommitHistoryConnection { nodes: [Commit] edges: [CommitEdge] pageInfo: PageInfo! totalCount: Int! }
type CommitEdge { cursor: String! node: Commit }

type PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String endCursor: String }

"The possible states of an issue."
enum IssueState { OPEN CLOSED }
enum IssueStateReason { COMPLETED NOT_PLANNED REOPENED DUPLICATE }
input IssueOrder { field: IssueOrderField! direction: OrderDirection! }
"Properties by which issue connections can be ordered."
enum IssueOrderField { CREATED_AT UPDATED_AT COMMENTS }
input IssueFilters { states: [IssueState!] labels: [String!] assignee: String createdBy: String mentioned: String since: DateTime viewerSubscribed: Boolean }

"An Issue is a place to discuss ideas, enhancements, tasks, and bugs for a project."
type Issue implements Node & Closable {
  id: ID!
  databaseId: Int
  number: Int!
  title: String!
  body: String!
  bodyText: String!
  bodyHTML: HTML!
  state: IssueState!
  stateReason: IssueStateReason
  closed: Boolean!
  closedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
  url: URI!
  locked: Boolean!
  author: Actor
  repository: Repository!
  labels(first: Int, after: String, last: Int, before: String): LabelConnection
  comments(first: Int, after: String, last: Int, before: String): IssueCommentConnection!
  assignees(first: Int, after: String, last: Int, before: String): UserConnection!
  viewerCanUpdate: Boolean!
  viewerDidAuthor: Boolean!
}
type IssueConnection { nodes: [Issue] edges: [IssueEdge] pageInfo: PageInfo! totalCount: Int! }
type IssueEdge { cursor: String! node: Issue }

type IssueComment implements Node {
  id: ID!
  databaseId: Int
  body: String!
  bodyText: String!
  author: Actor
  createdAt: DateTime!
  updatedAt: DateTime!
  url: URI!
  issue: Issue
  viewerDidAuthor: Boolean!
}
type IssueCommentConnection { nodes: [IssueComment] edges: [IssueCommentEdge] pageInfo: PageInfo! totalCount: Int! }
type IssueCommentEdge { cursor: String! node: IssueComment }

type Label implements Node { id: ID! name: String! color: String! description: String url: URI! isDefault: Boolean! }
type LabelConnection { nodes: [Label] edges: [LabelEdge] pageInfo: PageInfo! totalCount: Int! }
type LabelEdge { cursor: String! node: Label }

type UserConnection { nodes: [User] edges: [UserEdge] pageInfo: PageInfo! totalCount: Int! }
type UserEdge { cursor: String! node: User }

type RepositoryConnection { nodes: [Repository] edges: [RepositoryEdge] pageInfo: PageInfo! totalCount: Int! }
type RepositoryEdge { cursor: String! node: Repository }

"The possible states of a pull request."
enum PullRequestState { OPEN CLOSED MERGED }
"Whether or not a PullRequest can be merged."
enum MergeableState { MERGEABLE CONFLICTING UNKNOWN }
"Represents available types of methods to use when merging a pull request."
enum PullRequestMergeMethod { MERGE SQUASH REBASE }
enum PatchStatus { ADDED DELETED RENAMED COPIED MODIFIED CHANGED }

"A repository pull request."
type PullRequest implements Node & Closable {
  id: ID!
  databaseId: Int
  number: Int!
  title: String!
  body: String!
  bodyText: String!
  state: PullRequestState!
  merged: Boolean!
  mergedAt: DateTime
  mergeable: MergeableState!
  closed: Boolean!
  closedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
  url: URI!
  permalink: URI!
  isDraft: Boolean!
  locked: Boolean!
  headRefName: String!
  baseRefName: String!
  headRefOid: GitObjectID!
  baseRefOid: GitObjectID!
  headRef: Ref
  baseRef: Ref
  headRepository: Repository
  baseRepository: Repository
  headRepositoryOwner: RepositoryOwner
  repository: Repository!
  author: Actor
  additions: Int!
  deletions: Int!
  changedFiles: Int!
  files(first: Int, after: String, last: Int, before: String): PullRequestChangedFileConnection
  commits(first: Int, after: String, last: Int, before: String): PullRequestCommitConnection!
  mergeCommit: Commit
  labels(first: Int, after: String, last: Int, before: String): LabelConnection
  comments(first: Int, after: String, last: Int, before: String): IssueCommentConnection!
  assignees(first: Int, after: String, last: Int, before: String): UserConnection!
  reviewDecision: PullRequestReviewDecision
  maintainerCanModify: Boolean!
  viewerCanUpdate: Boolean!
}
enum PullRequestReviewDecision { CHANGES_REQUESTED APPROVED REVIEW_REQUIRED }
type PullRequestConnection { nodes: [PullRequest] edges: [PullRequestEdge] pageInfo: PageInfo! totalCount: Int! }
type PullRequestEdge { cursor: String! node: PullRequest }
type PullRequestChangedFile { path: String! additions: Int! deletions: Int! changeType: PatchStatus! }
type PullRequestChangedFileConnection { nodes: [PullRequestChangedFile] edges: [PullRequestChangedFileEdge] pageInfo: PageInfo! totalCount: Int! }
type PullRequestChangedFileEdge { cursor: String! node: PullRequestChangedFile }
type PullRequestCommit implements Node { id: ID! commit: Commit! url: URI! }
type PullRequestCommitConnection { nodes: [PullRequestCommit] edges: [PullRequestCommitEdge] pageInfo: PageInfo! totalCount: Int! }
type PullRequestCommitEdge { cursor: String! node: PullRequestCommit }

union IssueOrPullRequest = Issue | PullRequest
union SearchResultItem = Issue | PullRequest | Repository | User
"Represents the individual results of a search."
enum SearchType { ISSUE ISSUE_ADVANCED REPOSITORY USER DISCUSSION }
type SearchResultItemConnection { issueCount: Int! repositoryCount: Int! userCount: Int! discussionCount: Int! codeCount: Int! wikiCount: Int! nodes: [SearchResultItem] edges: [SearchResultItemEdge] pageInfo: PageInfo! }
type SearchResultItemEdge { cursor: String! node: SearchResultItem }

type Mutation {
  createIssue(input: CreateIssueInput!): CreateIssuePayload
  updateIssue(input: UpdateIssueInput!): UpdateIssuePayload
  closeIssue(input: CloseIssueInput!): CloseIssuePayload
  reopenIssue(input: ReopenIssueInput!): ReopenIssuePayload
  addComment(input: AddCommentInput!): AddCommentPayload
  createPullRequest(input: CreatePullRequestInput!): CreatePullRequestPayload
  mergePullRequest(input: MergePullRequestInput!): MergePullRequestPayload
  closePullRequest(input: ClosePullRequestInput!): ClosePullRequestPayload
  updatePullRequest(input: UpdatePullRequestInput!): UpdatePullRequestPayload
  createRef(input: CreateRefInput!): CreateRefPayload
  addLabelsToLabelable(input: AddLabelsToLabelableInput!): AddLabelsToLabelablePayload
}

input CreateIssueInput { repositoryId: ID! title: String! body: String labelIds: [ID!] assigneeIds: [ID!] milestoneId: ID projectIds: [ID!] issueTemplate: String clientMutationId: String }
type CreateIssuePayload { clientMutationId: String issue: Issue }
input UpdateIssueInput { id: ID! title: String body: String state: IssueState labelIds: [ID!] assigneeIds: [ID!] clientMutationId: String }
type UpdateIssuePayload { clientMutationId: String issue: Issue }
input CloseIssueInput { issueId: ID! stateReason: IssueStateReason duplicateIssueId: ID clientMutationId: String }
type CloseIssuePayload { clientMutationId: String issue: Issue }
input ReopenIssueInput { issueId: ID! clientMutationId: String }
type ReopenIssuePayload { clientMutationId: String issue: Issue }
input AddCommentInput { subjectId: ID! body: String! clientMutationId: String }
type AddCommentPayload { clientMutationId: String commentEdge: IssueCommentEdge subject: Node timelineEdge: IssueTimelineItemEdge }
type IssueTimelineItemEdge { cursor: String! node: IssueComment }
input CreatePullRequestInput { repositoryId: ID! baseRefName: String! headRefName: String! headRepositoryId: ID title: String! body: String draft: Boolean maintainerCanModify: Boolean clientMutationId: String }
type CreatePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
input MergePullRequestInput { pullRequestId: ID! mergeMethod: PullRequestMergeMethod commitHeadline: String commitBody: String expectedHeadOid: GitObjectID authorEmail: String clientMutationId: String }
type MergePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
input ClosePullRequestInput { pullRequestId: ID! clientMutationId: String }
type ClosePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
input UpdatePullRequestInput { pullRequestId: ID! title: String body: String state: PullRequestUpdateState baseRefName: String clientMutationId: String }
enum PullRequestUpdateState { OPEN CLOSED }
type UpdatePullRequestPayload { clientMutationId: String pullRequest: PullRequest }
input CreateRefInput { repositoryId: ID! name: String! oid: GitObjectID! clientMutationId: String }
type CreateRefPayload { clientMutationId: String ref: Ref }
input AddLabelsToLabelableInput { labelableId: ID! labelIds: [ID!]! clientMutationId: String }
type AddLabelsToLabelablePayload { clientMutationId: String labelable: Node }
`;

interface Context {
  readonly store: Store;
  readonly view: View;
}

interface UserValue {
  readonly kind: 'User' | 'Organization';
  readonly login: string;
}

interface CommentValue {
  readonly kind: 'IssueComment';
  readonly comment: Comment;
  readonly repo: Repo;
}

interface LabelValue {
  readonly kind: 'Label';
  readonly label: Label;
  readonly repo: Repo;
}

interface CommitValue {
  readonly kind: 'Commit' | 'Tree';
  readonly repo: Repo;
  readonly oid: string;
}

interface RefValue {
  readonly kind: 'Ref';
  readonly repo: Repo;
  readonly name: string;
}

const encodeCursor = (index: number): string => Buffer.from(`cursor:v2:${index}`, 'utf8').toString('base64');

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  const match = /^cursor:v2:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  if (match === null) throw new GraphQLError(`\`${cursor}\` does not appear to be a valid cursor.`, 'INVALID_CURSOR_ARGUMENTS');
  return Number(match[1]);
}

/** A Relay connection over an ordered list: cursors are 1-based positions in that list. */
function connection<T>(items: readonly T[], args: Args, extra: Record<string, unknown> = {}): Record<string, unknown> {
  let from = args.after === undefined || args.after === null ? 0 : decodeCursor(args.after);
  let to = args.before === undefined || args.before === null ? items.length : decodeCursor(args.before) - 1;
  from = Math.max(0, Math.min(from, items.length));
  to = Math.max(from, Math.min(to, items.length));
  const first = typeof args.first === 'number' ? args.first : null;
  const last = typeof args.last === 'number' ? args.last : null;
  if ((first !== null && first < 0) || (last !== null && last < 0)) throw new GraphQLError('`first` and `last` must be non-negative', 'INVALID_PAGINATION');
  if ((first ?? 0) > 100 || (last ?? 0) > 100) throw new GraphQLError('Requesting more than 100 records on the connection is not allowed.', 'EXCESSIVE_PAGINATION');
  if (first !== null) to = Math.min(to, from + first);
  if (last !== null) from = Math.max(from, to - last);
  if (first === null && last === null) to = Math.min(to, from + 100);
  const nodes = items.slice(from, to);
  return {
    nodes,
    edges: nodes.map((node, index) => ({ cursor: encodeCursor(from + index + 1), node })),
    pageInfo: {
      hasNextPage: to < items.length,
      hasPreviousPage: from > 0,
      startCursor: nodes.length === 0 ? null : encodeCursor(from + 1),
      endCursor: nodes.length === 0 ? null : encodeCursor(to),
    },
    totalCount: items.length,
    ...extra,
  };
}

function input(args: Args): Args {
  const value = args.input;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GraphQLError('Argument \'input\' on Field is required', 'ARGUMENT_REQUIRED');
  return value as Args;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new GraphQLError(`${field} can't be blank`, 'UNPROCESSABLE');
  return value;
}

function asDate(seconds: number | null): string | null {
  return seconds === null ? null : isoOf(seconds);
}

export class GraphQLApi {
  readonly store: Store;
  readonly rest: RestApi;
  readonly schema: Schema<Context>;

  constructor(store: Store, rest: RestApi) {
    this.store = store;
    this.rest = rest;
    this.schema = new Schema<Context>(SDL, this.resolvers(), (value) => {
      if (typeof value !== 'object' || value === null) return null;
      const kind = (value as { kind?: unknown }).kind;
      return typeof kind === 'string' ? kind : null;
    });
  }

  handle(request: Request, origin: string): Reply {
    const head = `${JSON_TYPE}x-github-request-id: ANVIL-GQL\r\n`;
    if (request.method !== 'POST') return { status: 404, head, body: '{"message":"Not Found","documentation_url":"https://docs.github.com/graphql"}' };
    if (this.rest.authorize(request) !== 'ok') {
      return { status: 401, head: `${head}www-authenticate: Bearer realm="anvil"\r\n`, body: '{"message":"This endpoint requires you to be authenticated.","documentation_url":"https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql"}' };
    }
    let body: unknown;
    try {
      body = JSON.parse(request.body.toString('utf8'));
    } catch {
      return { status: 400, head, body: '{"message":"Problems parsing JSON","documentation_url":"https://docs.github.com/graphql"}' };
    }
    const context: Context = { store: this.store, view: { store: this.store, origin } };
    const result = Array.isArray(body) ? body.map((entry) => this.run(entry, context)) : this.run(body, context);
    return { status: 200, head, body: JSON.stringify(result) };
  }

  run(entry: unknown, context: Context): unknown {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
    let variables: unknown = record.variables ?? {};
    if (typeof variables === 'string') {
      try {
        variables = variables.trim() === '' ? {} : JSON.parse(variables);
      } catch {
        return { errors: [{ message: 'Variables are invalid JSON.' }] };
      }
    }
    if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) variables = {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    return this.schema.execute(record.query, variables as Args, operationName, context);
  }

  // ------------------------------------------------------------ lookups

  findNode(context: Context, id: unknown): unknown {
    if (typeof id !== 'string') return null;
    const parsed = parseNodeId(id);
    if (parsed === null) return null;
    const store = context.store;
    const numeric = Number(parsed.key);
    switch (parsed.kind) {
      case 'Repository':
        return store.reposById.get(numeric) ?? null;
      case 'User':
        return numeric === store.viewer.id ? { kind: 'User', login: store.viewer.login } : null;
      case 'Organization': {
        const owner = [...store.repos.values()].find((repo) => nodeId('Organization', 900_000 + stable(repo.owner)) === id);
        return owner === undefined ? null : { kind: 'Organization', login: owner.owner };
      }
      case 'Issue':
        for (const repo of store.reposById.values()) for (const issue of repo.issues.values()) if (issue.id === numeric) return issue;
        return null;
      case 'PullRequest':
        for (const repo of store.reposById.values()) for (const pull of repo.pulls.values()) if (pull.id === numeric) return pull;
        return null;
      case 'IssueComment':
        for (const repo of store.reposById.values()) {
          for (const target of [...repo.issues.values(), ...repo.pulls.values()]) {
            const comment = target.comments.find((candidate) => candidate.id === numeric);
            if (comment !== undefined) return { kind: 'IssueComment', comment, repo } satisfies CommentValue;
          }
        }
        return null;
      case 'Label':
        for (const repo of store.reposById.values()) for (const label of repo.labels.values()) if (label.id === numeric) return { kind: 'Label', label, repo } satisfies LabelValue;
        return null;
      case 'Commit': {
        const [repoId, oid] = parsed.key.split(':');
        const repo = store.reposById.get(Number(repoId));
        return repo !== undefined && oid !== undefined && store.commit(oid) !== undefined ? ({ kind: 'Commit', repo, oid } satisfies CommitValue) : null;
      }
      case 'Ref': {
        const colon = parsed.key.indexOf(':');
        const repo = store.reposById.get(Number(parsed.key.slice(0, colon)));
        const name = parsed.key.slice(colon + 1);
        return repo !== undefined && repo.refs.has(name) ? ({ kind: 'Ref', repo, name } satisfies RefValue) : null;
      }
      default:
        return null;
    }
  }

  repoById(context: Context, id: unknown): Repo {
    const node = this.findNode(context, id);
    if (typeof node !== 'object' || node === null || (node as { kind?: string }).kind !== 'Repository') {
      throw new GraphQLError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
    }
    return node as Repo;
  }

  // ------------------------------------------------------------ resolvers

  resolvers(): Record<string, Resolver<Context>> {
    const owner = (login: string): UserValue => ({ kind: login.toLowerCase() === this.store.viewer.login.toLowerCase() ? 'User' : 'Organization', login });
    const repoUrl = (c: Context, repo: Repo): string => `${c.view.origin}/${repo.owner}/${repo.name}`;
    const issueList = (repo: Repo, args: Args): Issue[] => {
      const filter = (args.filterBy ?? {}) as Args;
      const states = (args.states ?? filter.states) as string[] | null | undefined;
      const labels = (args.labels ?? filter.labels) as string[] | null | undefined;
      const since = typeof filter.since === 'string' ? Date.parse(filter.since) / 1000 : Number.NaN;
      const items = [...repo.issues.values()].filter((issue) =>
        (states === undefined || states === null || states.length === 0 || states.includes(issue.state.toUpperCase())) &&
        (labels === undefined || labels === null || labels.length === 0 || labels.some((name) => issue.labels.some((label) => label.name.toLowerCase() === name.toLowerCase()))) &&
        (!Number.isFinite(since) || issue.updatedAt >= since));
      return ordered(items, args.orderBy as Args | null | undefined);
    };
    const pullState = (pull: Pull): string => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
    const mergeable = (c: Context, pull: Pull): string => (pull.state !== 'open' ? 'UNKNOWN' : c.store.pullMerge(pull).ok ? 'MERGEABLE' : 'CONFLICTING');
    const labelsOf = (repo: Repo, labels: readonly Label[], args: Args): unknown => connection(labels.map((label) => ({ kind: 'Label', label, repo } satisfies LabelValue)), args);
    const commentsOf = (repo: Repo, comments: readonly Comment[], args: Args): unknown => connection(comments.map((comment) => ({ kind: 'IssueComment', comment, repo } satisfies CommentValue)), args);
    const repositoriesOf = (c: Context, login: string, args: Args): unknown => {
      const repos = [...c.store.repos.values()].filter((repo) => repo.owner.toLowerCase() === login.toLowerCase() && (args.privacy === undefined || args.privacy === null || (args.privacy === 'PRIVATE') === repo.private));
      repos.sort((a, b) => a.id - b.id);
      return connection(repos, args);
    };
    const commitOf = (repo: Repo, oid: string): CommitValue => ({ kind: 'Commit', repo, oid });

    const r: Record<string, Resolver<Context>> = {
      'Query.viewer': (_p, _a, c) => ({ kind: 'User', login: c.store.viewer.login }),
      'Query.repository': (_p, a, c) => c.store.findRepo(String(a.owner), String(a.name)) ?? null,
      'Query.repositoryOwner': (_p, a, c) => this.ownerNode(c, String(a.login)),
      'Query.user': (_p, a, c) => (String(a.login).toLowerCase() === c.store.viewer.login.toLowerCase() ? { kind: 'User', login: c.store.viewer.login } : null),
      'Query.organization': (_p, a, c) => {
        const node = this.ownerNode(c, String(a.login));
        return node !== null && node.kind === 'Organization' ? node : null;
      },
      'Query.node': (_p, a, c) => this.findNode(c, a.id),
      'Query.nodes': (_p, a, c) => (Array.isArray(a.ids) ? a.ids.map((id) => this.findNode(c, id)) : []),
      'Query.rateLimit': () => ({ cost: 1, limit: 5000, nodeCount: 0, remaining: 5000, resetAt: isoOf(0), used: 0 }),
      'Query.search': (_p, a, c) => this.search(c, String(a.query), String(a.type), a),

      'User.id': (_p, _a, c) => nodeId('User', c.store.viewer.id),
      'User.databaseId': (_p, _a, c) => c.store.viewer.id,
      'User.name': (_p, _a, c) => c.store.viewer.name,
      'User.email': (_p, _a, c) => c.store.viewer.email,
      'User.bio': () => null,
      'User.company': () => null,
      'User.location': () => null,
      'User.url': (p: UserValue, _a, c) => `${c.view.origin}/${p.login}`,
      'User.avatarUrl': (p: UserValue, _a, c) => `${c.view.origin}/avatars/${p.login}`,
      'User.createdAt': () => isoOf(1_735_689_600),
      'User.isSiteAdmin': () => false,
      'User.repository': (p: UserValue, a, c) => c.store.findRepo(p.login, String(a.name)) ?? null,
      'User.repositories': (p: UserValue, a, c) => repositoriesOf(c, p.login, a),
      'Organization.id': (p: UserValue) => nodeId('Organization', 900_000 + stable(p.login)),
      'Organization.databaseId': (p: UserValue) => 900_000 + stable(p.login),
      'Organization.name': (p: UserValue) => p.login,
      'Organization.url': (p: UserValue, _a, c) => `${c.view.origin}/${p.login}`,
      'Organization.avatarUrl': (p: UserValue, _a, c) => `${c.view.origin}/avatars/${p.login}`,
      'Organization.repository': (p: UserValue, a, c) => c.store.findRepo(p.login, String(a.name)) ?? null,
      'Organization.repositories': (p: UserValue, a, c) => repositoriesOf(c, p.login, a),

      'Repository.id': (p: Repo) => nodeId('Repository', p.id),
      'Repository.databaseId': (p: Repo) => p.id,
      'Repository.nameWithOwner': (p: Repo) => `${p.owner}/${p.name}`,
      'Repository.owner': (p: Repo) => owner(p.owner),
      'Repository.url': (p: Repo, _a, c) => repoUrl(c, p),
      'Repository.homepageUrl': (p: Repo) => p.homepage,
      'Repository.sshUrl': (p: Repo, _a, c) => `${c.view.origin}/${p.owner}/${p.name}.git`,
      'Repository.isPrivate': (p: Repo) => p.private,
      'Repository.visibility': (p: Repo) => (p.private ? 'PRIVATE' : 'PUBLIC'),
      'Repository.isArchived': () => false,
      'Repository.isFork': () => false,
      'Repository.isTemplate': () => false,
      'Repository.isEmpty': (p: Repo) => p.refs.size === 0,
      'Repository.isDisabled': () => false,
      'Repository.isLocked': () => false,
      'Repository.createdAt': (p: Repo) => isoOf(p.createdAt),
      'Repository.updatedAt': (p: Repo) => isoOf(p.updatedAt),
      'Repository.pushedAt': (p: Repo) => asDate(p.pushedAt),
      'Repository.defaultBranchRef': (p: Repo) => (p.refs.has(`refs/heads/${p.defaultBranch}`) ? ({ kind: 'Ref', repo: p, name: `refs/heads/${p.defaultBranch}` } satisfies RefValue) : null),
      'Repository.viewerPermission': () => 'ADMIN',
      'Repository.viewerCanAdminister': () => true,
      'Repository.viewerHasStarred': () => false,
      'Repository.hasIssuesEnabled': (p: Repo) => p.hasIssues,
      'Repository.hasWikiEnabled': () => false,
      'Repository.hasProjectsEnabled': () => false,
      'Repository.hasDiscussionsEnabled': () => false,
      'Repository.mergeCommitAllowed': () => true,
      'Repository.squashMergeAllowed': () => true,
      'Repository.rebaseMergeAllowed': () => true,
      'Repository.deleteBranchOnMerge': () => false,
      'Repository.stargazerCount': () => 0,
      'Repository.forkCount': () => 0,
      'Repository.issue': (p: Repo, a) => p.issues.get(Number(a.number)) ?? null,
      'Repository.issues': (p: Repo, a) => connection(issueList(p, a), a),
      'Repository.issueOrPullRequest': (p: Repo, a) => p.issues.get(Number(a.number)) ?? p.pulls.get(Number(a.number)) ?? null,
      'Repository.pullRequest': (p: Repo, a) => p.pulls.get(Number(a.number)) ?? null,
      'Repository.pullRequests': (p: Repo, a) => {
        const states = a.states as string[] | null | undefined;
        const labels = a.labels as string[] | null | undefined;
        const items = [...p.pulls.values()].filter((pull) =>
          (states === undefined || states === null || states.length === 0 || states.includes(pullState(pull))) &&
          (a.headRefName === undefined || a.headRefName === null || pull.head === a.headRefName) &&
          (a.baseRefName === undefined || a.baseRefName === null || pull.base === a.baseRefName) &&
          (labels === undefined || labels === null || labels.length === 0 || labels.some((name) => pull.labels.some((label) => label.name.toLowerCase() === name.toLowerCase()))));
        return connection(ordered(items, a.orderBy as Args | null | undefined), a);
      },
      'Repository.ref': (p: Repo, a) => {
        const name = String(a.qualifiedName);
        for (const candidate of [name, `refs/heads/${name}`, `refs/tags/${name}`]) if (p.refs.has(candidate)) return { kind: 'Ref', repo: p, name: candidate } satisfies RefValue;
        return null;
      },
      'Repository.refs': (p: Repo, a) => {
        const prefix = String(a.refPrefix);
        const names = [...p.refs.keys()].filter((name) => name.startsWith(prefix) && (typeof a.query !== 'string' || name.includes(a.query))).sort();
        if (a.direction === 'DESC' || (a.orderBy as Args | undefined)?.direction === 'DESC') names.reverse();
        return connection(names.map((name) => ({ kind: 'Ref', repo: p, name } satisfies RefValue)), a);
      },
      'Repository.label': (p: Repo, a) => {
        const label = p.labels.get(String(a.name).toLowerCase());
        return label === undefined ? null : ({ kind: 'Label', label, repo: p } satisfies LabelValue);
      },
      'Repository.labels': (p: Repo, a) => {
        const query = typeof a.query === 'string' ? a.query.toLowerCase() : '';
        return labelsOf(p, [...p.labels.values()].filter((label) => label.name.toLowerCase().includes(query)).sort((x, y) => x.id - y.id), a);
      },
      'Repository.object': (p: Repo, a, c) => {
        const expression = typeof a.oid === 'string' ? a.oid : typeof a.expression === 'string' ? a.expression : '';
        const oid = c.store.resolveRef(p, expression.replace(/:.*$/, ''));
        return oid === null ? null : commitOf(p, oid);
      },

      'Ref.id': (p: RefValue) => nodeId('Ref', `${p.repo.id}:${p.name}`),
      'Ref.name': (p: RefValue) => p.name.replace(/^refs\/(heads|tags)\//, ''),
      'Ref.prefix': (p: RefValue) => (/^refs\/(heads|tags)\//.exec(p.name)?.[0] ?? 'refs/'),
      'Ref.target': (p: RefValue, _a, c) => {
        const oid = p.repo.refs.get(p.name);
        return oid === undefined ? null : commitOf(p.repo, c.store.peel(oid));
      },
      'Ref.repository': (p: RefValue) => p.repo,

      'Commit.id': (p: CommitValue) => nodeId('Commit', `${p.repo.id}:${p.oid}`),
      'Commit.oid': (p: CommitValue) => p.oid,
      'Commit.abbreviatedOid': (p: CommitValue) => p.oid.slice(0, 7),
      'Commit.message': (p: CommitValue, _a, c) => (c.store.commit(p.oid)?.message ?? '').replace(/\n$/, ''),
      'Commit.messageHeadline': (p: CommitValue, _a, c) => (c.store.commit(p.oid)?.message ?? '').split('\n')[0] ?? '',
      'Commit.messageBody': (p: CommitValue, _a, c) => (c.store.commit(p.oid)?.message ?? '').split('\n').slice(2).join('\n').replace(/\n$/, ''),
      'Commit.committedDate': (p: CommitValue, _a, c) => isoOf(c.store.commit(p.oid)?.committer.time ?? 0),
      'Commit.authoredDate': (p: CommitValue, _a, c) => isoOf(c.store.commit(p.oid)?.author.time ?? 0),
      'Commit.url': (p: CommitValue, _a, c) => `${repoUrl(c, p.repo)}/commit/${p.oid}`,
      'Commit.author': (p: CommitValue, _a, c) => this.gitActor(c, c.store.commit(p.oid)?.author),
      'Commit.committer': (p: CommitValue, _a, c) => this.gitActor(c, c.store.commit(p.oid)?.committer),
      'Commit.tree': (p: CommitValue, _a, c) => ({ kind: 'Tree', repo: p.repo, oid: c.store.commit(p.oid)?.tree ?? '' }),
      'Commit.parents': (p: CommitValue, a, c) => connection((c.store.commit(p.oid)?.parents ?? []).map((oid) => commitOf(p.repo, oid)), a),
      'Commit.history': (p: CommitValue, a, c) => connection(c.store.history(p.oid, 1000).map((oid) => commitOf(p.repo, oid)), a),
      'Tree.id': (p: CommitValue) => nodeId('Commit', `${p.repo.id}:${p.oid}`),
      'Tree.oid': (p: CommitValue) => p.oid,
      'Tree.abbreviatedOid': (p: CommitValue) => p.oid.slice(0, 7),

      'Issue.id': (p: Issue) => nodeId('Issue', p.id),
      'Issue.databaseId': (p: Issue) => p.id,
      'Issue.body': (p: Issue) => p.body ?? '',
      'Issue.bodyText': (p: Issue) => p.body ?? '',
      'Issue.bodyHTML': (p: Issue) => escapeHtml(p.body ?? ''),
      'Issue.state': (p: Issue) => p.state.toUpperCase(),
      'Issue.stateReason': (p: Issue) => (p.stateReason === null ? null : p.stateReason.toUpperCase().replace(/ /g, '_')),
      'Issue.closed': (p: Issue) => p.state === 'closed',
      'Issue.closedAt': (p: Issue) => asDate(p.closedAt),
      'Issue.createdAt': (p: Issue) => isoOf(p.createdAt),
      'Issue.updatedAt': (p: Issue) => isoOf(p.updatedAt),
      'Issue.url': (p: Issue, _a, c) => `${repoUrl(c, p.repo)}/issues/${p.number}`,
      'Issue.locked': () => false,
      'Issue.author': (_p, _a, c) => ({ kind: 'User', login: c.store.viewer.login }),
      'Issue.labels': (p: Issue, a) => labelsOf(p.repo, p.labels, a),
      'Issue.comments': (p: Issue, a) => commentsOf(p.repo, p.comments, a),
      'Issue.assignees': (_p, a) => connection([], a),
      'Issue.viewerCanUpdate': () => true,
      'Issue.viewerDidAuthor': () => true,

      'IssueComment.id': (p: CommentValue) => nodeId('IssueComment', p.comment.id),
      'IssueComment.databaseId': (p: CommentValue) => p.comment.id,
      'IssueComment.body': (p: CommentValue) => p.comment.body,
      'IssueComment.bodyText': (p: CommentValue) => p.comment.body,
      'IssueComment.author': (_p, _a, c) => ({ kind: 'User', login: c.store.viewer.login }),
      'IssueComment.createdAt': (p: CommentValue) => isoOf(p.comment.createdAt),
      'IssueComment.updatedAt': (p: CommentValue) => isoOf(p.comment.updatedAt),
      'IssueComment.url': (p: CommentValue, _a, c) => `${repoUrl(c, p.repo)}/issues/${p.comment.number}#issuecomment-${p.comment.id}`,
      'IssueComment.issue': (p: CommentValue) => p.repo.issues.get(p.comment.number) ?? null,
      'IssueComment.viewerDidAuthor': () => true,

      'Label.id': (p: LabelValue) => nodeId('Label', p.label.id),
      'Label.name': (p: LabelValue) => p.label.name,
      'Label.color': (p: LabelValue) => p.label.color,
      'Label.description': (p: LabelValue) => p.label.description,
      'Label.url': (p: LabelValue, _a, c) => `${repoUrl(c, p.repo)}/labels/${encodeURIComponent(p.label.name)}`,
      'Label.isDefault': () => false,

      'PullRequest.id': (p: Pull) => nodeId('PullRequest', p.id),
      'PullRequest.databaseId': (p: Pull) => p.id,
      'PullRequest.body': (p: Pull) => p.body ?? '',
      'PullRequest.bodyText': (p: Pull) => p.body ?? '',
      'PullRequest.state': (p: Pull) => pullState(p),
      'PullRequest.mergedAt': (p: Pull) => asDate(p.mergedAt),
      'PullRequest.mergeable': (p: Pull, _a, c) => mergeable(c, p),
      'PullRequest.closed': (p: Pull) => p.state === 'closed',
      'PullRequest.closedAt': (p: Pull) => asDate(p.closedAt),
      'PullRequest.createdAt': (p: Pull) => isoOf(p.createdAt),
      'PullRequest.updatedAt': (p: Pull) => isoOf(p.updatedAt),
      'PullRequest.url': (p: Pull, _a, c) => `${repoUrl(c, p.repo)}/pull/${p.number}`,
      'PullRequest.permalink': (p: Pull, _a, c) => `${repoUrl(c, p.repo)}/pull/${p.number}`,
      'PullRequest.isDraft': (p: Pull) => p.draft,
      'PullRequest.locked': () => false,
      'PullRequest.headRefName': (p: Pull) => p.head,
      'PullRequest.baseRefName': (p: Pull) => p.base,
      'PullRequest.headRefOid': (p: Pull, _a, c) => c.store.pullTips(p).head,
      'PullRequest.baseRefOid': (p: Pull, _a, c) => c.store.pullTips(p).base,
      'PullRequest.headRef': (p: Pull) => (p.repo.refs.has(`refs/heads/${p.head}`) ? ({ kind: 'Ref', repo: p.repo, name: `refs/heads/${p.head}` } satisfies RefValue) : null),
      'PullRequest.baseRef': (p: Pull) => (p.repo.refs.has(`refs/heads/${p.base}`) ? ({ kind: 'Ref', repo: p.repo, name: `refs/heads/${p.base}` } satisfies RefValue) : null),
      'PullRequest.headRepository': (p: Pull) => p.repo,
      'PullRequest.baseRepository': (p: Pull) => p.repo,
      'PullRequest.headRepositoryOwner': (p: Pull) => owner(p.repo.owner),
      'PullRequest.repository': (p: Pull) => p.repo,
      'PullRequest.author': (_p, _a, c) => ({ kind: 'User', login: c.store.viewer.login }),
      'PullRequest.additions': (p: Pull, _a, c) => c.store.pullFiles(p).reduce((sum, file) => sum + file.additions, 0),
      'PullRequest.deletions': (p: Pull, _a, c) => c.store.pullFiles(p).reduce((sum, file) => sum + file.deletions, 0),
      'PullRequest.changedFiles': (p: Pull, _a, c) => c.store.pullFiles(p).length,
      'PullRequest.files': (p: Pull, a, c) =>
        connection(c.store.pullFiles(p).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' })), a),
      'PullRequest.commits': (p: Pull, a, c) => connection(pullCommitList(c.store, p).map((oid) => ({ kind: 'PullRequestCommit', id: nodeId('Commit', `${p.repo.id}:${oid}`), commit: commitOf(p.repo, oid), url: `${repoUrl(c, p.repo)}/pull/${p.number}/commits/${oid}` })), a),
      'PullRequest.mergeCommit': (p: Pull) => (p.mergeCommitSha === null ? null : commitOf(p.repo, p.mergeCommitSha)),
      'PullRequest.labels': (p: Pull, a) => labelsOf(p.repo, p.labels, a),
      'PullRequest.comments': (p: Pull, a) => commentsOf(p.repo, p.comments, a),
      'PullRequest.assignees': (_p, a) => connection([], a),
      'PullRequest.reviewDecision': () => null,
      'PullRequest.maintainerCanModify': () => false,
      'PullRequest.viewerCanUpdate': () => true,

      'Mutation.createIssue': (_p, a, c) => {
        const i = input(a);
        const repo = this.repoById(c, i.repositoryId);
        const labels = Array.isArray(i.labelIds) ? i.labelIds.map((id) => this.labelById(c, repo, id)) : [];
        const issue = c.store.createIssue(repo, { title: text(i.title, 'Title'), body: typeof i.body === 'string' ? i.body : null, labels });
        return { clientMutationId: i.clientMutationId ?? null, issue };
      },
      'Mutation.updateIssue': (_p, a, c) => {
        const i = input(a);
        const issue = this.issueById(c, i.id);
        c.store.updateIssue(issue, {
          title: typeof i.title === 'string' ? i.title : undefined,
          body: typeof i.body === 'string' ? i.body : undefined,
          state: i.state === 'OPEN' ? 'open' : i.state === 'CLOSED' ? 'closed' : undefined,
          labels: Array.isArray(i.labelIds) ? i.labelIds.map((id) => this.labelById(c, issue.repo, id)) : undefined,
        });
        return { clientMutationId: i.clientMutationId ?? null, issue };
      },
      'Mutation.closeIssue': (_p, a, c) => {
        const i = input(a);
        const issue = this.issueById(c, i.issueId);
        c.store.updateIssue(issue, { state: 'closed', stateReason: typeof i.stateReason === 'string' ? i.stateReason.toLowerCase() : 'completed' });
        return { clientMutationId: i.clientMutationId ?? null, issue };
      },
      'Mutation.reopenIssue': (_p, a, c) => {
        const i = input(a);
        const issue = this.issueById(c, i.issueId);
        c.store.updateIssue(issue, { state: 'open' });
        return { clientMutationId: i.clientMutationId ?? null, issue };
      },
      'Mutation.addComment': (_p, a, c) => {
        const i = input(a);
        const subject = this.findNode(c, i.subjectId) as Issue | Pull | null;
        if (subject === null || (subject.kind !== 'Issue' && subject.kind !== 'PullRequest')) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(i.subjectId)}'`, 'NOT_FOUND');
        const comment = c.store.addComment(subject.repo, subject, text(i.body, 'Body'));
        const node: CommentValue = { kind: 'IssueComment', comment, repo: subject.repo };
        const edge = { cursor: encodeCursor(subject.comments.length), node };
        return { clientMutationId: i.clientMutationId ?? null, commentEdge: edge, subject, timelineEdge: edge };
      },
      'Mutation.createPullRequest': (_p, a, c) => {
        const i = input(a);
        const repo = this.repoById(c, i.repositoryId);
        const head = text(i.headRefName, 'Head ref').replace(/^.*:/, '').replace(/^refs\/heads\//, '');
        const base = text(i.baseRefName, 'Base ref').replace(/^refs\/heads\//, '');
        if (c.store.branchTip(repo, head) === null) throw new GraphQLError(`Head sha can't be blank, Base sha can't be blank, No commits between ${base} and ${head}, Head ref must be a branch`, 'UNPROCESSABLE');
        if (c.store.branchTip(repo, base) === null) throw new GraphQLError('Base ref must be a branch', 'UNPROCESSABLE');
        try {
          const pull = c.store.createPull(repo, { title: text(i.title, 'Title'), body: typeof i.body === 'string' ? i.body : null, head, base, draft: i.draft === true });
          return { clientMutationId: i.clientMutationId ?? null, pullRequest: pull };
        } catch (err) {
          if (err instanceof StoreError) throw new GraphQLError(err.message, 'UNPROCESSABLE');
          throw err;
        }
      },
      'Mutation.mergePullRequest': (_p, a, c) => {
        const i = input(a);
        const pull = this.pullById(c, i.pullRequestId);
        if (pull.merged || pull.state !== 'open') throw new GraphQLError('Pull request is not mergeable', 'UNPROCESSABLE');
        if (typeof i.expectedHeadOid === 'string' && i.expectedHeadOid !== c.store.pullTips(pull).head) throw new GraphQLError('Head branch was modified. Review and try the merge again.', 'UNPROCESSABLE');
        const method = i.mergeMethod === 'SQUASH' ? 'squash' : i.mergeMethod === 'REBASE' ? 'rebase' : 'merge';
        try {
          c.store.mergePull(pull, method, typeof i.commitHeadline === 'string' ? i.commitHeadline : undefined, typeof i.commitBody === 'string' ? i.commitBody : undefined);
        } catch (err) {
          if (err instanceof StoreError) throw new GraphQLError('Pull request is not mergeable', 'UNPROCESSABLE');
          throw err;
        }
        return { clientMutationId: i.clientMutationId ?? null, pullRequest: pull };
      },
      'Mutation.closePullRequest': (_p, a, c) => {
        const i = input(a);
        const pull = this.pullById(c, i.pullRequestId);
        c.store.updatePull(pull, { state: 'closed' });
        return { clientMutationId: i.clientMutationId ?? null, pullRequest: pull };
      },
      'Mutation.updatePullRequest': (_p, a, c) => {
        const i = input(a);
        const pull = this.pullById(c, i.pullRequestId);
        c.store.updatePull(pull, {
          title: typeof i.title === 'string' ? i.title : undefined,
          body: typeof i.body === 'string' ? i.body : undefined,
          state: i.state === 'OPEN' ? 'open' : i.state === 'CLOSED' ? 'closed' : undefined,
          base: typeof i.baseRefName === 'string' ? i.baseRefName : undefined,
        });
        return { clientMutationId: i.clientMutationId ?? null, pullRequest: pull };
      },
      'Mutation.createRef': (_p, a, c) => {
        const i = input(a);
        const repo = this.repoById(c, i.repositoryId);
        const name = text(i.name, 'Name');
        const oid = text(i.oid, 'Oid');
        if (!name.startsWith('refs/')) throw new GraphQLError('Ref name must start with refs/', 'UNPROCESSABLE');
        if (repo.refs.has(name)) throw new GraphQLError('A ref named that already exists', 'UNPROCESSABLE');
        if (c.store.object(oid) === undefined) throw new GraphQLError('Object does not exist', 'UNPROCESSABLE');
        c.store.setRefs(repo, [[name, oid]]);
        return { clientMutationId: i.clientMutationId ?? null, ref: { kind: 'Ref', repo, name } satisfies RefValue };
      },
      'Mutation.addLabelsToLabelable': (_p, a, c) => {
        const i = input(a);
        const target = this.findNode(c, i.labelableId) as Issue | Pull | null;
        if (target === null || (target.kind !== 'Issue' && target.kind !== 'PullRequest')) throw new GraphQLError('Could not resolve to a Labelable', 'NOT_FOUND');
        const labels = (Array.isArray(i.labelIds) ? i.labelIds : []).map((id) => this.labelById(c, target.repo, id));
        const next = [...target.labels, ...labels.filter((label) => !target.labels.includes(label))];
        if (target.kind === 'Issue') c.store.updateIssue(target, { labels: next });
        else {
          target.labels = next;
          c.store.updatePull(target, {});
        }
        return { clientMutationId: i.clientMutationId ?? null, labelable: target };
      },
    };
    return r;
  }

  ownerNode(context: Context, login: string): UserValue | null {
    if (login.toLowerCase() === context.store.viewer.login.toLowerCase()) return { kind: 'User', login: context.store.viewer.login };
    const repo = [...context.store.repos.values()].find((candidate) => candidate.owner.toLowerCase() === login.toLowerCase());
    return repo === undefined ? null : { kind: 'Organization', login: repo.owner };
  }

  gitActor(context: Context, signature: { name: string; email: string; time: number } | undefined): unknown {
    if (signature === undefined) return null;
    return {
      name: signature.name,
      email: signature.email,
      date: isoOf(signature.time),
      user: signature.email === context.store.viewer.email ? { kind: 'User', login: context.store.viewer.login } : null,
    };
  }

  issueById(context: Context, id: unknown): Issue {
    const node = this.findNode(context, id) as Issue | null;
    if (node === null || node.kind !== 'Issue') throw new GraphQLError(`Could not resolve to an Issue with the global id of '${String(id)}'`, 'NOT_FOUND');
    return node;
  }

  pullById(context: Context, id: unknown): Pull {
    const node = this.findNode(context, id) as Pull | null;
    if (node === null || node.kind !== 'PullRequest') throw new GraphQLError(`Could not resolve to a PullRequest with the global id of '${String(id)}'`, 'NOT_FOUND');
    return node;
  }

  labelById(context: Context, repo: Repo, id: unknown): Label {
    const node = this.findNode(context, id) as LabelValue | null;
    if (node === null || node.kind !== 'Label' || node.repo !== repo) throw new GraphQLError(`Could not resolve to a Label with the global id of '${String(id)}'`, 'NOT_FOUND');
    return node.label;
  }

  /** GitHub search's common qualifiers: repo:, is:issue|pr, is:open|closed, label:, in-title text. */
  search(context: Context, query: string, type: string, args: Args): unknown {
    const terms = query.split(/\s+/).filter((term) => term !== '');
    const words: string[] = [];
    let repoFilter: string | null = null;
    let ownerFilter: string | null = null;
    let kind: 'issue' | 'pr' | null = null;
    let state: string | null = null;
    const labels: string[] = [];
    for (const term of terms) {
      const [key, ...rest] = term.split(':');
      const value = rest.join(':').replace(/^"|"$/g, '');
      if (rest.length === 0) words.push(term.toLowerCase());
      else if (key === 'repo') repoFilter = value.toLowerCase();
      else if (key === 'user' || key === 'org' || key === 'owner') ownerFilter = value.toLowerCase();
      else if (key === 'is' && (value === 'issue' || value === 'pr')) kind = value;
      else if ((key === 'is' || key === 'state') && (value === 'open' || value === 'closed')) state = value;
      else if (key === 'label') labels.push(value.toLowerCase());
      else if (key === 'type' && (value === 'issue' || value === 'pr')) kind = value;
    }
    const repos = [...context.store.repos.values()].filter((repo) => (repoFilter === null || `${repo.owner}/${repo.name}`.toLowerCase() === repoFilter) && (ownerFilter === null || repo.owner.toLowerCase() === ownerFilter));
    if (type === 'REPOSITORY') {
      const matches = repos.filter((repo) => words.every((word) => repo.name.toLowerCase().includes(word) || (repo.description ?? '').toLowerCase().includes(word))).sort((a, b) => a.id - b.id);
      return connection(matches, args, { issueCount: 0, repositoryCount: matches.length, userCount: 0, discussionCount: 0, codeCount: 0, wikiCount: 0 });
    }
    if (type === 'USER') {
      const viewer = context.store.viewer;
      const matches = words.every((word) => viewer.login.includes(word)) ? [{ kind: 'User', login: viewer.login }] : [];
      return connection(matches, args, { issueCount: 0, repositoryCount: 0, userCount: matches.length, discussionCount: 0, codeCount: 0, wikiCount: 0 });
    }
    const items: Array<Issue | Pull> = [];
    for (const repo of repos) {
      if (kind !== 'pr') items.push(...repo.issues.values());
      if (kind !== 'issue') items.push(...repo.pulls.values());
    }
    const matches = items
      .filter((item) => (state === null || item.state === state) && labels.every((name) => item.labels.some((label) => label.name.toLowerCase() === name)) && words.every((word) => item.title.toLowerCase().includes(word) || (item.body ?? '').toLowerCase().includes(word)))
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    return connection(matches, args, { issueCount: matches.length, repositoryCount: 0, userCount: 0, discussionCount: 0, codeCount: 0, wikiCount: 0 });
  }
}

/** Order issues or pulls by an IssueOrder (CREATED_AT ascending when none is given); ties go by number. */
function ordered<T extends { readonly number: number; readonly createdAt: number; updatedAt: number; readonly comments: readonly unknown[] }>(items: T[], orderBy: Args | null | undefined): T[] {
  const field = orderBy?.field ?? 'CREATED_AT';
  const descending = orderBy?.direction === 'DESC';
  const key = (item: T): number => (field === 'UPDATED_AT' ? item.updatedAt : field === 'COMMENTS' ? item.comments.length : item.createdAt);
  return items.sort((a, b) => {
    const order = key(a) - key(b) || a.number - b.number;
    return descending ? -order : order;
  });
}

function escapeHtml(text: string): string {
  return `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
}
