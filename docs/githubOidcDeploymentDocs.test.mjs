import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const guidePath = new URL('./github-oidc-deployment.md', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);

test('OIDC deployment guide contains the complete trust and permission policies', async () => {
  const guide = await readFile(guidePath, 'utf8');

  assert.match(guide, /repo:OWNER\/REPOSITORY:environment:production/);
  assert.match(guide, /token\.actions\.githubusercontent\.com:aud/);
  assert.match(guide, /"sts\.amazonaws\.com"/);
  assert.match(guide, /token\.actions\.githubusercontent\.com:sub/);
  assert.match(guide, /arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider\/token\.actions\.githubusercontent\.com/);
  assert.match(guide, /sts:AssumeRoleWithWebIdentity/);
  assert.match(guide, /lambda:UpdateFunctionCode/);
  assert.match(guide, /arn:aws:lambda:<AWS_REGION>:<AWS_ACCOUNT_ID>:function:<LAMBDA_FUNCTION_NAME>/);
  assert.match(guide, /AWS account ID/);
  assert.match(guide, /role name/);
  assert.match(guide, /region/);
  assert.match(guide, /Lambda function name/);
});

test('OIDC deployment guide covers setup, retirement, validation, and rollback', async () => {
  const guide = await readFile(guidePath, 'utf8');

  assert.match(guide, /GitHub environment/i);
  assert.match(guide, /AWS_ROLE_ARN/);
  assert.match(guide, /AWS_REGION/);
  assert.match(guide, /AWS_LAMBDA_FUNCTION_NAME/);
  assert.match(guide, /delete|deletion/i);
  assert.match(guide, /AWS_ACCESS_KEY_ID/);
  assert.match(guide, /AWS_SECRET_ACCESS_KEY/);
  assert.match(guide, /CloudTrail/i);
  assert.match(guide, /disable.*workflow|workflow.*disable/i);
  assert.match(guide, /prior.*Lambda.*code version|Lambda.*code version.*prior/i);
  assert.match(guide, /does not restore static|static.*key.*back/i);
  assert.match(guide, /remains unmerged until every checklist item passes/i);
});

test('README directs operators to OIDC deployment documentation and removes static-key setup', async () => {
  const readme = await readFile(readmePath, 'utf8');

  assert.match(readme, /docs\/github-oidc-deployment\.md/);
  assert.doesNotMatch(readme, /AWS_ACCESS_KEY_ID/);
  assert.doesNotMatch(readme, /AWS_SECRET_ACCESS_KEY/);
});
