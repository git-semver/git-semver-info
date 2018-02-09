const git = require('nodegit');
const BranchInfo = require('./base');
const VersionInfo = require('../version');
const template = require('lodash/template');
const defaultConfig = require('../default-config');

const featureTagRexp = /^feature\/(.*)$/;

class FeatureBranchInfo extends BranchInfo
{
  findLastCommonCommit(targetBranchCommit, otherBranchCommit)
  {
    return new Promise((searchCommitResolve, searchCommitReject) =>
    {
      const targetHistory = targetBranchCommit.history();
      const otherHistory = otherBranchCommit.history();
      const getHistoryReader = (history) => (
        new Promise((readAllHistory) =>
        {
          history.on('end', readAllHistory);
          history.on('error', searchCommitReject);
        })
      );

      const targetHistoryReader = getHistoryReader(targetHistory);
      const otherHistoryReader = getHistoryReader(otherHistory);

      targetHistory.start();
      otherHistory.start();

      Promise.all([ targetHistoryReader, otherHistoryReader ])
        .then(([ targetBranchCommits, otherBranchCommits ]) =>
        {
          this.lookupFeatureTaggedCommit(targetBranchCommits, otherBranchCommits)
            .then(({ commit: taggedFeatureCommit, featureTag }) =>
            {
              if (taggedFeatureCommit)
              {
                return searchCommitResolve({ sha: taggedFeatureCommit.sha(), featureTag });
              }

              this.lookupJointCommit(targetBranchCommits, otherBranchCommits)
                .then(sha => { searchCommitResolve({ sha }) })
                .catch(searchCommitReject);
            });
        });
    });
  }

  getFeatureCommitsIds(targetBranchCommits, otherBranchCommits)
  {
    const targetBranchIds = new Set(targetBranchCommits.map(commit => commit.id()));
    const otherBranchIds = new Set(otherBranchCommits.map(commit => commit.id()));

    const featureCommitsIds = Array.from(new Set(
      [...targetBranchIds].filter(x => !otherBranchIds.has(x))));

    if (featureCommitsIds.length === 0)
    {
      throw(new Error('Not found joint commit'));
    }

    //console.log(featureCommitsIds);

    return featureCommitsIds;
  }

  lookupFeatureTag(featureCommitsIds)
  {
    return git.Tag
      .list(this.repo)
      .then(list =>
        Promise.all(
          list
            .filter(tagName => featureTagRexp.test(tagName))
            .map(tagName =>
              git.Reference.lookup(this.repo, `refs/tags/${tagName}`)
                .then(ref =>
                  git.Tag.lookup(this.repo, ref.target())
                )
            )
          )
          .then(tags =>
            tags.find(tagRef =>
              featureCommitsIds.find(commitId =>
                commitId.equal(tagRef.targetId()))
            )
          )
      );
  }

  lookupFeatureTaggedCommit(targetBranchCommits, otherBranchCommits)
  {
    const featureCommitsIds = this.getFeatureCommitsIds(targetBranchCommits, otherBranchCommits);
    const featureCommitsSet = new Set(featureCommitsIds);
    return new Promise((resolve, reject) =>
    {

      this.lookupFeatureTag(featureCommitsIds).then(tag =>
        {
          if (tag)
          {
            return git.Commit.lookup(this.repo, tag.targetId()).then(commit =>
              {
                const result = tag.name().match(featureTagRexp)
                const featureTag = result[1];
                resolve({ commit, featureTag });
              }).catch(reject);
          }

          resolve({ commit: undefined, featureTag: undefined });
        });

      return;
    });
  }

  getFeatureFirstCommit()
  {
    return new Promise((resolve, reject) =>
      this.getCurrentReferenceCommit()
        .catch(reject)
        .then(featureCommit =>
          this.getDevelopBranchCommit()
            .catch(reject)
            .then(developCommit =>
              this.findLastCommonCommit(featureCommit, developCommit)
                .catch(reject)
                .then(resolve))));
  }

  buildPrerelease(firstFeatureCommitSha, featureBranchCommitsCount, existFeatureTag)
  {
    const tmp = this.config.get('prerelease.feature', defaultConfig.prerelease.feature);
    const featureTag = existFeatureTag || firstFeatureCommitSha.slice(0, 7);
    const commitsCount = (existFeatureTag ? featureBranchCommitsCount + 1 : featureBranchCommitsCount);
    return template(tmp)({
      firstFeatureCommitSha: featureTag,
      featureBranchCommitsCount: commitsCount
    });
  }

  calculateVersion(packageVersionInfo)
  {
    return new Promise((resolve, reject) =>
      this.getFeatureFirstCommit()
        .catch(reject)
        .then(({ sha: featureFirstCommitSha, featureTag }) =>
          this.getCommitsCountFrom(featureFirstCommitSha)
            .catch(reject)
            .then(commitsCount =>
            {
              const elements = packageVersionInfo.getElements();
              resolve(new VersionInfo({
                ...elements,
                minor: (+elements.minor + 1),
                patch: 0,
                prerelease: this.buildPrerelease(featureFirstCommitSha, commitsCount, featureTag)
              }))
            })));
  }
}

FeatureBranchInfo.featureTagRexp = featureTagRexp;

module.exports = FeatureBranchInfo;
