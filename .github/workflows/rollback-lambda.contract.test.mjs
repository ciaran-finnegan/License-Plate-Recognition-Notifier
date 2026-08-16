import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./rollback-lambda.yml', import.meta.url);

function actionRefs(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
}

function runBlocks(workflow) {
  const lines = workflow.split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const run = lines[index].match(/^(\s*)run:\s*\|\s*$/);
    if (!run) continue;

    const indent = run[1].length;
    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const lineIndent = line.match(/^\s*/)[0].length;
      if (line.trim() && lineIndent <= indent) {
        index -= 1;
        break;
      }
      block.push(line);
    }
    blocks.push(block.join('\n'));
  }

  return blocks;
}

test('rollback is manual, production-gated, and serialized with deployments', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /on:\n  workflow_dispatch:\n    inputs:/);
  assert.match(workflow, /deployment_run_id:\n\s+description:/);
  assert.match(workflow, /expected_commit_sha:\n\s+description:/);
  assert.match(workflow, /expected_sha256:\n\s+description:/);
  assert.doesNotMatch(workflow, /artifact_name:\n\s+description:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|pull_request_target|schedule):/m);
  assert.match(
    workflow,
    /concurrency:\n  group: production-lambda-deployment\n  cancel-in-progress: false/,
  );
  assert.match(
    workflow,
    /permissions:\n\s+actions: read\n\s+contents: read\n\s+id-token: write\n\s+environment: production/,
  );
});

test('rollback binds a successful main deploy run to the expected commit', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const verifyRunIndex = workflow.indexOf('- name: Verify source deployment run');
  const downloadIndex = workflow.indexOf('- name: Download deployment artifact');
  const checksumIndex = workflow.indexOf('- name: Verify deployment artifact');
  const credentialsIndex = workflow.indexOf('- name: Configure AWS credentials');

  assert.ok(verifyRunIndex >= 0);
  assert.ok(downloadIndex > verifyRunIndex);
  assert.ok(checksumIndex > downloadIndex);
  assert.ok(credentialsIndex > checksumIndex);
  assert.match(workflow, /\.status == "completed"/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /\.path == "\.github\/workflows\/deploy-lambda\.yml"/);
  assert.match(workflow, /\.head_branch == "main"/);
  assert.match(workflow, /\.head_sha/);
  assert.match(workflow, /"\$run_head_sha" != "\$EXPECTED_COMMIT_SHA"/);
  assert.match(
    workflow,
    /uses: actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/,
  );
  assert.match(workflow, /run-id: \$\{\{ inputs\.deployment_run_id \}\}/);
  assert.match(workflow, /name: lambda-deployment-package/);
  assert.doesNotMatch(workflow, /inputs\.artifact_name/);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /path: rollback-artifact/);
});

test('rollback checks the bundled checksum and the independent expected digest before OIDC', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const checksumIndex = workflow.indexOf('- name: Verify deployment artifact');
  const credentialsIndex = workflow.indexOf('- name: Configure AWS credentials');

  assert.ok(checksumIndex >= 0);
  assert.ok(credentialsIndex > checksumIndex);
  assert.match(workflow, /sha256sum --check deployment-package\.zip\.sha256/);
  assert.match(
    workflow,
    /computed_sha256="\$\(sha256sum deployment-package\.zip\)"/,
  );
  assert.match(workflow, /computed_sha256="\$\{computed_sha256%% \*\}"/);
  assert.match(workflow, /"\$computed_sha256" != "\$EXPECTED_SHA256"/);
});

test('rollback has no credential escape hatch and pins every action', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i);
  assert.doesNotMatch(
    workflow,
    /aws-access-key-id|aws-secret-access-key|use-existing-credentials|role-chaining|force-skip-oidc/i,
  );
  assert.doesNotMatch(workflow, /\bsecrets\./i);
  assert.doesNotMatch(workflow, /(?:pip3?|python\s+-m\s+pip)\s+install[^\n]*\bawscli\b/i);

  const refs = actionRefs(workflow);
  assert.ok(refs.length > 0);
  assert.ok(refs.every((ref) => /@[0-9a-f]{40}$/.test(ref)), refs.join('\n'));
});

test('rollback validates inputs and variables without shell interpolation', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const shell = runBlocks(workflow).join('\n');

  assert.doesNotMatch(shell, /\$\{\{/);
  assert.match(workflow, /AWS_ROLE_ARN: \$\{\{ vars\.AWS_ROLE_ARN \}\}/);
  assert.match(workflow, /AWS_REGION: \$\{\{ vars\.AWS_REGION \}\}/);
  assert.match(
    workflow,
    /AWS_LAMBDA_FUNCTION_NAME: \$\{\{ vars\.AWS_LAMBDA_FUNCTION_NAME \}\}/,
  );
  assert.match(workflow, /DEPLOYMENT_RUN_ID: \$\{\{ inputs\.deployment_run_id \}\}/);
  assert.match(workflow, /EXPECTED_COMMIT_SHA: \$\{\{ inputs\.expected_commit_sha \}\}/);
  assert.match(workflow, /EXPECTED_SHA256: \$\{\{ inputs\.expected_sha256 \}\}/);
  assert.doesNotMatch(workflow, /ARTIFACT_NAME:/);
  assert.match(shell, /\[\[ "\$DEPLOYMENT_RUN_ID" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/);
  assert.match(shell, /\[\[ "\$EXPECTED_COMMIT_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(shell, /\[\[ "\$EXPECTED_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
  assert.match(shell, /\[\[ "\$AWS_ROLE_ARN" =~ \^arn:/);
  assert.match(shell, /\[\[ "\$AWS_REGION" =~ \^\[a-z\]/);
  assert.match(shell, /\[\[ "\$AWS_LAMBDA_FUNCTION_NAME" =~ \^\[A-Za-z0-9_/);
  assert.match(shell, /--function-name "\$AWS_LAMBDA_FUNCTION_NAME"/);
  assert.match(shell, /--region "\$AWS_REGION"/);
});

test('rollback guards current main and assumes OIDC immediately before update', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const stepNames = [...workflow.matchAll(/^\s+- name: (.+)$/gm)].map(
    (match) => match[1],
  );
  const guardIndex = stepNames.indexOf('Guard current main');
  const credentialsIndex = stepNames.indexOf('Configure AWS credentials');
  const rollbackIndex = stepNames.indexOf('Roll back Lambda');

  assert.ok(guardIndex >= 0);
  assert.equal(credentialsIndex, guardIndex + 1);
  assert.equal(rollbackIndex, credentialsIndex + 1);
  assert.match(workflow, /EXPECTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(
    workflow,
    /aws-actions\/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c # v6\.2\.3/,
  );
  assert.match(workflow, /role-to-assume: \$\{\{ vars\.AWS_ROLE_ARN \}\}/);
  assert.match(workflow, /aws-region: \$\{\{ vars\.AWS_REGION \}\}/);
  assert.match(workflow, /role-session-name: github-actions-lambda-rollback/);
});
