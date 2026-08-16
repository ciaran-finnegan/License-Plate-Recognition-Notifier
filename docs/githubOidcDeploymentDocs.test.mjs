import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const guidePath = new URL('./github-oidc-deployment.md', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

function parseJsonPolicyBlocks(markdown) {
  return [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  );
}

test('OIDC deployment guide documents creating the GitHub IAM provider when absent', async () => {
  const guide = await readFile(guidePath, 'utf8');

  assert.match(guide, /create the GitHub IAM OIDC provider/i);
  assert.match(guide, /if .*provider.*(?:is )?absent/i);
  assert.match(guide, /issuer(?: URL)?: `https:\/\/token\.actions\.githubusercontent\.com`/i);
  assert.match(guide, /audience(?: \(client ID\))?: `sts\.amazonaws\.com`/i);
});

test('OIDC policy templates parse and enforce the exact trust and Lambda scope', async () => {
  const guide = await readFile(guidePath, 'utf8');
  const policies = parseJsonPolicyBlocks(guide);

  assert.equal(policies.length, 2);
  const [trustPolicy, permissionPolicy] = policies;
  assert.equal(trustPolicy.Version, '2012-10-17');
  assert.equal(trustPolicy.Statement.length, 1);

  const trustStatement = trustPolicy.Statement[0];
  assert.deepEqual(trustStatement.Principal, {
    Federated:
      'arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com',
  });
  assert.equal(trustStatement.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(trustStatement.Condition, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub':
        'repo:ciaran-finnegan/License-Plate-Recognition-Notifier:environment:production',
    },
  });

  assert.equal(permissionPolicy.Version, '2012-10-17');
  assert.equal(permissionPolicy.Statement.length, 1);
  const permissionStatement = permissionPolicy.Statement[0];
  const actions = Array.isArray(permissionStatement.Action)
    ? permissionStatement.Action
    : [permissionStatement.Action];
  const resources = Array.isArray(permissionStatement.Resource)
    ? permissionStatement.Resource
    : [permissionStatement.Resource];

  assert.deepEqual(actions, ['lambda:UpdateFunctionCode']);
  assert.deepEqual(resources, [
    'arn:aws:lambda:<AWS_REGION>:<AWS_ACCOUNT_ID>:function:<LAMBDA_FUNCTION_NAME>',
  ]);
  assert.ok(resources.every((resource) => !resource.includes('*')));
});

test('OIDC deployment guide requires production environment protections', async () => {
  const guide = await readFile(guidePath, 'utf8');

  assert.match(guide, /required reviewer/i);
  assert.match(guide, /prevent self-review/i);
  assert.match(guide, /deployment branch(?:es)?.*`main`/i);
  assert.match(guide, /administrator bypass.*disabled/i);
  assert.match(guide, /where (?:the plan|supported|available)/i);
});

test('OIDC deployment guide isolates untrusted packaging from production OIDC', async () => {
  const guide = await readFile(guidePath, 'utf8');

  assert.match(guide, /packag(?:e|ing) job/i);
  assert.match(guide, /`contents: read` only/i);
  assert.match(guide, /no `id-token: write`/i);
  assert.match(guide, /no `production` environment/i);
  assert.match(guide, /install scripts.*cannot request.*OIDC token/is);
  assert.match(guide, /deploy job.*`needs: package`/is);
  assert.match(guide, /guard.*before.*download.*checksum.*OIDC/is);
});

