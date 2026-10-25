import { graphql, GhError, type Kind, type Detail, type Comment, type Check } from "./github.js";

type DetailGraphQLResponse = {
  repository: {
    isArchived: boolean;
    viewerPermission: "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" | null;
    issueOrPullRequest:
      | {
          __typename: "Issue";
          id: string;
          number: number;
          title: string;
          state: "OPEN" | "CLOSED";
          url: string;
          createdAt: string;
          body: string;
          author: { login: string } | null;
          viewerCanUpdate: boolean;
          locked: boolean;
          viewerCanDelete: boolean;
          comments: {
            totalCount: number;
            pageInfo: {
              hasPreviousPage: boolean;
              startCursor: string | null;
            };
            nodes: Array<{
              id: string;
              author: { login: string } | null;
              body: string;
              createdAt: string;
              url: string;
            } | null>;
          };
        }
      | {
          __typename: "PullRequest";
          id: string;
          number: number;
          title: string;
          state: "OPEN" | "CLOSED" | "MERGED";
          url: string;
          createdAt: string;
          body: string;
          author: { login: string } | null;
          viewerCanUpdate: boolean;
          locked: boolean;
          isDraft: boolean;
          merged: boolean;
          baseRefName: string;
          headRefName: string | null;
          headRefOid: string;
          isCrossRepository: boolean;
          headRepository: {
            nameWithOwner: string;
            viewerPermission: "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" | null;
            defaultBranchRef: {
              name: string;
            } | null;
          } | null;
          headRef: {
            name: string;
          } | null;
          additions: number;
          deletions: number;
          changedFiles: number;
          mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
          mergeStateStatus: string;
          reviewDecision: string | null;
          comments: {
            totalCount: number;
            pageInfo: {
              hasPreviousPage: boolean;
              startCursor: string | null;
            };
            nodes: Array<{
              id: string;
              author: { login: string } | null;
              body: string;
              createdAt: string;
              url: string;
            } | null>;
          };
          reviews: {
            nodes: Array<{
              author: { login: string } | null;
              state: string;
              body: string;
              submittedAt: string;
            } | null>;
          };
          commits: {
            nodes: Array<{
              commit: {
                statusCheckRollup: {
                  state: string;
                  contexts: {
                    nodes: Array<
                      | {
                          __typename: "CheckRun";
                          name: string;
                          status: string;
                          conclusion: string | null;
                          detailsUrl: string | null;
                        }
                      | {
                          __typename: "StatusContext";
                          context: string;
                          state: string;
                          targetUrl: string | null;
                        }
                      | null
                    >;
                  };
                } | null;
              };
            } | null>;
          };
        }
      | null;
  } | null;
};

export async function commentsPage(
  owner: string,
  name: string,
  number: number,
  before?: string | null
): Promise<{ comments: Comment[]; before: string | null }> {
  const query = `
    query($owner: String!, $name: String!, $n: Int!, $before: String) {
      repository(owner: $owner, name: $name) {
        issueOrPullRequest(number: $n) {
          __typename
          ... on Issue {
            comments(last: 30, before: $before) {
              pageInfo {
                hasPreviousPage
                startCursor
              }
              nodes {
                id
                author {
                  login
                }
                body
                createdAt
                url
              }
            }
          }
          ... on PullRequest {
            comments(last: 30, before: $before) {
              pageInfo {
                hasPreviousPage
                startCursor
              }
              nodes {
                id
                author {
                  login
                }
                body
                createdAt
                url
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql<DetailGraphQLResponse>(query, { owner, name, n: number, before: before || null });
  const repoData = data?.repository;
  if (!repoData) {
    throw new GhError(`Repository ${owner}/${name} not found`, 404);
  }
  const node = repoData.issueOrPullRequest;
  if (!node) {
    throw new GhError(`Item #${number} not found in ${owner}/${name}`, 404);
  }

  const commentsConn = node.comments;
  const commentsList: Comment[] = [];
  for (const c of commentsConn.nodes) {
    if (c) {
      commentsList.push({
        id: c.id,
        author: c.author?.login ?? null,
        body: c.body,
        createdAt: c.createdAt,
        url: c.url,
      });
    }
  }

  const hasPrevious = commentsConn.pageInfo.hasPreviousPage;
  const startCursor = commentsConn.pageInfo.startCursor;

  return {
    comments: commentsList,
    before: hasPrevious ? startCursor : null,
  };
}

