import {
  CodeCommitClient,
  CreatePullRequestApprovalRuleCommand,
  CreatePullRequestCommand,
  DeleteCommentContentCommand,
  DescribePullRequestEventsCommand,
  GetCommentsForPullRequestCommand,
  GetFileCommand,
  GetPullRequestCommand,
  GetRepositoryCommand,
  ListPullRequestsCommand,
  ListRepositoriesCommand,
  MergeBranchesBySquashCommand,
  PostCommentForPullRequestCommand,
  UpdatePullRequestDescriptionCommand,
  UpdatePullRequestStatusCommand,
  UpdatePullRequestTitleCommand,
} from '@aws-sdk/client-codecommit';
import { GetUserCommand, IAMClient } from '@aws-sdk/client-iam';
import { mockClient } from 'aws-sdk-client-mock';
import { TextEncoder } from 'web-encoding';
import { logger } from '../../../../test/util';
import {
  PLATFORM_BAD_CREDENTIALS,
  REPOSITORY_EMPTY,
  REPOSITORY_NOT_FOUND,
} from '../../../constants/error-messages';
import { PrState } from '../../../types';
import * as git from '../../../util/git';
import type { Platform } from '../types';
import { config } from './index';

describe('modules/platform/codecommit/index', () => {
  let codeCommit: Platform;
  let codeCommitClient: any;
  let iamClient: any;

  beforeEach(async () => {
    iamClient = mockClient(IAMClient);
    iamClient
      .on(GetUserCommand)
      .resolves({ User: { Arn: 'aws:arn:example:123456' } });
    codeCommit = await import('.');
    await codeCommit.initPlatform({
      endpoint: 'https://git-codecommit.eu-central-1.amazonaws.com/',
      username: 'accessKeyId',
      password: 'SecretAccessKey',
    });
    config.prList = undefined;
    config.repository = undefined;
    codeCommitClient = mockClient(CodeCommitClient);
  });

  it('validates massageMarkdown functionality', () => {
    const newStr = codeCommit.massageMarkdown(
      '<details><summary>foo</summary>bar</details>text<details>\n<!--renovate-debug:hiddenmessage123-->'
    );
    expect(newStr).toBe(
      '**foo**bartext\n[//]: # (<!--renovate-debug:hiddenmessage123-->)'
    );
  });

  describe('initPlatform()', () => {
    it('should throw if no username/password', async () => {
      let error;
      try {
        await codeCommit.initPlatform({});
      } catch (e) {
        error = e.message;
      }
      expect(error).toBe(
        'Init: You must configure a AWS user(accessKeyId), password(secretAccessKey) and endpoint/AWS_REGION'
      );
    });

    it('should show warning message if custom endpoint', async () => {
      let error;
      try {
        await codeCommit.initPlatform({
          endpoint: 'endpoint',
          username: 'abc',
          password: '123',
        });
      } catch (e) {
        error = e.message;
      }
      expect(error).toBe(
        'Init: You must configure a AWS user(accessKeyId), password(secretAccessKey) and endpoint/AWS_REGION'
      );

      expect(logger.logger.warn).toHaveBeenCalledWith(
        "Can't parse region, make sure your endpoint is correct"
      );
    });

    it('should init', async () => {
      expect(
        await codeCommit.initPlatform({
          endpoint: 'https://git-codecommit.REGION.amazonaws.com/',
          username: 'abc',
          password: '123',
        })
      ).toEqual({
        endpoint: 'https://git-codecommit.REGION.amazonaws.com/',
      });
    });

    it('should init with env vars', async () => {
      process.env.AWS_REGION = 'REGION';
      let res;
      try {
        res = await codeCommit.initPlatform({
          username: 'abc',
          password: '123',
        });
      } catch (err) {
        res = err.message;
      } finally {
        delete process.env.AWS_REGION;
      }
      expect(res).toEqual({
        endpoint: 'https://git-codecommit.REGION.amazonaws.com/',
      });
    });
  });

  describe('initRepos()', () => {
    it('fails to git.initRepo', async () => {
      jest.spyOn(git, 'initRepo').mockImplementationOnce(() => {
        throw new Error('any error');
      });
      codeCommitClient.on(GetRepositoryCommand).resolvesOnce({});
      let error;
      try {
        await codeCommit.initRepo({
          repository: 'repositoryName',
        });
      } catch (e) {
        error = e.message;
      }
      expect(error).toBe(PLATFORM_BAD_CREDENTIALS);
    });

    it('fails on getRepositoryInfo', async () => {
      jest.spyOn(git, 'initRepo').mockReturnValueOnce(Promise.resolve());
      codeCommitClient
        .on(GetRepositoryCommand)
        .rejectsOnce(new Error('Could not find repository'));
      let error;
      try {
        await codeCommit.initRepo({
          repository: 'repositoryName',
        });
      } catch (e) {
        error = e.message;
      }
      expect(error).toBe(REPOSITORY_NOT_FOUND);
    });

    it('getRepositoryInfo returns bad results', async () => {
      jest.spyOn(git, 'initRepo').mockReturnValueOnce(Promise.resolve());
      codeCommitClient.on(GetRepositoryCommand).resolvesOnce();
      let error;
      try {
        await codeCommit.initRepo({
          repository: 'repositoryName',
        });
      } catch (e) {
        error = e.message;
      }
      expect(error).toBe(REPOSITORY_NOT_FOUND);
    });

    it('getRepositoryInfo returns bad results 2', async () => {
      jest.spyOn(git, 'initRepo').mockReturnValueOnce(Promise.resolve());
      codeCommitClient.on(GetRepositoryCommand).resolvesOnce({ repo: {} });
      let error;
      try {
        await codeCommit.initRepo({
          repository: 'repositoryName',
        });
      } catch (e) {
        error = e.message;
      }
      expect(error).toBe(REPOSITORY_EMPTY);
    });

    it('initiates repo successfully', async () => {
      jest.spyOn(git, 'initRepo').mockReturnValueOnce(Promise.resolve());
      codeCommitClient.on(GetRepositoryCommand).resolvesOnce({
        repositoryMetadata: {
          defaultBranch: 'main',
          repositoryId: 'id',
        },
      });

      const repoResult = await codeCommit.initRepo({
        repository: 'repositoryName',
      });

      expect(repoResult).toEqual({
        repoFingerprint:
          'f0bcfd81abefcdf9ae5e5de58d1a868317503ea76422309bc212d1ef25a1e67789d0bfa752a7e2abd4510f4f3e4f60cdaf6202a42883fb97bb7110ab3600785e',
        defaultBranch: 'main',
        isFork: false,
      });
    });
  });

  describe('getRepos()', () => {
    it('returns repos', async () => {
      const result = {
        repositories: [
          {
            repositoryId: 'id',
            repositoryName: 'repoName',
          },
        ],
      };
      codeCommitClient.on(ListRepositoriesCommand).resolvesOnce(result);

      const res = await codeCommit.getRepos();
      expect(res).toEqual(['repoName']);
    });

    it('returns empty if error', async () => {
      codeCommitClient
        .on(ListRepositoriesCommand)
        .rejectsOnce(new Error('something'));
      const res = await codeCommit.getRepos();
      expect(res).toEqual([]);
    });
  });

  describe('getRepoForceRebase()', () => {
    it('Always return false, since CodeCommit does not support force rebase', async () => {
      const actual = await codeCommit.getRepoForceRebase();
      expect(actual).toBeFalse();
    });
  });

  describe('getPrList()', () => {
    it('gets PR list by author', async () => {
      codeCommitClient
        .on(ListPullRequestsCommand)
        .resolvesOnce({ pullRequestIds: ['1'] });
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      const res = await codeCommit.getPrList();
      expect(res).toMatchObject([
        {
          sourceBranch: 'refs/heads/sourceBranch',
          targetBranch: 'refs/heads/targetBranch',
          state: 'open',
          number: 1,
          title: 'someTitle',
        },
      ]);
    });
  });

  describe('findPr()', () => {
    it('throws error on findPr', async () => {
      const err = new Error('failed');
      codeCommitClient.on(ListPullRequestsCommand).rejectsOnce(err);
      const res = await codeCommit.findPr({
        branchName: 'sourceBranch',
        prTitle: 'someTitle',
        state: PrState.Open,
      });
      expect(res).toBeNull();
      expect(logger.logger.error).toHaveBeenCalledWith({ err }, 'findPr error');
    });

    it('finds pr', async () => {
      codeCommitClient
        .on(ListPullRequestsCommand)
        .resolvesOnce({ pullRequestIds: ['1'] });
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      const res = await codeCommit.findPr({
        branchName: 'sourceBranch',
        prTitle: 'someTitle',
        state: PrState.Open,
      });
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'open',
        number: 1,
        title: 'someTitle',
      });
    });

    it('finds any pr with that title in regardless of state', async () => {
      codeCommitClient
        .on(ListPullRequestsCommand)
        .resolvesOnce({ pullRequestIds: ['1'] });
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      const res = await codeCommit.findPr({
        branchName: 'sourceBranch',
        prTitle: 'someTitle',
        state: PrState.All,
      });
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'open',
        number: 1,
        title: 'someTitle',
      });
    });

    it('finds closed/merged pr', async () => {
      codeCommitClient
        .on(ListPullRequestsCommand)
        .resolvesOnce({ pullRequestIds: ['1'] });
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: PrState.NotOpen,
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      const res = await codeCommit.findPr({
        branchName: 'sourceBranch',
        prTitle: 'someTitle',
        state: PrState.NotOpen,
      });
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'closed',
        number: 1,
        title: 'someTitle',
      });
    });

    it('finds any pr', async () => {
      codeCommitClient
        .on(ListPullRequestsCommand)
        .resolvesOnce({ pullRequestIds: ['1'] });
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: PrState.Closed,
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      const res = await codeCommit.findPr({
        branchName: 'sourceBranch',
        prTitle: 'someTitle',
      });
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'closed',
        number: 1,
        title: 'someTitle',
      });
    });

    it('returns empty list in case prs dont exist yet', async () => {
      const res = await codeCommit.findPr({
        branchName: 'sourceBranch',
        prTitle: 'someTitle',
        state: PrState.Open,
      });
      expect(res).toBeNull();
    });
  });

  describe('getBranchPr()', () => {
    it('codecommit find PR for branch', async () => {
      codeCommitClient
        .on(ListPullRequestsCommand)
        .resolvesOnce({ pullRequestIds: ['1'] });
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolves(prRes);
      const res = await codeCommit.getBranchPr('sourceBranch');
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'open',
        number: 1,
        title: 'someTitle',
      });
    });

    it('returns null if no PR for branch', async () => {
      codeCommitClient
        .on(ListPullRequestsCommand)
        .resolvesOnce({ pullRequestIds: ['1'] });
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      const res = await codeCommit.getBranchPr('branch_without_pr');
      expect(res).toBeNull();
    });
  });

  describe('getPr()', () => {
    it('gets pr', async () => {
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };

      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);

      const res = await codeCommit.getPr(1);
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'open',
        number: 1,
        title: 'someTitle',
      });
    });

    it('gets closed pr', async () => {
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'CLOSED',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };

      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);

      const res = await codeCommit.getPr(1);
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'closed',
        number: 1,
        title: 'someTitle',
      });
    });

    it('gets merged pr', async () => {
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
              mergeMetadata: {
                isMerged: true,
              },
            },
          ],
        },
      };

      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);

      const res = await codeCommit.getPr(1);
      expect(res).toMatchObject({
        sourceBranch: 'refs/heads/sourceBranch',
        targetBranch: 'refs/heads/targetBranch',
        state: 'merged',
        number: 1,
        title: 'someTitle',
      });
    });

    it('returns null in case input is null', async () => {
      codeCommitClient
        .on(GetPullRequestCommand)
        .rejectsOnce(new Error('bad creds'));
      const res = await codeCommit.getPr(1);
      expect(res).toBeNull();
    });
  });

  describe('getJsonFile()', () => {
    it('returns file content', async () => {
      const data = { foo: 'bar' };
      const encoder = new TextEncoder();
      const int8arrData = encoder.encode(JSON.stringify(data));
      codeCommitClient
        .on(GetFileCommand)
        .resolvesOnce({ fileContent: int8arrData });
      const res = await codeCommit.getJsonFile('file.json');
      expect(res).toEqual(data);
    });

    it('returns file content in json5 format', async () => {
      const json5Data = `
        {
          // json5 comment
          foo: 'bar'
        }
      `;
      const encoder = new TextEncoder();
      const int8arrData = encoder.encode(json5Data);
      codeCommitClient
        .on(GetFileCommand)
        .resolvesOnce({ fileContent: int8arrData });
      const res = await codeCommit.getJsonFile('file.json');
      expect(res).toEqual({ foo: 'bar' });
    });
  });

  describe('getRawFile()', () => {
    it('returns file content', async () => {
      const data = { foo: 'bar' };
      const encoder = new TextEncoder();
      const int8arrData = encoder.encode(JSON.stringify(data));
      codeCommitClient
        .on(GetFileCommand)
        .resolvesOnce({ fileContent: int8arrData });
      const res = await codeCommit.getRawFile('file.json');
      expect(res).toBe('{"foo":"bar"}');
    });

    it('returns file content in json5 format', async () => {
      const json5Data = `
        {
          // json5 comment
          foo: 'bar'
        }
      `;
      const encoder = new TextEncoder();
      const int8arrData = encoder.encode(json5Data);
      codeCommitClient
        .on(GetFileCommand)
        .resolvesOnce({ fileContent: int8arrData });
      const res = await codeCommit.getRawFile('file.json');
      expect(res).toBe(`
        {
          // json5 comment
          foo: 'bar'
        }
      `);
    });
  });

  describe('createPr()', () => {
    it('posts PR', async () => {
      const prRes = {
        pullRequest: {
          pullRequestId: '1',
          pullRequestStatus: 'OPEN',
          title: 'someTitle',
        },
      };

      codeCommitClient.on(CreatePullRequestCommand).resolvesOnce(prRes);
      const pr = await codeCommit.createPr({
        sourceBranch: 'sourceBranch',
        targetBranch: 'targetBranch',
        prTitle: 'mytitle',
        prBody: 'mybody',
      });

      expect(pr).toMatchObject({
        number: 1,
        state: 'open',
        title: 'someTitle',
        sourceBranch: 'sourceBranch',
        targetBranch: 'targetBranch',
        sourceRepo: undefined,
      });
    });
  });

  describe('updatePr()', () => {
    it('updates PR', async () => {
      codeCommitClient.on(UpdatePullRequestDescriptionCommand).resolvesOnce();
      codeCommitClient.on(UpdatePullRequestTitleCommand).resolvesOnce();
      codeCommitClient.on(UpdatePullRequestStatusCommand).resolvesOnce();
      await expect(
        codeCommit.updatePr({
          number: 1,
          prTitle: 'title',
          prBody: 'body',
          state: PrState.Open,
        })
      ).toResolve();
    });

    it('updates PR regardless of status failure', async () => {
      codeCommitClient.on(UpdatePullRequestDescriptionCommand).resolvesOnce();
      codeCommitClient.on(UpdatePullRequestTitleCommand).resolvesOnce();
      codeCommitClient
        .on(UpdatePullRequestStatusCommand)
        .rejectsOnce(new Error('update status failure'));
      await expect(
        codeCommit.updatePr({
          number: 1,
          prTitle: 'title',
          prBody: 'body',
          state: PrState.Open,
        })
      ).toResolve();
    });

    it('updates PR with status closed', async () => {
      codeCommitClient.on(UpdatePullRequestDescriptionCommand).resolvesOnce();
      codeCommitClient.on(UpdatePullRequestTitleCommand).resolvesOnce();
      codeCommitClient.on(UpdatePullRequestStatusCommand).resolvesOnce();
      await expect(
        codeCommit.updatePr({
          number: 1,
          prTitle: 'title',
          prBody: 'body',
          state: PrState.Closed,
        })
      ).toResolve();
    });
  });

  describe('mergePr()', () => {
    it('checks that rebase is not supported', async () => {
      expect(
        await codeCommit.mergePr({
          branchName: 'branch',
          id: 1,
          strategy: 'rebase',
        })
      ).toBeFalse();
    });

    it('posts Merge with auto', async () => {
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      codeCommitClient.on(MergeBranchesBySquashCommand).resolvesOnce();

      const updateStatusRes = {
        pullRequest: {
          pullRequestStatus: 'OPEN',
        },
      };
      codeCommitClient
        .on(UpdatePullRequestStatusCommand)
        .resolvesOnce(updateStatusRes);
      expect(
        await codeCommit.mergePr({
          branchName: 'branch',
          id: 1,
          strategy: 'auto',
        })
      ).toBeTrue();
    });

    it('posts Merge with squash', async () => {
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      codeCommitClient.on(MergeBranchesBySquashCommand).resolvesOnce();
      const updateStatusRes = {
        pullRequest: {
          pullRequestStatus: 'OPEN',
        },
      };
      codeCommitClient
        .on(UpdatePullRequestStatusCommand)
        .resolvesOnce(updateStatusRes);
      expect(
        await codeCommit.mergePr({
          branchName: 'branch',
          id: 5,
          strategy: 'squash',
        })
      ).toBeTrue();
    });

    it('posts Merge with fast-forward', async () => {
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      codeCommitClient.on(MergeBranchesBySquashCommand).resolvesOnce();
      const updateStatusRes = {
        pullRequest: {
          pullRequestStatus: 'OPEN',
        },
      };
      codeCommitClient
        .on(UpdatePullRequestStatusCommand)
        .resolvesOnce(updateStatusRes);
      expect(
        await codeCommit.mergePr({
          branchName: 'branch',
          id: 1,
          strategy: 'fast-forward',
        })
      ).toBe(true);
    });

    it('checks that merge-commit is not supported', async () => {
      const prRes = {
        pullRequest: {
          title: 'someTitle',
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              sourceReference: 'refs/heads/sourceBranch',
              destinationReference: 'refs/heads/targetBranch',
            },
          ],
        },
      };
      codeCommitClient.on(GetPullRequestCommand).resolvesOnce(prRes);
      expect(
        await codeCommit.mergePr({
          branchName: 'branch',
          id: 1,
          strategy: 'merge-commit',
        })
      ).toBeFalse();
    });
  });

  describe('ensureComment', () => {
    it('adds comment if missing', async () => {
      const commentsRes = {
        commentsForPullRequestData: [
          {
            pullRequestId: '1',
            repositoryName: 'someRepo',
            beforeCommitId: 'beforeCommitId',
            afterCommitId: 'afterCommitId',
            comments: [
              {
                commentId: '1',
                content: 'my comment content',
              },
            ],
          },
        ],
      };
      codeCommitClient
        .on(GetCommentsForPullRequestCommand)
        .resolvesOnce(commentsRes);

      const eventsRes = {
        pullRequestEvents: [
          {
            pullRequestSourceReferenceUpdatedEventMetadata: {
              beforeCommitId: 'beforeCid',
              afterCommitId: 'afterCid',
            },
          },
        ],
      };
      codeCommitClient
        .on(DescribePullRequestEventsCommand)
        .resolvesOnce(eventsRes);
      codeCommitClient.on(PostCommentForPullRequestCommand).resolvesOnce();
      const res = await codeCommit.ensureComment({
        number: 42,
        topic: 'some-subject',
        content: 'some\ncontent',
      });
      expect(res).toBeTrue();
      expect(logger.logger.info).toHaveBeenCalledWith(
        { repository: undefined, prNo: 42, topic: 'some-subject' },
        'Comment added'
      );
    });

    it('updates comment if different content', async () => {
      const commentsRes = {
        commentsForPullRequestData: [
          {
            pullRequestId: '1',
            repositoryName: 'someRepo',
            beforeCommitId: 'beforeCommitId',
            afterCommitId: 'afterCommitId',
            comments: [
              {
                commentId: '1',
                content: '### some-subject\n\n - my comment content',
              },
            ],
          },
        ],
      };
      codeCommitClient
        .on(GetCommentsForPullRequestCommand)
        .resolvesOnce(commentsRes);
      codeCommitClient.on(PostCommentForPullRequestCommand).resolvesOnce();

      const res = await codeCommit.ensureComment({
        number: 42,
        topic: 'some-subject',
        content: 'some\ncontent',
      });
      expect(res).toBeTrue();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        { repository: undefined, prNo: 42, topic: 'some-subject' },
        'Comment updated'
      );
    });

    it('does nothing if comment exists and is the same', async () => {
      const commentsRes = {
        commentsForPullRequestData: [
          {
            pullRequestId: '1',
            repositoryName: 'someRepo',
            beforeCommitId: 'beforeCommitId',
            afterCommitId: 'afterCommitId',
            comments: [
              {
                commentId: '1',
                content: '### some-subject\n\nmy comment content',
              },
            ],
          },
        ],
      };
      codeCommitClient
        .on(GetCommentsForPullRequestCommand)
        .resolvesOnce(commentsRes);
      const res = await codeCommit.ensureComment({
        number: 42,
        topic: 'some-subject',
        content: 'my comment content',
      });
      expect(res).toBeTrue();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        { repository: undefined, prNo: 42, topic: 'some-subject' },
        'Comment is already update-to-date'
      );
    });

    it('does nothing if comment exists and is the same when there is no topic', async () => {
      const commentsRes = {
        commentsForPullRequestData: [
          {
            pullRequestId: '1',
            repositoryName: 'someRepo',
            beforeCommitId: 'beforeCommitId',
            afterCommitId: 'afterCommitId',
            comments: [
              {
                commentId: '1',
                content: 'my comment content',
              },
            ],
          },
        ],
      };
      codeCommitClient
        .on(GetCommentsForPullRequestCommand)
        .resolvesOnce(commentsRes);
      const res = await codeCommit.ensureComment({
        number: 42,
        topic: null,
        content: 'my comment content',
      });
      expect(res).toBeTrue();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        { repository: undefined, prNo: 42, topic: null },
        'Comment is already update-to-date'
      );
    });

    it('throws an exception in case of api failed connection ', async () => {
      const err = new Error('some error');
      codeCommitClient.on(GetCommentsForPullRequestCommand).rejectsOnce(err);

      const res = await codeCommit.ensureComment({
        number: 42,
        topic: null,
        content: 'my comment content',
      });
      expect(res).toBeFalse();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        { err },
        'Unable to retrieve pr comments'
      );
    });
  });

  describe('ensureCommentRemoval', () => {
    it('deletes comment by topic if found', async () => {
      const commentsRes = {
        commentsForPullRequestData: [
          {
            pullRequestId: '1',
            repositoryName: 'someRepo',
            beforeCommitId: 'beforeCommitId',
            afterCommitId: 'afterCommitId',
            comments: [
              {
                commentId: '1',
                content: '### some-subject\n\nmy comment content',
              },
            ],
          },
        ],
      };
      codeCommitClient
        .on(GetCommentsForPullRequestCommand)
        .resolvesOnce(commentsRes);
      codeCommitClient.on(DeleteCommentContentCommand).resolvesOnce();
      await codeCommit.ensureCommentRemoval({
        type: 'by-topic',
        number: 42,
        topic: 'some-subject',
      });
      expect(logger.logger.debug).toHaveBeenCalledWith(
        'comment "some-subject" in PR #42 was removed'
      );
    });

    it('deletes comment by content if found', async () => {
      const commentsRes = {
        commentsForPullRequestData: [
          {
            pullRequestId: '1',
            repositoryName: 'someRepo',
            beforeCommitId: 'beforeCommitId',
            afterCommitId: 'afterCommitId',
            comments: [
              {
                commentId: '1',
                content: 'my comment content',
              },
            ],
          },
        ],
      };
      codeCommitClient
        .on(GetCommentsForPullRequestCommand)
        .resolvesOnce(commentsRes);
      codeCommitClient.on(DeleteCommentContentCommand).resolvesOnce();
      await codeCommit.ensureCommentRemoval({
        type: 'by-content',
        number: 42,
        content: 'my comment content',
      });
      expect(logger.logger.debug).toHaveBeenCalledWith(
        'comment "my comment content" in PR #42 was removed'
      );
    });

    it('throws exception in case failed api connection', async () => {
      const err = new Error('some error');
      codeCommitClient.on(GetCommentsForPullRequestCommand).rejectsOnce(err);
      await codeCommit.ensureCommentRemoval({
        type: 'by-content',
        number: 42,
        content: 'my comment content',
      });
      expect(logger.logger.debug).toHaveBeenCalledWith(
        { err },
        'Unable to retrieve pr comments'
      );
    });
  });

  describe('addReviewers', () => {
    it('checks that the function resolves', async () => {
      const res = {
        approvalRule: {
          approvalRuleName: 'Assignees By Renovate',
          lastModifiedDate: 1570752871.932,
          ruleContentSha256: '7c44e6ebEXAMPLE',
          creationDate: 1570752871.932,
          approvalRuleId: 'aac33506-EXAMPLE',
          approvalRuleContent:
            '{"Version": "2018-11-08","Statements": [{"Type": "Approvers","NumberOfApprovalsNeeded": 1,"ApprovalPoolMembers": ["arn:aws:iam::someUser:user/ReviewerUser"]}]}',
          lastModifiedUser: 'arn:aws:iam::someUser:user/ReviewerUser',
        },
      };
      codeCommitClient
        .on(CreatePullRequestApprovalRuleCommand)
        .resolvesOnce(res);
      await expect(
        codeCommit.addReviewers(13, ['arn:aws:iam::someUser:user/ReviewerUser'])
      ).toResolve();
      expect(logger.logger.debug).toHaveBeenCalledWith(
        res,
        'Approval Rule Added to PR #13:'
      );
    });
  });
});