test('OIDC deployment guide stages readiness, merge deployment, retirement, and manual revalidation', async () => {
  const guide = await readFile(guidePath, 'utf8');
  const readinessIndex = guide.indexOf('## 5. Pre-merge external readiness');
  const firstDeployIndex = guide.indexOf('## 6. Merge-triggered first deployment');
  const retirementIndex = guide.indexOf('## 7. Retire the static keys');
  const revalidationIndex = guide.indexOf('## 8. workflow_dispatch revalidation');
  const rollbackIndex = guide.indexOf('## 9. Break-glass rollback');

  assert.ok(readinessIndex >= 0);
  assert.ok(firstDeployIndex > readinessIndex);
  assert.ok(retirementIndex > firstDeployIndex);
  assert.ok(revalidationIndex > retirementIndex);
  assert.ok(rollbackIndex > revalidationIndex);

  const readiness = guide.slice(readinessIndex, firstDeployIndex);
  const firstDeploy = guide.slice(firstDeployIndex, retirementIndex);
  const retirement = guide.slice(retirementIndex, revalidationIndex);
  const revalidation = guide.slice(revalidationIndex, rollbackIndex);

  assert.match(readiness, /draft and unmerged/i);
  assert.match(readiness, /provider.*role.*environment.*variables/is);
  assert.match(firstDeploy, /merge.*`main`/i);
  assert.match(firstDeploy, /push.*first deployment/i);
  assert.match(firstDeploy, /validate/i);
  assert.match(retirement, /deactivate every/i);
  assert.match(revalidation, /workflow_dispatch/);
  assert.match(revalidation, /permanently delete/i);
});

test('OIDC deployment guide inventories every secret scope and retires every IAM key', async () => {
  const guide = await readFile(guidePath, 'utf8');

  assert.match(guide, /repository secrets/i);
  assert.match(guide, /environment secrets/i);
  assert.match(guide, /organization secrets/i);
  assert.match(guide, /inventory.*IAM user.*access key/is);
  assert.match(guide, /deactivate every.*access key/is);
  assert.match(guide, /revalidat.*workflow_dispatch/is);
  assert.match(guide, /permanently delete every.*access key/is);
});

test('OIDC deployment guide gives exact CloudTrail field validation', async () => {
  const guide = await readFile(guidePath, 'utf8');

  assert.match(guide, /`eventSource` = `sts\.amazonaws\.com`/);
  assert.match(guide, /`eventName` = `AssumeRoleWithWebIdentity`/);
  assert.match(guide, /`requestParameters\.roleArn`/);
  assert.match(guide, /`requestParameters\.roleSessionName`/);
  assert.match(guide, /`responseElements\.subjectFromWebIdentityToken`/);
  assert.match(guide, /`responseElements\.audience` = `sts\.amazonaws\.com`/);
  assert.match(guide, /`eventSource` = `lambda\.amazonaws\.com`/);
  assert.match(guide, /`eventName` = `UpdateFunctionCode20150331v2`/);
  assert.match(guide, /`requestParameters\.functionName`/);
  assert.match(guide, /`userIdentity\.type` = `AssumedRole`/);
  assert.match(guide, /`userIdentity\.arn`/);
  assert.match(guide, /github-actions-lambda-deploy/);
});

test('OIDC deployment guide gives an executable workflow rollback', async () => {
  const guide = await readFile(guidePath, 'utf8');
  const rollbackIndex = guide.indexOf('## 9. Break-glass rollback');
  const rollback = guide.slice(rollbackIndex);

  assert.ok(rollbackIndex >= 0);
  assert.match(rollback, /rollback-lambda\.yml/);
  assert.match(rollback, /workflow_dispatch/);
  assert.match(rollback, /successful.*run ID/i);
  assert.match(rollback, /`expected_commit_sha`/);
  assert.match(rollback, /40.*lowercase hexadecimal/i);
  assert.match(rollback, /`expected_sha256`/);
  assert.match(rollback, /64.*lowercase hexadecimal/i);
  assert.match(rollback, /artifact name.*hardcoded.*`lambda-deployment-package`/is);
  assert.match(rollback, /run page.*head commit SHA/is);
  assert.match(rollback, /deployment record.*SHA-256/is);
  assert.match(rollback, /bundled checksum.*independent.*computed digest/is);
  assert.match(rollback, /production.*reviewer/is);
  assert.match(rollback, /does not\s+restore static|static.*key.*back/is);
});

test('README directs operators to OIDC deployment documentation and removes static-key setup', async () => {
  const readme = await readFile(readmePath, 'utf8');

  assert.match(readme, /docs\/github-oidc-deployment\.md/);
  assert.doesNotMatch(readme, /AWS_ACCESS_KEY_ID/);
  assert.doesNotMatch(readme, /AWS_SECRET_ACCESS_KEY/);
});
