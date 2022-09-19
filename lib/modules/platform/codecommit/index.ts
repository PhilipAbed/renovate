import { PullRequestStatusEnum } from '@aws-sdk/client-codecommit';
import type { Credentials } from '@aws-sdk/types';
import JSON5 from 'json5';
import { TextDecoder } from 'web-encoding';
import {
  PLATFORM_BAD_CREDENTIALS,
  REPOSITORY_EMPTY,
  REPOSITORY_NOT_FOUND,
} from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { BranchStatus, PrState, VulnerabilityAlert } from '../../../types';
import * as git from '../../../util/git';
import { regEx } from '../../../util/regex';
import { sanitize } from '../../../util/sanitize';
import type {
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfig,
  EnsureIssueConfig,
  EnsureIssueResult,
  FindPRConfig,
  Issue,
  MergePRConfig,
  PlatformParams,
  PlatformResult,
  Pr,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
} from '../types';
import { getNewBranchName, repoFingerprint } from '../util';
import { smartTruncate } from '../utils/pr-body';
import { getCodeCommitUrl } from './codecommit-client';
import * as client from './codecommit-client';
import { getUserArn, initIamClient } from './iam-client';

const decoder = new TextDecoder();

interface Config {
  repository?: string;
  defaultBranch?: string;
  region?: string;
  prList?: Pr[];
  credentials?: Credentials;
  userArn?: string;
}

export const config: Config = {};

export async function initPlatform({
  endpoint,
  username,
  password,
}: PlatformParams): Promise<PlatformResult> {
  let accessKeyId = username;
  let secretAccessKey = password;
  let region;

  if (!accessKeyId) {
    accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  }
  if (!secretAccessKey) {
    secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  }
  if (endpoint) {
    const regionReg = regEx(/.*codecommit\.(?<region>.+)\.amazonaws\.com/);
    const codeCommitMatch = regionReg.exec(endpoint);
    region = codeCommitMatch?.groups?.region;
    if (!region) {
      logger.warn("Can't parse region, make sure your endpoint is correct");
    }
  } else {
    region = process.env.AWS_REGION;
  }

  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error(
      'Init: You must configure a AWS user(accessKeyId), password(secretAccessKey) and endpoint/AWS_REGION'
    );
  }

  config.region = region;
  const credentials: Credentials = {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
  config.credentials = credentials;

  initIamClient(region, credentials);
  config.userArn = await getUserArn();

  client.buildCodeCommitClient(region, credentials);

  const platformConfig: PlatformResult = {
    endpoint: endpoint ?? `https://git-codecommit.${region}.amazonaws.com/`,
  };
  return Promise.resolve(platformConfig);
}

export async function initRepo({
  repository,
  endpoint,
}: RepoParams): Promise<RepoResult> {
  logger.debug(`initRepo("${repository}")`);

  config.repository = repository;

  let repo;
  try {
    repo = await client.getRepositoryInfo(repository);
  } catch (err) {
    logger.error({ err }, 'Could not find repository');
    throw new Error(REPOSITORY_NOT_FOUND);
  }

  const url = getCodeCommitUrl(config.region!, repository, config.credentials!);
  try {
    await git.initRepo({
      url,
    });
  } catch (err) {
    logger.debug({ err }, 'Failed to git init');
    throw new Error(PLATFORM_BAD_CREDENTIALS);
  }

  if (!repo?.repositoryMetadata) {
    logger.error({ repository }, 'Could not find repository');
    throw new Error(REPOSITORY_NOT_FOUND);
  }

  logger.debug({ repositoryDetails: repo }, 'Repository details');
  const metadata = repo.repositoryMetadata;

  if (!metadata?.defaultBranch || !metadata?.repositoryId) {
    logger.debug('Repo is empty');
    throw new Error(REPOSITORY_EMPTY);
  }

  const defaultBranch = metadata.defaultBranch;
  config.defaultBranch = defaultBranch;
  logger.debug(`${repository} default branch = ${defaultBranch}`);

  return {
    repoFingerprint: repoFingerprint(metadata.repositoryId, endpoint),
    defaultBranch,
    isFork: false,
  };
}