export async function detail(owner: string, name: string, number: number): Promise<Detail> {
  const query = `
    query($owner: String!, $name: String!, $n: Int!) {
      repository(owner: $owner, name: $name) {
        isArchived
        viewerPermission
        issueOrPullRequest(number: $n) {
          __typename
          ... on Issue {
            id
            number
            title
            state
            url
            createdAt
            body
            author {
              login
            }
            viewerCanUpdate
            locked
            viewerCanDelete
            comments(last: 30) {
              totalCount
              pageInfo {
                hasPreviousPage
                startCursor
              }
              nodes {
                id
                author {
                  login
                }
                body
                createdAt
                url
              }
            }
          }
          ... on PullRequest {
            id
            number
            title
            state
            url
            createdAt
            body
            author {
              login
            }
            viewerCanUpdate
            locked
            isDraft
            merged
            baseRefName
            headRefName
            headRefOid
            isCrossRepository
            headRepository {
              nameWithOwner
              viewerPermission
              defaultBranchRef {
                name
              }
            }
            headRef {
              name
            }
            additions
            deletions
            changedFiles
            mergeable
            mergeStateStatus
            reviewDecision
            comments(last: 30) {
              totalCount
              pageInfo {
                hasPreviousPage
                startCursor
              }
              nodes {
                id
                author {
                  login
                }
                body
                createdAt
                url
              }
            }
            reviews(last: 20) {
              nodes {
                author {
                  login
                }
                state
                body
                submittedAt
              }
            }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    state
                    contexts(first: 100) {
                      nodes {
                        __typename
                        ... on CheckRun {
                          name
                          status
                          conclusion
                          detailsUrl
                        }
                        ... on StatusContext {
                          context
                          state
                          targetUrl
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql<DetailGraphQLResponse>(query, { owner, name, n: number });

  const repoData = data?.repository;
  if (!repoData) {
    throw new GhError(`Repository ${owner}/${name} not found`, 404);
  }

  const node = repoData.issueOrPullRequest;
  if (!node) {
    throw new GhError(`Item #${number} not found in ${owner}/${name}`, 404);
  }

  const perm = repoData.viewerPermission ?? null;
  const canComment = !repoData.isArchived && (!node.locked || ["ADMIN", "MAINTAIN", "WRITE"].includes(perm ?? ""));

  if (node.__typename === "Issue") {
    const commentsList: Comment[] = [];
    for (const c of node.comments.nodes) {
      if (c) {
        commentsList.push({
          id: c.id,
          author: c.author?.login ?? null,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        });
      }
    }

    const hasPrevious = node.comments.pageInfo.hasPreviousPage;
    const startCursor = node.comments.pageInfo.startCursor;

    return {
      kind: "issue",
      id: node.id,
      number: node.number,
      title: node.title,
      state: node.state,
      url: node.url,
      author: node.author?.login ?? null,
      createdAt: node.createdAt,
      body: node.body,
      comments: commentsList,
      commentTotal: node.comments.totalCount,
      commentsBefore: hasPrevious ? startCursor : null,
      can: {
        comment: canComment,
        close: !repoData.isArchived && node.viewerCanUpdate,
        merge: false,
        deleteBranch: false,
        delete: node.viewerCanDelete,
      },
    };
  } else {
    // PullRequest
    const commentsList: Comment[] = [];
    for (const c of node.comments.nodes) {
      if (c) {
        commentsList.push({
          id: c.id,
          author: c.author?.login ?? null,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        });
      }
    }

    const reviewsList = (node.reviews.nodes || []).map((r: { author: { login: string } | null; state: string; body: string; submittedAt: string } | null) => ({
      author: r?.author?.login ?? null,
      state: r?.state ?? "",
      body: r?.body ?? "",
      at: r?.submittedAt ?? "",
    }));

    const checksList: Check[] = [];
    const rollup = node.commits.nodes?.[0]?.commit?.statusCheckRollup;
    const rollupState = rollup?.state ?? null;
    if (rollup?.contexts?.nodes) {
      for (const ctx of rollup.contexts.nodes) {
        if (!ctx) continue;
        if (ctx.__typename === "CheckRun") {
          checksList.push({
            name: ctx.name,
            state: ctx.conclusion ?? ctx.status,
            url: ctx.detailsUrl,
          });
        } else if (ctx.__typename === "StatusContext") {
          checksList.push({
            name: ctx.context,
            state: ctx.state,
            url: ctx.targetUrl,
          });
        }
      }
    }

    let checkState: NonNullable<Detail["pr"]>["checkState"] = null;
    if (rollupState) {
      if (rollupState === "SUCCESS") checkState = "SUCCESS";
      else if (rollupState === "FAILURE") checkState = "FAILURE";
      else if (rollupState === "PENDING") checkState = "PENDING";
      else if (rollupState === "ERROR") checkState = "ERROR";
      else if (rollupState === "EXPECTED") checkState = "EXPECTED";
    }

    let reviewState: NonNullable<Detail["pr"]>["review"] = null;
    if (node.reviewDecision === "APPROVED") reviewState = "APPROVED";
    else if (node.reviewDecision === "CHANGES_REQUESTED") reviewState = "CHANGES_REQUESTED";
    else if (node.reviewDecision === "REVIEW_REQUIRED") reviewState = "REVIEW_REQUIRED";

    const branchExists = node.headRef !== null;
    const isClosedOrMerged = node.state === "CLOSED" || node.state === "MERGED";

    // Head repository permission and default branch validation
    const headRepo = node.headRepository;
    const headRepoPerm = headRepo?.viewerPermission ?? null;
    const hasHeadRepoWrite = headRepoPerm !== null && ["ADMIN", "MAINTAIN", "WRITE"].includes(headRepoPerm);
    const headDefaultBranchRef = headRepo?.defaultBranchRef ?? null;
    const headDefaultBranchName = headDefaultBranchRef?.name ?? null;
    const headBranchName = node.headRef?.name ?? node.headRefName;
    const isDefaultBranchHead = headDefaultBranchName !== null && headBranchName === headDefaultBranchName;

    const canDeleteBranch =
      isClosedOrMerged &&
      branchExists &&
      hasHeadRepoWrite &&
      headDefaultBranchName !== null &&
      !isDefaultBranchHead;

    const canMerge =
      !repoData.isArchived &&
      node.state === "OPEN" &&
      !node.isDraft &&
      ["ADMIN", "MAINTAIN", "WRITE"].includes(perm ?? "") &&
      node.mergeable !== "CONFLICTING";

    const hasPrevious = node.comments.pageInfo.hasPreviousPage;
    const startCursor = node.comments.pageInfo.startCursor;

    return {
      kind: "pr",
      id: node.id,
      number: node.number,
      title: node.title,
      state: node.merged ? "MERGED" : node.state,
      url: node.url,
      author: node.author?.login ?? null,
      createdAt: node.createdAt,
      body: node.body,
      comments: commentsList,
      commentTotal: node.comments.totalCount,
      commentsBefore: hasPrevious ? startCursor : null,
      can: {
        comment: canComment,
        close: !repoData.isArchived && node.viewerCanUpdate && node.state !== "MERGED",
        merge: canMerge,
        deleteBranch: canDeleteBranch,
        delete: false,
      },
      pr: {
        draft: node.isDraft,
        merged: node.merged,
        base: node.baseRefName,
        head: headBranchName ?? "unknown",
        headOid: node.headRefOid,
        headRepo: headRepo?.nameWithOwner ?? null,
        crossRepo: node.isCrossRepository,
        mergeable: node.mergeable,
        mergeState: node.mergeStateStatus,
        review: reviewState,
        checks: checksList,
        checkState,
        reviews: reviewsList,
        additions: node.additions,
        deletions: node.deletions,
        files: node.changedFiles,
        branchExists,
      },
    };
  }
}
