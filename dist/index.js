import * as core from '@actions/core';
import * as github from '@actions/github';
import assert from 'assert';
import { WebClient } from '@slack/web-api';
import slackifyMarkdown from 'slackify-markdown';
import semverInc from 'semver/functions/inc';
import { generate } from 'changelogithub';

const githubToken = process.env.GITHUB_TOKEN;
if (!githubToken) throw new Error(`process.env.GITHUB_TOKEN is not defined`);

const octokit = github.getOctokit(githubToken);

const Config = {
  developBranch:
    core.getInput("develop_branch") || process.env.DEVELOP_BRANCH || "",
  prodBranch: core.getInput("main_branch") || process.env.MAIN_BRANCH || "",
  mergeBackFromProd:
    (core.getInput("merge_back_from_main") ||
      process.env.MERGE_BACK_FROM_MAIN) == "true",
  repo: {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
  },
  version: core.getInput("version") || process.env.VERSION || "",
  /**
   * @type {import("semver").ReleaseType}
   */
  versionIncrement:
    core.getInput("version_increment") || process.env.VERSION_INCREMENT || "",
  isDryRun: (core.getInput("dry_run") || process.env.DRY_RUN) == "true",
  releaseSummary:
    core.getInput("release_summary") || process.env.RELEASE_SUMMARY || "",
  releaseBranchPrefix: "release/",
  hotfixBranchPrefix: "hotfix/",
};

const PR_EXPLAIN_MESSAGE = `Merging this pull request will trigger Gitflow release actions. A release would be created and ${
  Config.mergeBackFromProd ? `${Config.prodBranch}` : "this branch"
} would be merged back to ${Config.developBranch} if needed.
See [Gitflow Workflow](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow) for more details.`;

/**
 *
 * @param {string} headBranch
 * @param {string} baseBranch
 */
async function tryMerge(headBranch, baseBranch) {
  console.log(
    `Trying to merge ${headBranch} branch into ${baseBranch} branch.`,
  );

  const { data: compareCommitsResult } =
    await octokit.rest.repos.compareCommits({
      ...Config.repo,
      base: baseBranch,
      head: headBranch,
    });

  if (compareCommitsResult.status !== "identical") {
    console.log(
      `${headBranch} branch is not up to date with ${baseBranch} branch. Attempting to merge.`,
    );
    try {
      await octokit.rest.repos.merge({
        ...Config.repo,
        base: baseBranch,
        head: headBranch,
      });
    } catch (err) {
      // could not automatically merge
      // try creating a PR
      await octokit.rest.pulls
        .create({
          ...Config.repo,
          base: baseBranch,
          head: headBranch,
          title: `Merge ${headBranch} branch into ${baseBranch}`,
          body: `In Gitflow, \`release\` and \`hotfix\` branches get merged back into \`develop\` branch.
See [Gitflow Workflow](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow) for more details.`,
        })
        .catch(() => {
          /** noop */
        });
    }
  } else {
    console.log(
      `${headBranch} branch is already up to date with ${baseBranch} branch.`,
    );
  }
}

/**
 *
 * @param {import("@octokit/plugin-rest-endpoint-methods").RestEndpointMethodTypes["pulls"]["get"]["response"]["data"]} pullRequest
 */
function isReleaseCandidate(pullRequest, shouldLog = false) {
  if (pullRequest.base.ref !== Config.prodBranch) {
    if (shouldLog)
      console.log(
        `on-release: ${pullRequest.number} does not merge to main_branch. Exiting...`,
      );
    return false;
  }

  if (pullRequest.head.ref.startsWith(Config.releaseBranchPrefix)) {
    return "release";
  }

  if (pullRequest.head.ref.startsWith(Config.hotfixBranchPrefix)) {
    return "hotfix";
  }

  if (shouldLog)
    console.log(
      `on-release: pull request does not match either release or hotfix branch pattern. Exiting...`,
    );
  return false;
}

/**
 * @param {number} pullRequestNumber
 */
async function createExplainComment(pullRequestNumber) {
  const existingComments = await octokit.rest.issues.listComments({
    ...Config.repo,
    issue_number: pullRequestNumber,
  });

  const existingExplainComment = existingComments.data.find(
    (comment) => comment.body === PR_EXPLAIN_MESSAGE,
  );

  if (existingExplainComment) {
    console.log(
      `on-release: pull request ${pullRequestNumber} already has an explain comment.`,
    );
    return;
  }

  await octokit.rest.issues.createComment({
    ...Config.repo,
    issue_number: pullRequestNumber,
    body: PR_EXPLAIN_MESSAGE,
  });
}