export async function getPrList(): Promise<Pr[]> {
  logger.debug('getPrList()');

  if (config.prList) {
    return config.prList;
  }

  const listPrsResponse = await client.listPullRequests(
    config.repository!,
    config.userArn!
  );
  const fetchedPrs: Pr[] = [];

  /* istanbul ignore if */
  if (listPrsResponse && !listPrsResponse.pullRequestIds) {
    return fetchedPrs;
  }

  const prIds = listPrsResponse?.pullRequestIds ?? [];

  for (const prId of prIds) {
    const prRes = await client.getPr(prId);

    // istanbul ignore if
    if (!prRes?.pullRequest) {
      continue;
    }
    const prInfo = prRes.pullRequest;
    const pr: Pr = {
      targetBranch: prInfo.pullRequestTargets![0].destinationReference!,
      sourceBranch: prInfo.pullRequestTargets![0].sourceReference!,
      state:
        prInfo.pullRequestStatus === PullRequestStatusEnum.OPEN
          ? PrState.Open
          : PrState.Closed,
      number: Number.parseInt(prId),
      title: prInfo.title!,
    };
    fetchedPrs.push(pr);
  }

  config.prList = fetchedPrs;

  logger.debug({ length: fetchedPrs.length }, 'Retrieved Pull Requests');
  return fetchedPrs;
}

export async function findPr({
  branchName,
  prTitle,
  state = PrState.All,
}: FindPRConfig): Promise<Pr | null> {
  let prsFiltered: Pr[] = [];
  try {
    const prs = await getPrList();
    const refsHeadBranchName = getNewBranchName(branchName);
    prsFiltered = prs.filter(
      (item) => item.sourceBranch === refsHeadBranchName
    );

    if (prTitle) {
      prsFiltered = prsFiltered.filter((item) => item.title === prTitle);
    }

    switch (state) {
      case PrState.All:
        break;
      case PrState.NotOpen:
        prsFiltered = prsFiltered.filter((item) => item.state !== PrState.Open);
        break;
      default:
        prsFiltered = prsFiltered.filter((item) => item.state === PrState.Open);
        break;
    }
  } catch (err) {
    logger.error({ err }, 'findPr error');
  }
  if (prsFiltered.length === 0) {
    return null;
  }
  return prsFiltered[0];
}

export async function getBranchPr(branchName: string): Promise<Pr | null> {
  logger.debug(`getBranchPr(${branchName})`);
  const existingPr = await findPr({
    branchName,
    state: PrState.Open,
  });
  return existingPr ? getPr(existingPr.number) : null;
}

export async function getPr(pullRequestId: number): Promise<Pr | null> {
  logger.debug(`getPr(${pullRequestId})`);
  const prRes = await client.getPr(`${pullRequestId}`);

  if (!prRes?.pullRequest) {
    return null;
  }

  const prInfo = prRes.pullRequest;
  let prState: PrState;
  if (prInfo.pullRequestTargets![0].mergeMetadata?.isMerged) {
    prState = PrState.Merged;
  } else {
    prState =
      prInfo.pullRequestStatus === PullRequestStatusEnum.OPEN
        ? PrState.Open
        : PrState.Closed;
  }

  return {
    sourceBranch: prInfo.pullRequestTargets![0].sourceReference!,
    state: prState,
    number: pullRequestId,
    title: prInfo.title!,
    targetBranch: prInfo.pullRequestTargets![0].destinationReference!,
    sha: prInfo.revisionId,
  };
}

