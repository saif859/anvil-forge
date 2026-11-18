// GitHub's REST v3 JSON shapes for the store's records. REST answers with them and the MCP tools return them,
// so an object reads the same over both surfaces. Field order is fixed by these literals.

import type { Comment, Issue, Label, Pull, PullFile, Repo, Store } from './store.ts';
import { isoOf } from './store.ts';
import type { Commit } from './git/objects.ts';

export interface View {
  readonly store: Store;
  /** `http://host:port` of the request, no trailing slash. */
  readonly origin: string;
}

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** Opaque, stable global ids shared by REST `node_id` and GraphQL `id`. */
export function nodeId(kind: string, id: number | string): string {
  const prefix = ({ Repository: 'R', Issue: 'I', PullRequest: 'PR', IssueComment: 'IC', User: 'U', Organization: 'O', Label: 'LA', Commit: 'C', Ref: 'REF' } as Record<string, string>)[kind] ?? 'N';
  return `${prefix}_${b64url(`anvil:${kind}:${id}`)}`;
}

export function parseNodeId(id: string): { kind: string; key: string } | null {
  const under = id.indexOf('_');
  if (under <= 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(id.slice(under + 1), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^anvil:([A-Za-z]+):(.+)$/.exec(decoded);
  return match === null ? null : { kind: match[1] as string, key: match[2] as string };
}

export function api(view: View, path: string): string {
  return `${view.origin}/api/v3${path}`;
}

export function html(view: View, path: string): string {
  return `${view.origin}${path}`;
}

export function userJson(view: View, login: string): Record<string, unknown> {
  const viewer = view.store.viewer;
  const isViewer = login.toLowerCase() === viewer.login.toLowerCase();
  const id = isViewer ? viewer.id : 900_000 + stableNumber(login);
  return {
    login,
    id,
    node_id: nodeId(isViewer ? 'User' : 'Organization', id),
    avatar_url: html(view, `/avatars/${login}`),
    gravatar_id: '',
    url: api(view, `/users/${login}`),
    html_url: html(view, `/${login}`),
    repos_url: api(view, `/users/${login}/repos`),
    type: isViewer ? 'User' : 'Organization',
    site_admin: false,
  };
}

/** A small deterministic number for a name (org ids). */
export function stableNumber(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 90_000;
}

export function repoJson(view: View, repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const openIssues = countOpen(repo);
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(view, repo.owner),
    html_url: html(view, `/${full}`),
    description: repo.description,
    fork: false,
    url: api(view, `/repos/${full}`),
    issues_url: api(view, `/repos/${full}/issues{/number}`),
    pulls_url: api(view, `/repos/${full}/pulls{/number}`),
    contents_url: api(view, `/repos/${full}/contents/{+path}`),
    branches_url: api(view, `/repos/${full}/branches{/branch}`),
    commits_url: api(view, `/repos/${full}/commits{/sha}`),
    git_refs_url: api(view, `/repos/${full}/git/refs{/sha}`),
    labels_url: api(view, `/repos/${full}/labels{/name}`),
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.updatedAt),
    pushed_at: repo.pushedAt === null ? null : isoOf(repo.pushedAt),
    git_url: `git:${view.origin.replace(/^https?:/, '')}/${full}.git`,
    clone_url: html(view, `/${full}.git`),
    homepage: repo.homepage,
    size: 0,
    language: null,
    has_issues: repo.hasIssues,
    has_projects: false,
    has_wiki: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
  };
}

function countOpen(repo: Repo): number {
  let open = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') open += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') open += 1;
  return open;
}

