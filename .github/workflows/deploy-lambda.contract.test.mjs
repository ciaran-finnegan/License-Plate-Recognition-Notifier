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
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/,
  );
  assert.match(
    workflow,
    /actions\/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7\.0\.0/,
  );
  assert.match(
    workflow,
    /aws-actions\/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c # v6\.2\.3/,
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
