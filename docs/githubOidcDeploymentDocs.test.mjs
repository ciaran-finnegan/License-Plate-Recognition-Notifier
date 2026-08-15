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
        'repo:OWNER/REPOSITORY:environment:production',
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

test('OIDC deployment guide separates initial validation, key retirement, and post-retirement validation', async () => {
  const guide = await readFile(guidePath, 'utf8');
  const initialValidationIndex = guide.indexOf(
    '## 5. Initial OIDC deployment validation',
  );
  const retirementIndex = guide.indexOf('## 6. Retire the static keys');
  const postRetirementIndex = guide.indexOf(
    '## 7. Post-retirement validation',
  );
  const rollbackIndex = guide.indexOf('## 8. Break-glass rollback');

  assert.ok(initialValidationIndex >= 0);
  assert.ok(retirementIndex > initialValidationIndex);
  assert.ok(postRetirementIndex > retirementIndex);
  assert.ok(rollbackIndex > postRetirementIndex);

  const initialValidation = guide.slice(
    initialValidationIndex,
    retirementIndex,
  );
  const retirement = guide.slice(retirementIndex, postRetirementIndex);
  const postRetirement = guide.slice(postRetirementIndex, rollbackIndex);

  assert.match(initialValidation, /CloudTrail/i);
  assert.doesNotMatch(
    initialValidation,
    /\[[ x]\].*old static access keys are (?:deleted|deactivated)/i,
  );
  assert.match(retirement, /deactivate|delete/i);
  assert.match(postRetirement, /second.*deployment/i);
  assert.match(postRetirement, /CloudTrail/i);
  assert.match(postRetirement, /record.*(?:run URL|event ID)/i);
  assert.match(guide, /remains unmerged until every checklist item passes/i);
});

test('OIDC deployment guide gives an executable retained-artifact rollback', async () => {
  const guide = await readFile(guidePath, 'utf8');
  const rollbackIndex = guide.indexOf('## 8. Break-glass rollback');
  const rollback = guide.slice(rollbackIndex);

  assert.ok(rollbackIndex >= 0);
  assert.match(rollback, /retained.*deployment-package\.zip/i);
  assert.match(rollback, /retention/i);
  assert.match(rollback, /operator.*permission/i);
  assert.match(rollback, /OIDC role/i);
  assert.match(
    rollback,
    /aws lambda update-function-code \\\n+\s+--function-name "<LAMBDA_FUNCTION_NAME>" \\\n+\s+--zip-file fileb:\/\/deployment-package\.zip \\\n+\s+--region "<AWS_REGION>"/,
  );
  assert.match(
    rollback,
    /old (?:published )?version does not\s+restore\s+`\$LATEST`/i,
  );
  assert.match(rollback, /does not\s+restore static|static.*key.*back/is);
});

test('README directs operators to OIDC deployment documentation and removes static-key setup', async () => {
  const readme = await readFile(readmePath, 'utf8');

  assert.match(readme, /docs\/github-oidc-deployment\.md/);
  assert.doesNotMatch(readme, /AWS_ACCESS_KEY_ID/);
  assert.doesNotMatch(readme, /AWS_SECRET_ACCESS_KEY/);
});
