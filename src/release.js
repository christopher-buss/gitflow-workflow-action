import semverInc from "semver/functions/inc";
import { Config, octokit } from "./shared.js";
import { createExplainComment } from "./utils.js";
import { generate } from "changelogithub";

/**
 * @returns {Promise<import("./types.js").Result>}
 */
export async function createReleasePR() {
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