export function labelJson(view: View, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: api(view, `/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(view: View, issue: Issue): Record<string, unknown> {
  const repo = issue.repo;
  const base = `/repos/${repo.owner}/${repo.name}`;
  return {
    url: api(view, `${base}/issues/${issue.number}`),
    repository_url: api(view, base),
    labels_url: api(view, `${base}/issues/${issue.number}/labels{/name}`),
    comments_url: api(view, `${base}/issues/${issue.number}/comments`),
    html_url: html(view, `/${repo.owner}/${repo.name}/issues/${issue.number}`),
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    user: userJson(view, view.store.viewer.login),
    labels: issue.labels.map((label) => labelJson(view, repo, label)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : isoOf(issue.closedAt),
    author_association: 'OWNER',
    body: issue.body,
    state_reason: issue.stateReason,
  };
}

export function commentJson(view: View, repo: Repo, comment: Comment): Record<string, unknown> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: api(view, `${base}/issues/comments/${comment.id}`),
    html_url: html(view, `/${repo.owner}/${repo.name}/issues/${comment.number}#issuecomment-${comment.id}`),
    issue_url: api(view, `${base}/issues/${comment.number}`),
    body: comment.body,
    user: userJson(view, view.store.viewer.login),
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.updatedAt),
    author_association: 'OWNER',
  };
}

export function signatureJson(sig: { name: string; email: string; time: number }): Record<string, unknown> {
  return { name: sig.name, email: sig.email, date: isoOf(sig.time) };
}

/** The Git Data API's commit shape (contents API answers, git/commits). */
export function gitCommitJson(view: View, repo: Repo, sha: string, commit: Commit): Record<string, unknown> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: nodeId('Commit', `${repo.id}:${sha}`),
    url: api(view, `${base}/git/commits/${sha}`),
    html_url: html(view, `/${repo.owner}/${repo.name}/commit/${sha}`),
    author: signatureJson(commit.author),
    committer: signatureJson(commit.committer),
    tree: { sha: commit.tree, url: api(view, `${base}/git/trees/${commit.tree}`) },
    message: commit.message.replace(/\n$/, ''),
    parents: commit.parents.map((parent) => ({ sha: parent, url: api(view, `${base}/git/commits/${parent}`), html_url: html(view, `/${repo.owner}/${repo.name}/commit/${parent}`) })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
  };
}

/** The commits API's shape (GET /commits, branches). */
export function commitJson(view: View, repo: Repo, sha: string, commit: Commit): Record<string, unknown> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const viewer = view.store.viewer;
  const actor = (email: string): Record<string, unknown> | null => (email === viewer.email ? userJson(view, viewer.login) : null);
  return {
    sha,
    node_id: nodeId('Commit', `${repo.id}:${sha}`),
    commit: {
      author: signatureJson(commit.author),
      committer: signatureJson(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: api(view, `${base}/git/trees/${commit.tree}`) },
      url: api(view, `${base}/git/commits/${sha}`),
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: api(view, `${base}/commits/${sha}`),
    html_url: html(view, `/${repo.owner}/${repo.name}/commit/${sha}`),
    comments_url: api(view, `${base}/commits/${sha}/comments`),
    author: actor(commit.author.email),
    committer: actor(commit.committer.email),
    parents: commit.parents.map((parent) => ({ sha: parent, url: api(view, `${base}/commits/${parent}`), html_url: html(view, `/${repo.owner}/${repo.name}/commit/${parent}`) })),
  };
}

function branchSide(view: View, pull: Pull, ref: string, sha: string): Record<string, unknown> {
  const repo = pull.repo;
  return { label: `${repo.owner}:${ref}`, ref, sha, user: userJson(view, repo.owner), repo: repoJson(view, repo) };
}

/** Commits on the head side that the base side lacks. */
export function pullCommitList(store: Store, pull: Pull): string[] {
  const tips = store.pullTips(pull);
  const stop = store.mergeBase(tips.base, tips.head);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tips.head];
  while (stack.length > 0 && out.length < 250) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === stop || (stop !== null && store.isAncestor(oid, stop))) continue;
    seen.add(oid);
    const commit = store.commit(oid);
    if (commit === undefined) continue;
    out.push(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return out.reverse();
}