/**
 * @param {string} text
 */
const removeHtmlComments = (text) => text.replace(/<!--.*?-->/gs, "");

// @ts-check

/**
 *
 * @param {string} slackInput
 * @param {import("@octokit/plugin-rest-endpoint-methods").RestEndpointMethodTypes["repos"]["createRelease"]["response"]["data"] } release
 */
async function sendToSlack(slackInput, release) {
  let slackOpts;
  try {
    slackOpts = JSON.parse(slackInput);
  } catch (err) {
    throw new Error(`integration(slack): Could not parse ${slackInput}`);
  }
  console.log(
    `integration(slack): Posting to slack channel #${slackOpts.channel}`,
  );
  const slackToken = process.env.SLACK_TOKEN;
  if (!slackToken) throw new Error("process.env.SLACK_TOKEN is not defined");

  const slackWebClient = new WebClient(slackToken);

  let releaseBody = release.body || "";

  releaseBody = removeHtmlComments(releaseBody);

  releaseBody = slackifyMarkdown(releaseBody);

  // rewrite changelog entries to format
  // [title](link) by name
  releaseBody = releaseBody.replace(
    /- (.*) by (.*) in (.*)/g,
    `- <$3|$1> by $2`,
  );

  const username_mapping = slackOpts["username_mapping"] || {};
  for (const [username, slackUserId] of Object.entries(username_mapping)) {
    releaseBody = releaseBody.replaceAll(`@${username}`, `<@${slackUserId}>`);
  }

  await slackWebClient.chat.postMessage({
    text: `<${release.html_url}|Release ${
      release.name || release.tag_name
    }> to \`${Config.repo.owner}/${Config.repo.repo}\`

${releaseBody}`,
    channel: slackOpts.channel,
    icon_url: "https://avatars.githubusercontent.com/in/15368?s=88&v=4",
    mrkdwn: true,
  });
}

// @ts-check

/**
 * @returns {Promise<import("./types.js").Result>}
 */
