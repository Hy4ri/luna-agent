import { graphql, type Kind, type ListItem, type ItemPage, GhError } from "./github.js";
import type { RepoInfo } from "./github.js";

export type { RepoInfo };

type RepoGraphQLResponse = {
  repository: {
    nameWithOwner: string;
    url: string;
    viewerPermission: RepoInfo["permission"];
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    deleteBranchOnMerge: boolean;
    defaultBranchRef: { name: string } | null;
  } | null;
};

export async function repoInfo(owner: string, name: string): Promise<RepoInfo> {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        nameWithOwner
        url
        viewerPermission
        mergeCommitAllowed
        squashMergeAllowed
        rebaseMergeAllowed
        deleteBranchOnMerge
        defaultBranchRef {
          name
        }
      }
    }
  `;
  const data = await graphql<RepoGraphQLResponse>(query, { owner, name });

  const repo = data?.repository;
  if (!repo) {
    throw new GhError(`Repository ${owner}/${name} not found`, 404);
  }

  return {
    repo: repo.nameWithOwner,
    url: repo.url,
    defaultBranch: repo.defaultBranchRef?.name ?? "main",
    permission: repo.viewerPermission ?? null,
    merge: {
      merge: repo.mergeCommitAllowed,
      squash: repo.squashMergeAllowed,
      rebase: repo.rebaseMergeAllowed,
    },
    deleteBranchOnMerge: repo.deleteBranchOnMerge,
  };
}

type RepoIssueNode = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string; color: string }> };
  comments: { totalCount: number };
};

type RepoPRNode = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  updatedAt: string;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string; color: string }> };
  comments: { totalCount: number };
  reviewDecision: string | null;
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
        } | null;
      };
    }>;
  };
};

type RepoItemConnectionResponse = {
  repository: {
    issues?: {
      totalCount: number;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: Array<RepoIssueNode | null>;
    };
    pullRequests?: {
      totalCount: number;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: Array<RepoPRNode | null>;
    };
  } | null;
};

function mapIssue(node: RepoIssueNode): ListItem {
  return {
    kind: "issue",
    number: node.number,
    title: node.title,
    state: node.state,
    draft: false,
    author: node.author?.login ?? null,
    updatedAt: node.updatedAt,
    comments: node.comments.totalCount,
    labels: node.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
    checks: null,
    review: null,
  };
}

function mapPR(node: RepoPRNode): ListItem {
  let review: ListItem["review"] = null;
  if (node.reviewDecision === "APPROVED") review = "APPROVED";
  else if (node.reviewDecision === "CHANGES_REQUESTED") review = "CHANGES_REQUESTED";
  else if (node.reviewDecision === "REVIEW_REQUIRED") review = "REVIEW_REQUIRED";

  let checks: ListItem["checks"] = null;
  const rollupState = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (rollupState) {
    if (rollupState === "SUCCESS") checks = "SUCCESS";
    else if (rollupState === "FAILURE") checks = "FAILURE";
    else if (rollupState === "PENDING") checks = "PENDING";
    else if (rollupState === "ERROR") checks = "ERROR";
    else if (rollupState === "EXPECTED") checks = "EXPECTED";
  }

  return {
    kind: "pr",
    number: node.number,
    title: node.title,
    state: node.state,
    draft: node.isDraft,
    author: node.author?.login ?? null,
    updatedAt: node.updatedAt,
    comments: node.comments.totalCount,
    labels: node.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
    checks,
    review,
  };
}

export async function listItems(
  repo: string,
  kind: Kind,
  state: "open" | "closed" | "all",
  q: string,
  after?: string | null
): Promise<ItemPage> {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GhError(`Invalid repository format: ${repo}`, 400);
  }

  if (q && /\b(repo|is|type|user|org):/.test(q)) {
    throw new GhError("Search query cannot contain repo, is, type, user, or org qualifiers", 400);
  }

  const cleanQ = (q || "").trim();

  if (cleanQ === "") {
    const owner = parts[0]!;
    const name = parts[1]!;

    if (kind === "issue") {
      const issueStates = state === "open" ? ["OPEN"] : state === "closed" ? ["CLOSED"] : ["OPEN", "CLOSED"];
      const query = `
        query($owner: String!, $name: String!, $states: [IssueState!], $after: String) {
          repository(owner: $owner, name: $name) {
            issues(first: 30, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}, after: $after) {
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                number
                title
                state
                updatedAt
                author {
                  login
                }
                labels(first: 5) {
                  nodes {
                    name
                    color
                  }
                }
                comments {
                  totalCount
                }
              }
            }
          }
        }
      `;
      const data = await graphql<RepoItemConnectionResponse>(query, { owner, name, states: issueStates, after: after || null });
      const repoData = data?.repository;
      if (!repoData) {
        throw new GhError(`Repository ${owner}/${name} not found`, 404);
      }
      const conn = repoData.issues;
      if (!conn) {
        return { total: 0, items: [], next: null };
      }
      const items: ListItem[] = [];
      for (const node of conn.nodes) {
        if (node) items.push(mapIssue(node));
      }
      return {
        total: conn.totalCount,
        items,
        next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
      };
    } else {
      const prStates = state === "open" ? ["OPEN"] : state === "closed" ? ["CLOSED", "MERGED"] : ["OPEN", "CLOSED", "MERGED"];
      const query = `
        query($owner: String!, $name: String!, $states: [PullRequestState!], $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(first: 30, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}, after: $after) {
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                number
                title
                state
                isDraft
                updatedAt
                author {
                  login
                }
                labels(first: 5) {
                  nodes {
                    name
                    color
                  }
                }
                comments {
                  totalCount
                }
                reviewDecision
                commits(last: 1) {
                  nodes {
                    commit {
                      statusCheckRollup {
                        state
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const data = await graphql<RepoItemConnectionResponse>(query, { owner, name, states: prStates, after: after || null });
      const repoData = data?.repository;
      if (!repoData) {
        throw new GhError(`Repository ${owner}/${name} not found`, 404);
      }
      const conn = repoData.pullRequests;
      if (!conn) {
        return { total: 0, items: [], next: null };
      }
      const items: ListItem[] = [];
      for (const node of conn.nodes) {
        if (node) items.push(mapPR(node));
      }
      return {
        total: conn.totalCount,
        items,
        next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
      };
    }
  }

  const qualifiers = [`repo:${repo}`, kind === "pr" ? "is:pr" : "is:issue"];
  if (state !== "all") {
    qualifiers.push(`is:${state}`);
  }
  qualifiers.push("sort:updated-desc");
  qualifiers.push(cleanQ.slice(0, 256));
  const searchQuery = qualifiers.join(" ");

  const query = `
    query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: 30, after: $after) {
        issueCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on Issue {
            number
            title
            state
            updatedAt
            author {
              login
            }
            labels(first: 5) {
              nodes {
                name
                color
              }
            }
            comments {
              totalCount
            }
            repository {
              nameWithOwner
            }
          }
          ... on PullRequest {
            number
            title
            state
            isDraft
            updatedAt
            author {
              login
            }
            labels(first: 5) {
              nodes {
                name
                color
              }
            }
            comments {
              totalCount
            }
            reviewDecision
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    state
                  }
                }
              }
            }
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  `;

  const data = await graphql<{
    search: {
      issueCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<
        | ({ __typename: "Issue" } & RepoIssueNode & { repository?: { nameWithOwner: string } })
        | ({ __typename: "PullRequest" } & RepoPRNode & { repository?: { nameWithOwner: string } })
        | null
      >;
    };
  }>(query, { q: searchQuery, after: after || null });

  const searchResult = data?.search;
  if (!searchResult) {
    return { total: 0, items: [], next: null };
  }

  const items: ListItem[] = [];
  for (const node of searchResult.nodes) {
    if (!node) continue;

    if (node.repository && node.repository.nameWithOwner) {
      if (node.repository.nameWithOwner.toLowerCase() !== repo.toLowerCase()) {
        continue;
      }
    }

    if (node.__typename === "Issue") {
      if (kind !== "issue") continue;
      items.push(mapIssue(node));
    } else if (node.__typename === "PullRequest") {
      if (kind !== "pr") continue;
      items.push(mapPR(node));
    }
  }

  return {
    total: searchResult.issueCount,
    items,
    next: searchResult.pageInfo.hasNextPage ? searchResult.pageInfo.endCursor : null,
  };
}
