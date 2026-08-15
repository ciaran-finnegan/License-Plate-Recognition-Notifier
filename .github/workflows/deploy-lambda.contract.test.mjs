import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('./deploy-lambda.yml', import.meta.url));

function actionRefs(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
}

function jobBlock(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing ${jobName} job`);

  const contentStart = start + marker.length;
  const nextJob = workflow.slice(contentStart).match(/^  [A-Za-z0-9_-]+:\n/m);
  const end = nextJob ? contentStart + nextJob.index : workflow.length;
  return workflow.slice(start, end);
}

function runBlocks(source) {
  const lines = source.split('\n');
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

function stepNames(job) {
  return [...job.matchAll(/^\s+- name: (.+)$/gm)].map((match) => match[1]);
}

test('deploy workflow has only approved triggers and serializes production changes', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(
    workflow,
    /on:\n  push:\n    branches:\n      - main\n  workflow_dispatch:/,
  );
  assert.doesNotMatch(workflow, /\bpull_request(?:_target)?:/);
  assert.match(
    workflow,
    /concurrency:\n  group: production-lambda-deployment\n  cancel-in-progress: false/,
  );
});

test('package job cannot request OIDC or inherit the production environment', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const preamble = workflow.slice(0, workflow.indexOf('\njobs:'));
  const packageJob = jobBlock(workflow, 'package');

  assert.doesNotMatch(preamble, /^permissions:|^environment:/m);
  assert.match(
    packageJob,
    /^  package:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n/m,
  );
  assert.doesNotMatch(packageJob, /id-token:|actions:|environment:|\bvars\.|\bsecrets\./);
  assert.doesNotMatch(packageJob, /configure-aws-credentials|aws lambda/);
  assert.equal((workflow.match(/id-token:\s*write/g) ?? []).length, 1);
  assert.equal((workflow.match(/environment:\s*production/g) ?? []).length, 1);
});

test('production deploy job depends on packaging and has only required permissions', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deployJob = jobBlock(workflow, 'deploy');

  assert.match(
    deployJob,
    /^  deploy:\n    needs: package\n    runs-on: ubuntu-latest\n    permissions:\n      actions: read\n      contents: read\n      id-token: write\n    environment: production/m,
  );
  assert.doesNotMatch(deployJob, /setup-python|pip install|Create deployment package/);
});

test('package job builds, checksums, and retains the exact artifact', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const packageJob = jobBlock(workflow, 'package');
  const names = stepNames(packageJob);

  assert.ok(names.indexOf('Create deployment package') >= 0);
  assert.ok(
    names.indexOf('Upload deployment artifact') >
      names.indexOf('Create deployment package'),
  );
  assert.match(
    packageJob,
    /python -m pip install --requirement requirements\.txt --target package/,
  );
  assert.match(
    packageJob,
    /sha256sum deployment-package\.zip > deployment-package\.zip\.sha256/,
  );
  assert.match(
    packageJob,
    /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
  );
  assert.match(
    packageJob,
    /with:\n\s+name: lambda-deployment-package\n\s+path: \|\n\s+deployment-package\.zip\n\s+deployment-package\.zip\.sha256\n\s+retention-days: 30\n\s+if-no-files-found: error/,
  );
});

test('deploy guards current main before downloading and verifying the current-run artifact', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deployJob = jobBlock(workflow, 'deploy');
  const names = stepNames(deployJob);
  const guardIndex = names.indexOf('Guard current main');
  const downloadIndex = names.indexOf('Download deployment artifact');
  const verifyIndex = names.indexOf('Verify deployment artifact');
  const finalGuardIndex = names.indexOf('Recheck current main');
  const credentialsIndex = names.indexOf('Configure AWS credentials');
  const deployIndex = names.indexOf('Deploy to Lambda');
  const credentialActions = [
    ...deployJob.matchAll(
      /uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40}/g,
    ),
  ];

  assert.ok(guardIndex >= 0);
  assert.ok(downloadIndex > guardIndex);
  assert.equal(verifyIndex, downloadIndex + 1);
  assert.equal(finalGuardIndex, verifyIndex + 1);
  assert.equal(credentialsIndex, finalGuardIndex + 1);
  assert.equal(deployIndex, credentialsIndex + 1);
  assert.equal(credentialActions.length, 1);
  assert.ok(
    credentialActions[0].index >
      deployJob.indexOf('sha256sum --check deployment-package.zip.sha256'),
  );
  assert.match(deployJob, /EXPECTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(
    deployJob,
    /git fetch --no-tags origin refs\/heads\/main:refs\/remotes\/origin\/main/,
  );
  assert.match(
    deployJob,
    /current_main_sha="\$\(git rev-parse refs\/remotes\/origin\/main\)"/,
  );
  assert.match(deployJob, /"\$EXPECTED_SHA" != "\$current_main_sha"/);
  assert.match(
    deployJob,
    /uses: actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/,
  );
  assert.match(
    deployJob,
    /name: lambda-deployment-package\n\s+path: deployment-artifact/,
  );
  assert.doesNotMatch(deployJob, /run-id:|github-token:/);
  assert.match(deployJob, /sha256sum --check deployment-package\.zip\.sha256/);
  assert.match(
    deployJob,
    /--zip-file "fileb:\/\/deployment-artifact\/deployment-package\.zip"/,
  );
});

test('deploy rechecks current main after checksum immediately before OIDC', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deployJob = jobBlock(workflow, 'deploy');
  const finalGuardStart = deployJob.indexOf('- name: Recheck current main');
  const credentialsStart = deployJob.indexOf('- name: Configure AWS credentials');

  assert.ok(finalGuardStart >= 0);
  assert.ok(
    finalGuardStart >
      deployJob.indexOf('sha256sum --check deployment-package.zip.sha256'),
  );
  assert.ok(credentialsStart > finalGuardStart);

  const finalGuard = deployJob.slice(finalGuardStart, credentialsStart);
  assert.match(finalGuard, /EXPECTED_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(
    finalGuard,
    /\[\[ "\$EXPECTED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/,
  );
  assert.match(
    finalGuard,
    /git fetch --no-tags origin refs\/heads\/main:refs\/remotes\/origin\/main/,
  );
  assert.match(
    finalGuard,
    /current_main_sha="\$\(git rev-parse refs\/remotes\/origin\/main\)"/,
  );
  assert.match(
    finalGuard,
    /\[\[ "\$current_main_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/,
  );
  assert.match(finalGuard, /"\$EXPECTED_SHA" != "\$current_main_sha"/);
  assert.match(finalGuard, /exit 1/);
  assert.equal(
    (
      deployJob.match(
        /git fetch --no-tags origin refs\/heads\/main:refs\/remotes\/origin\/main/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (deployJob.match(/"\$EXPECTED_SHA" != "\$current_main_sha"/g) ?? [])
      .length,
    2,
  );
  assert.doesNotMatch(runBlocks(finalGuard).join('\n'), /\$\{\{/);
});

test('deploy validates variables, keeps contexts out of shell, and uses pinned OIDC', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deployJob = jobBlock(workflow, 'deploy');
  const shell = runBlocks(workflow).join('\n');

  assert.doesNotMatch(shell, /\$\{\{/);
  assert.match(deployJob, /AWS_ROLE_ARN: \$\{\{ vars\.AWS_ROLE_ARN \}\}/);
  assert.match(deployJob, /AWS_REGION: \$\{\{ vars\.AWS_REGION \}\}/);
  assert.match(
    deployJob,
    /AWS_LAMBDA_FUNCTION_NAME: \$\{\{ vars\.AWS_LAMBDA_FUNCTION_NAME \}\}/,
  );
  assert.match(shell, /:\s+"\$\{AWS_ROLE_ARN:\?AWS_ROLE_ARN must be set\}"/);
  assert.match(shell, /:\s+"\$\{AWS_REGION:\?AWS_REGION must be set\}"/);
  assert.match(
    shell,
    /:\s+"\$\{AWS_LAMBDA_FUNCTION_NAME:\?AWS_LAMBDA_FUNCTION_NAME must be set\}"/,
  );
  assert.match(shell, /\[\[ "\$AWS_ROLE_ARN" =~ \^arn:/);
  assert.match(shell, /\[\[ "\$AWS_REGION" =~ \^\[a-z\]/);
  assert.match(shell, /\[\[ "\$AWS_LAMBDA_FUNCTION_NAME" =~ \^\[A-Za-z0-9_/);
  assert.match(shell, /--function-name "\$AWS_LAMBDA_FUNCTION_NAME"/);
  assert.match(shell, /--region "\$AWS_REGION"/);
  assert.match(
    deployJob,
    /aws-actions\/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c # v6\.2\.3/,
  );
  assert.match(deployJob, /role-session-name: github-actions-lambda-deploy/);
});

test('deploy workflow rejects credential fallbacks and pins every action', async () => {
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
  assert.ok(
    refs.includes('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'),
  );
  assert.ok(
    refs.includes('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'),
  );
});
