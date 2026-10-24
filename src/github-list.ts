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

type SearchNode =
  | {
      __typename: "Issue";
      number: number;
      title: string;
      state: "OPEN" | "CLOSED";
      updatedAt: string;
      author: { login: string } | null;
      labels: { nodes: Array<{ name: string; color: string }> };
      comments: { totalCount: number };
      repository?: { nameWithOwner: string };
    }
  | {
      __typename: "PullRequest";
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
      repository?: { nameWithOwner: string };
    }
  | null;

type SearchGraphQLResponse = {
  search: {
    issueCount: number;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: SearchNode[];
  };
};

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

  const qualifiers = [`repo:${repo}`, kind === "pr" ? "is:pr" : "is:issue"];
  if (state !== "all") {
    qualifiers.push(`is:${state}`);
  }
  qualifiers.push("sort:updated-desc");
  if (cleanQ) {
    qualifiers.push(cleanQ.slice(0, 256));
  }
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

  const data = await graphql<SearchGraphQLResponse>(query, { q: searchQuery, after: after || null });

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
      items.push({
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
      });
    } else if (node.__typename === "PullRequest") {
      if (kind !== "pr") continue;
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

      items.push({
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
      });
    }
  }

  return {
    total: searchResult.issueCount,
    items,
    next: searchResult.pageInfo.hasNextPage ? searchResult.pageInfo.endCursor : null,
  };
}