export async function getRepos(): Promise<string[]> {
  logger.debug('Autodiscovering AWS CodeCommit repositories');

  let reposRes;
  try {
    reposRes = await client.listRepositories();
    //todo do we need pagination? maximum number of repos is 1000 without pagination, also the same for free account
  } catch (error) {
    logger.error({ error }, 'Could not retrieve repositories');
    return [];
  }

  const res: string[] = [];

  const repoNames = reposRes?.repositories ?? [];

  for (const repo of repoNames) {
    if (repo.repositoryName) {
      res.push(repo.repositoryName);
    }
  }

  return res;
}

export function massageMarkdown(input: string): string {
  // Remove any HTML we use
  return input
    .replace(
      'you tick the rebase/retry checkbox',
      'rename PR to start with "rebase!"'
    )
    .replace(regEx(/<\/?summary>/g), '**')
    .replace(regEx(/<\/?details>/g), '')
    .replace(regEx(`\n---\n\n.*?<!-- rebase-check -->.*?\n`), '')
    .replace(regEx(/\]\(\.\.\/pull\//g), '](../../pull-requests/')
    .replace(
      regEx(/(?<hiddenComment><!--renovate-debug:.*?-->)/),
      '[//]: # ($<hiddenComment>)'
    );
}

export async function getJsonFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string
): Promise<any | null> {
  const raw = await getRawFile(fileName, repoName, branchOrTag);
  return raw ? JSON5.parse(raw) : null;
}
export async function getRawFile(
  fileName: string,
  repoName?: string,
  branchOrTag?: string
): Promise<string | null> {
  const fileRes = await client.getFile(
    repoName ?? config.repository,
    fileName,
    branchOrTag
  );

  return decoder.decode(fileRes.fileContent);
}

/* istanbul ignore next */
export function getRepoForceRebase(): Promise<boolean> {
  return Promise.resolve(false);
}

export async function createPr({
  sourceBranch,
  targetBranch,
  prTitle: title,
  prBody: body,
}: CreatePRConfig): Promise<Pr> {
  const description = smartTruncate(sanitize(body), 10239);

  const prCreateRes = await client.createPr(
    title,
    sanitize(description),
    sourceBranch,
    targetBranch,
    config.repository
  );

  // istanbul ignore if
  if (
    !prCreateRes.pullRequest?.title ||
    !prCreateRes.pullRequest?.pullRequestId
  ) {
    throw new Error('Could not create pr, missing PR info');
  }

  return {
    number: Number.parseInt(prCreateRes.pullRequest.pullRequestId),
    state: PrState.Open,
    title: prCreateRes.pullRequest.title,
    sourceBranch,
    targetBranch,
    sourceRepo: config.repository,
  };
}

export async function updatePr({
  number: prNo,
  prTitle: title,
  prBody: body,
  state,
}: UpdatePrConfig): Promise<void> {
  logger.debug(`updatePr(${prNo}, ${title}, body)`);

  if (body) {
    await client.updatePrDescription(
      `${prNo}`,
      smartTruncate(sanitize(body), 10239)
    );
  }

  if (title) {
    await client.updatePrTitle(`${prNo}`, title);
  }

  const prStatusInput =
    state === PrState.Closed
      ? PullRequestStatusEnum.CLOSED
      : PullRequestStatusEnum.OPEN;
  try {
    await client.updatePrStatus(`${prNo}`, prStatusInput);
  } catch (err) {
    // do nothing, it's ok to fail sometimes when trying to update from open to open or from closed to closed.
  }
}

// Auto-Merge not supported currently.
/* istanbul ignore next */
export async function mergePr({
  branchName,
  id: prNo,
  strategy,
}: MergePRConfig): Promise<boolean> {
  logger.debug(`mergePr(${prNo}, ${branchName!})`);

  const prOut = await client.getPr(`${prNo}`);

  // istanbul ignore if
  if (!prOut) {
    return false;
  }
  const pReq = prOut.pullRequest;
  const targets = pReq?.pullRequestTargets;

  // istanbul ignore if
  if (!targets) {
    return false;
  }

  if (strategy === 'rebase') {
    logger.warn('CodeCommit does not support a "rebase" strategy.');
    return false;
  }

  try {
    if (strategy === 'auto' || strategy === 'squash') {
      await client.squashMerge(
        targets[0].repositoryName!,
        targets[0].sourceReference!,
        targets[0].destinationReference!,
        pReq?.title
      );
    } else if (strategy === 'fast-forward') {
      await client.fastForwardMerge(
        targets[0].repositoryName!,
        targets[0].sourceReference!,
        targets[0].destinationReference!
      );
    } else {
      logger.debug(`unsupported strategy`);
      return false;
    }
  } catch (err) {
    logger.debug({ err }, `PR merge error`);
    logger.info({ pr: prNo }, 'PR automerge failed');
    return false;
  }

  logger.trace(`Updating PR ${prNo} to status ${PullRequestStatusEnum.CLOSED}`);

  try {
    const response = await client.updatePrStatus(
      `${prNo}`,
      PullRequestStatusEnum.CLOSED
    );
    const isClosed =
      response.pullRequest?.pullRequestStatus === PullRequestStatusEnum.CLOSED;

    if (!isClosed) {
      logger.warn(
        {
          pullRequestId: prNo,
          status: response.pullRequest?.pullRequestStatus,
        },
        `Expected PR to have status`
      );
    }
    return true;
  } catch (err) {
    logger.debug({ err }, 'Failed to set the PR as Closed.');
    return false;
  }
}

export async function addReviewers(
  prNo: number,
  reviewers: string[]
): Promise<void> {
  const numberOfApprovers = reviewers.length;
  const approvalRuleContents = `{"Version":"2018-11-08","Statements": [{"Type": "Approvers","NumberOfApprovalsNeeded":${numberOfApprovers},"ApprovalPoolMembers": ${JSON.stringify(
    reviewers
  )}}]}`;
  const res = await client.createPrApprovalRule(
    `${prNo}`,
    approvalRuleContents
  );
  if (res) {
    const approvalRule = res.approvalRule;
    logger.debug({ approvalRule }, `Approval Rule Added to PR #${prNo}:`);
  }
}

/* istanbul ignore next */
export function addAssignees(iid: number, assignees: string[]): Promise<void> {
  // CodeCommit does not support adding reviewers
  return Promise.resolve();
}

/* istanbul ignore next */
export function findIssue(title: string): Promise<Issue | null> {
  // CodeCommit does not have issues
  return Promise.resolve(null);
}

/* istanbul ignore next */
export function ensureIssue({
  title,
}: EnsureIssueConfig): Promise<EnsureIssueResult | null> {
  // CodeCommit does not have issues
  return Promise.resolve(null);
}

/* istanbul ignore next */
export function getIssueList(): Promise<Issue[]> {
  // CodeCommit does not have issues
  return Promise.resolve([]);
}

/* istanbul ignore next */
export function ensureIssueClosing(title: string): Promise<void> {
  // CodeCommit does not have issues
  return Promise.resolve();
}

/* istanbul ignore next */
export function deleteLabel(prNumber: number, label: string): Promise<void> {
  return Promise.resolve();
}

/* istanbul ignore next */
export function getVulnerabilityAlerts(): Promise<VulnerabilityAlert[]> {
  return Promise.resolve([]);
}

// Returns the combined status for a branch.
/* istanbul ignore next */
export function getBranchStatus(branchName: string): Promise<BranchStatus> {
  logger.debug(`getBranchStatus(${branchName})`);
  logger.debug(
    'returning branch status yellow, because getBranchStatus isnt supported on aws yet'
  );
  return Promise.resolve(BranchStatus.yellow);
}

/* istanbul ignore next */
export function getBranchStatusCheck(
  branchName: string,
  context: string
): Promise<BranchStatus | null> {
  logger.debug(`getBranchStatusCheck(${branchName}, context=${context})`);
  logger.debug(
    'returning null, because getBranchStatusCheck is not supported on aws yet'
  );
  return Promise.resolve(null);
}

/* istanbul ignore next */
export function setBranchStatus({
  branchName,
  context,
  description,
  state,
  url: targetUrl,
}: BranchStatusConfig): Promise<void> {
  return Promise.resolve();
}

export async function ensureComment({
  number,
  topic,
  content,
}: EnsureCommentConfig): Promise<boolean> {
  logger.debug(`ensureComment(${number}, ${topic!}, content)`);
  const header = topic ? `### ${topic}\n\n` : '';
  const body = `${header}${sanitize(content)}`;
  let prCommentsResponse;
  try {
    prCommentsResponse = await client.getPrComments(
      config.repository!,
      `${number}`
    );
  } catch (err) {
    logger.debug({ err }, 'Unable to retrieve pr comments');
    return false;
  }

  let commentId = undefined;
  let commentNeedsUpdating = false;

  /* istanbul ignore if */
  if (!prCommentsResponse?.commentsForPullRequestData) {
    return false;
  }

  for (const commentObj of prCommentsResponse.commentsForPullRequestData) {
    /* istanbul ignore if */
    if (!commentObj?.comments) {
      continue;
    }
    const firstCommentContent = commentObj.comments[0].content;
    if (
      (topic && firstCommentContent?.startsWith(header)) ||
      (!topic && firstCommentContent === body)
    ) {
      commentId = commentObj.comments[0].commentId;
      commentNeedsUpdating = firstCommentContent !== body;
      break;
    }
  }

  if (!commentId) {
    const prEvent = await client.getPrEvents(`${number}`);

    // istanbul ignore if
    if (!prEvent?.pullRequestEvents) {
      return false;
    }

    const event =
      prEvent.pullRequestEvents[0]
        .pullRequestSourceReferenceUpdatedEventMetadata;

    // istanbul ignore if
    if (!event?.beforeCommitId || !event?.afterCommitId) {
      return false;
    }

    await client.createPrComment(
      `${number}`,
      config.repository,
      body,
      event.beforeCommitId,
      event.afterCommitId
    );
    logger.info(
      { repository: config.repository, prNo: number, topic },
      'Comment added'
    );
  } else if (commentNeedsUpdating && commentId) {
    await client.updateComment(commentId, body);

    logger.debug(
      { repository: config.repository, prNo: number, topic },
      'Comment updated'
    );
  } else {
    logger.debug(
      { repository: config.repository, prNo: number, topic },
      'Comment is already update-to-date'
    );
  }

  return true;
}

export async function ensureCommentRemoval(
  removeConfig: EnsureCommentRemovalConfig
): Promise<void> {
  const { number: prNo } = removeConfig;
  const key =
    removeConfig.type === 'by-topic'
      ? removeConfig.topic
      : removeConfig.content;
  logger.debug(`Ensuring comment "${key}" in #${prNo} is removed`);

  let prCommentsResponse;
  try {
    prCommentsResponse = await client.getPrComments(
      config.repository!,
      `${prNo}`
    );
  } catch (err) {
    logger.debug({ err }, 'Unable to retrieve pr comments');
    return;
  }

  // istanbul ignore if
  if (!prCommentsResponse?.commentsForPullRequestData) {
    return;
  }

  let commentIdToRemove;
  for (const commentObj of prCommentsResponse.commentsForPullRequestData) {
    /* istanbul ignore if */
    if (!commentObj?.comments) {
      continue;
    }

    for (const comment of commentObj.comments) {
      if (
        (removeConfig.type === 'by-topic' &&
          comment.content?.startsWith(`### ${removeConfig.topic}\n\n`)) ||
        (removeConfig.type === 'by-content' &&
          removeConfig.content === comment.content?.trim())
      ) {
        commentIdToRemove = comment.commentId;
        break;
      }
    }
    if (commentIdToRemove) {
      await client.deleteComment(commentIdToRemove);
      logger.debug(`comment "${key}" in PR #${prNo} was removed`);
      break;
    }
  }
}