export function pullJson(view: View, pull: Pull, full: boolean): Record<string, unknown> {
  const repo = pull.repo;
  const store = view.store;
  const base = `/repos/${repo.owner}/${repo.name}`;
  const tips = store.pullTips(pull);
  const out: Record<string, unknown> = {
    url: api(view, `${base}/pulls/${pull.number}`),
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    html_url: html(view, `/${repo.owner}/${repo.name}/pull/${pull.number}`),
    diff_url: html(view, `/${repo.owner}/${repo.name}/pull/${pull.number}.diff`),
    patch_url: html(view, `/${repo.owner}/${repo.name}/pull/${pull.number}.patch`),
    issue_url: api(view, `${base}/issues/${pull.number}`),
    commits_url: api(view, `${base}/pulls/${pull.number}/commits`),
    comments_url: api(view, `${base}/issues/${pull.number}/comments`),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(view, view.store.viewer.login),
    body: pull.body,
    labels: pull.labels.map((label) => labelJson(view, repo, label)),
    milestone: null,
    active_lock_reason: null,
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
    closed_at: pull.closedAt === null ? null : isoOf(pull.closedAt),
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: branchSide(view, pull, pull.head, tips.head),
    base: branchSide(view, pull, pull.base, tips.base),
    author_association: 'OWNER',
    auto_merge: null,
    draft: pull.draft,
  };
  if (full) {
    const files = store.pullFiles(pull);
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    const mergeable = pull.state === 'open' ? store.pullMerge(pull).ok : null;
    out.merged = pull.merged;
    out.mergeable = mergeable;
    out.rebaseable = mergeable;
    out.mergeable_state = mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty';
    out.merged_by = pull.merged ? userJson(view, view.store.viewer.login) : null;
    out.comments = pull.comments.length;
    out.review_comments = 0;
    out.maintainer_can_modify = false;
    out.commits = pullCommitList(store, pull).length;
    out.additions = additions;
    out.deletions = deletions;
    out.changed_files = files.length;
  }
  return out;
}

export function pullFileJson(view: View, repo: Repo, file: PullFile, ref: string): Record<string, unknown> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const out: Record<string, unknown> = {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    blob_url: html(view, `/${repo.owner}/${repo.name}/blob/${ref}/${file.filename}`),
    raw_url: html(view, `/${repo.owner}/${repo.name}/raw/${ref}/${file.filename}`),
    contents_url: api(view, `${base}/contents/${file.filename}?ref=${ref}`),
  };
  if (file.patch !== null) out.patch = file.patch;
  return out;
}

/** Issue-shaped view of a pull request (GET /issues/{n} on a pull's number, as GitHub answers). */
export function pullAsIssueJson(view: View, pull: Pull): Record<string, unknown> {
  const repo = pull.repo;
  const base = `/repos/${repo.owner}/${repo.name}`;
  return {
    url: api(view, `${base}/issues/${pull.number}`),
    repository_url: api(view, base),
    html_url: html(view, `/${repo.owner}/${repo.name}/pull/${pull.number}`),
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    user: userJson(view, view.store.viewer.login),
    labels: pull.labels.map((label) => labelJson(view, repo, label)),
    state: pull.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: pull.comments.length,
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
    closed_at: pull.closedAt === null ? null : isoOf(pull.closedAt),
    author_association: 'OWNER',
    body: pull.body,
    pull_request: {
      url: api(view, `${base}/pulls/${pull.number}`),
      html_url: html(view, `/${repo.owner}/${repo.name}/pull/${pull.number}`),
      merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    },
  };
}

/** Base64 wrapped at 60 characters per line, as GitHub's contents API sends it. */
export function wrappedBase64(data: Buffer): string {
  const text = data.toString('base64');
  if (text.length <= 60) return `${text}\n`;
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += 60) lines.push(text.slice(at, at + 60));
  return `${lines.join('\n')}\n`;
}