async function executeOnRelease() {
  if (Config.isDryRun) {
    console.log(`on-release: dry run. Exiting...`);
    return {
      type: "none",
    };
  }

  if (!github.context.payload.pull_request?.merged) {
    console.log(`on-release: pull request is not merged. Exiting...`);
    return {
      type: "none",
    };
  }

  /**
   * Precheck
   * Check if the pull request has a release label, targeting main branch, and if it was merged
   */
  const pullRequestNumber = github.context.payload.pull_request?.number;
  assert(
    pullRequestNumber,
    `github.context.payload.pull_request?.number is not defined`,
  );

  const { data: pullRequest } = await octokit.rest.pulls.get({
    ...Config.repo,
    pull_number: pullRequestNumber,
  });

  const releaseCandidateType = isReleaseCandidate(pullRequest, true);
  if (!releaseCandidateType)
    return {
      type: "none",
    };

  const currentBranch = pullRequest.head.ref;

  let version = "";

  if (releaseCandidateType === "release") {
    /**
     * Creating a release
     */
    version = currentBranch.substring(Config.releaseBranchPrefix.length);
  } else if (releaseCandidateType === "hotfix") {
    /**
     * Creating a hotfix release
     */
    const now = pullRequest.merged_at
      ? new Date(pullRequest.merged_at)
      : new Date();
    version = `hotfix-${now.getFullYear()}${String(now.getMonth() + 1).padStart(
      2,
      "0",
    )}${String(now.getDate()).padStart(2, "0")}${String(
      now.getHours(),
    ).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  }

  console.log(
    `on-release: ${releaseCandidateType}(${version}): Generating release`,
  );

  const pullRequestBody = pullRequest.body;

  assert(pullRequestBody, `pull request body is not defined`);

  const { data: release } = await octokit.rest.repos.createRelease({
    ...Config.repo,
    tag_name: version,
    target_commitish: Config.prodBranch,
    name: version,
    body: pullRequestBody,
  });

  /**
   * Merging the release or hotfix branch back to the develop branch if needed
   */
  console.log(
    `on-release: ${releaseCandidateType}(${version}): Execute merge workflow`,
  );

  await tryMerge(
    Config.mergeBackFromProd ? Config.prodBranch : currentBranch,
    Config.developBranch,
  );

  console.log(`on-release: success`);

  console.log(`post-release: process release ${release.name}`);
  const slackInput = core.getInput("slack") || process.env.SLACK_OPTIONS;
  if (slackInput) {
    /**
     * Slack integration
     */
    await sendToSlack(slackInput, release);
  }

  console.log(`post-release: success`);

  return {
    type: releaseCandidateType,
    version,
    release_url: release.html_url,
  };
}

/**
 * @returns {Promise<import("./types.js").Result>}
 */
async function createReleasePR() {
  const isDryRun = Config.isDryRun;

  const developBranchSha = (
    await octokit.rest.repos.getBranch({
      ...Config.repo,
      branch: Config.developBranch,
    })
  ).data.commit.sha;

  console.log(
    `create_release: Generating release notes for ${developBranchSha}`,
  );

  console.log("0");

  // developBranch and mainBranch are almost identical
  // so we can use developBranch for ahead-of-time release note
  const { data: latestRelease } = await octokit.rest.repos
    .getLatestRelease(Config.repo)
    .catch(() => ({ data: null }));

  console.log("1");

  const latest_release_tag_name = latestRelease?.tag_name;

  console.log("2");

  /**
   * @type {string}
   */
  let version;
  if (Config.version) {
    version = Config.version;
    console.log("3");
  } else if (Config.versionIncrement) {
    console.log("4");
    const increasedVersion = semverInc(
      latest_release_tag_name || "0.0.0",
      Config.versionIncrement,
      { loose: true },
    );
    console.log("5");
    if (!increasedVersion) {
      throw new Error(
        `create_release: Could not increment version ${latest_release_tag_name} with ${Config.versionIncrement}`,
      );
    }
    version = increasedVersion;
  } else {
    console.log("6");
    version = developBranchSha;
  }

  console.log("7");
  const { md, config } = await generate({
    token: process.env.GITHUB_TOKEN,
  });
  console.log("8");

  const releasePrBody = `${md}
    
## Release summary

${Config.releaseSummary}
  `;

  console.log(releasePrBody);

  const releaseBranch = `${Config.releaseBranchPrefix}${version}`;
  let pull_number;

  if (!isDryRun) {
    console.log(`create_release: Creating release branch`);

    // create release branch from latest sha of develop branch
    await octokit.rest.git.createRef({
      ...Config.repo,
      ref: `refs/heads/${releaseBranch}`,
      sha: developBranchSha,
    });

    console.log(`create_release: Creating Pull Request`);

    const { data: pullRequest } = await octokit.rest.pulls.create({
      ...Config.repo,
      title: `Release ${config.name || version}`,
      body: releasePrBody,
      head: releaseBranch,
      base: Config.prodBranch,
      maintainer_can_modify: false,
    });

    pull_number = pullRequest.number;

    await octokit.rest.issues.addLabels({
      ...Config.repo,
      issue_number: pullRequest.number,
      labels: ["release"],
    });

    await createExplainComment(pullRequest.number);

    console.log(
      `create_release: Pull request has been created at ${pullRequest.html_url}`,
    );
  } else {
    console.log(
      `create_release: Dry run: would have created release branch ${releaseBranch} and PR with body:\n${releasePrBody}`,
    );
  }

  // Parse the PR body for PR numbers
  let mergedPrNumbers = (md.match(/pull\/\d+/g) || []).map((prNumber) =>
    Number(prNumber.replace("pull/", "")),
  );
  // remove duplicates due to the "New contributors" section
  mergedPrNumbers = Array.from(new Set(mergedPrNumbers)).sort();

  return {
    type: "release",
    pull_number: pull_number,
    pull_numbers_in_release: mergedPrNumbers.join(","),
    version,
    release_branch: releaseBranch,
    latest_release_tag_name,
  };
}

const start = async () => {
  /**
   * @type {Result | undefined}
   */
  console.log(`gitflow-workflow-action: running with config`, Config);

  let res;
  if (
    github.context.eventName === "pull_request" &&
    github.context.payload.action === "closed"
  ) {
    console.log(
      `gitflow-workflow-action: Pull request closed. Running executeOnRelease...`,
    );
    res = await executeOnRelease();
  } else if (github.context.eventName === "workflow_dispatch") {
    console.log(
      `gitflow-workflow-action: Workflow dispatched. Running createReleasePR...`,
    );
    res = await createReleasePR();
  } else {
    console.log(
      `gitflow-workflow-action: does not match any conditions to run. Skipping...`,
    );
  }
  if (res) {
    console.log(
      `gitflow-workflow-action: Setting output: ${JSON.stringify(res)}`,
    );
    for (const key of Object.keys(res)) {
      core.setOutput(key, res[key]);
    }
  }
};

start()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    core.setFailed(err.message);
    process.exitCode = 1;
  });
