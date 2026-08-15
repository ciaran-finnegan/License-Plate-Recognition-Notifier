import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('./deploy-lambda.yml', import.meta.url));

test('deploy workflow uses GitHub OIDC and production variables', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID/);
  assert.doesNotMatch(workflow, /AWS_SECRET_ACCESS_KEY/);
  assert.match(
    workflow,
    /jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    environment: production/,
  );
  assert.match(
    workflow,
    /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/,
  );
  assert.match(
    workflow,
    /actions\/setup-python@42375524e23c412d93fb67b49958b491fce71c38/,
  );
  assert.match(
    workflow,
    /aws-actions\/configure-aws-credentials@b47578312673ae6fa5b5096b330d9fbac3d116df/,
  );
  assert.match(workflow, /role-to-assume: \$\{\{ vars\.AWS_ROLE_ARN \}\}/);
  assert.match(workflow, /aws-region: \$\{\{ vars\.AWS_REGION \}\}/);
  assert.match(workflow, /role-session-name: github-actions-lambda-deploy/);
  assert.match(
    workflow,
    /--function-name "\$\{\{ vars\.AWS_LAMBDA_FUNCTION_NAME \}\}"/,
  );
  assert.match(workflow, /--region "\$\{\{ vars\.AWS_REGION \}\}"/);
});
