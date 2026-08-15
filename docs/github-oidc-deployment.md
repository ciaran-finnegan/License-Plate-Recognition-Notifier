# GitHub OIDC Deployment Runbook

This runbook moves the Notifier Lambda deployment from long-lived AWS access
keys to GitHub Actions OpenID Connect (OIDC). The checked-in workflow deploys
only on pushes to `main`, uses the GitHub `production` environment, and passes
the environment variables `AWS_ROLE_ARN`, `AWS_REGION`, and
`AWS_LAMBDA_FUNCTION_NAME` to the deployment steps.

This file documents the operator procedure. It does not configure or deploy
any AWS or GitHub external state. Complete the AWS and GitHub steps in the
listed order, record the evidence for each check, and keep the PR unmerged
until every checklist item passes.

## Values to supply

Replace the angle-bracket placeholders in both policy templates with the same
values. Do not replace the literal GitHub OIDC audience or the subject shape.

| Placeholder | Meaning | Example shape |
| --- | --- | --- |
| `<AWS_ACCOUNT_ID>` | 12-digit AWS account ID that owns the deployment role and Lambda | `123456789012` |
| `<ROLE_NAME>` | IAM role name assumed by the GitHub Actions workflow | `github-notifier-lambda-deploy` |
| `<AWS_REGION>` | AWS region containing the Notifier Lambda | `eu-west-1` |
| `<LAMBDA_FUNCTION_NAME>` | Exact Lambda function name updated by the workflow | `license-plate-notifier` |
| `OWNER/REPOSITORY` | GitHub owner and repository, written as `OWNER/REPOSITORY` | `example-org/license-plate-recognition-notifier` |

The role ARN stored in GitHub must therefore be:

```text
arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>
```

The Lambda ARN in the permission policy must identify the one function that
the workflow is allowed to update:

```text
arn:aws:lambda:<AWS_REGION>:<AWS_ACCOUNT_ID>:function:<LAMBDA_FUNCTION_NAME>
```

## 1. Create the GitHub IAM OIDC provider

In the AWS account, open IAM **Identity providers** and look for
`token.actions.githubusercontent.com`. If the provider is absent, create the
GitHub IAM OIDC provider with these exact values:

- Issuer URL: `https://token.actions.githubusercontent.com`
- Audience (client ID): `sts.amazonaws.com`

If the provider already exists, verify that its URL and audience match those
values before continuing. Reuse the account-level provider rather than creating
a duplicate. Record its provider ARN; it must be
`arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`.

## 2. Create the OIDC trust policy

Configure the AWS IAM role's trust relationship with this complete policy.
The `sub` condition restricts assumption to this repository's `production`
environment; a workflow from another repository, branch, or environment does
not match the subject.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GitHubActionsProductionEnvironment",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:OWNER/REPOSITORY:environment:production"
        }
      }
    }
  ]
}
```

Confirm that the IAM OIDC provider is exactly
`token.actions.githubusercontent.com`, the audience is exactly
`sts.amazonaws.com`, and the subject is exactly
`repo:OWNER/REPOSITORY:environment:production` after substitution. The
repository and environment restriction is intentional: keep it exact rather
than widening it to all branches or all environments.

## 3. Attach the deployment permission policy

Attach this complete permissions policy to the role named by `<ROLE_NAME>`.
It grants only the Lambda code update used by
`.github/workflows/deploy-lambda.yml`, and its single resource is the one
Lambda ARN constructed from `<AWS_REGION>`, `<AWS_ACCOUNT_ID>`, and
`<LAMBDA_FUNCTION_NAME>`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UpdateNotifierLambdaCode",
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode"
      ],
      "Resource": "arn:aws:lambda:<AWS_REGION>:<AWS_ACCOUNT_ID>:function:<LAMBDA_FUNCTION_NAME>"
    }
  ]
}
```

Do not add `Resource: "*"`, additional Lambda functions, or unrelated AWS
actions to this deployment role. If the workflow later needs a new AWS API,
review and change the policy deliberately rather than broadening it during a
deployment incident.

## 4. Configure the GitHub `production` environment

In the repository's `production` environment, configure these **variables**:

- `AWS_ROLE_ARN` = `arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>`
- `AWS_REGION` = `<AWS_REGION>`
- `AWS_LAMBDA_FUNCTION_NAME` = `<LAMBDA_FUNCTION_NAME>`

The workflow must retain these job settings:

- `environment: production`
- `permissions: contents: read` and `id-token: write`
- `role-to-assume: ${{ vars.AWS_ROLE_ARN }}`
- `aws-region: ${{ vars.AWS_REGION }}`

Do not create or retain `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` as
deployment credentials. OIDC exchanges the short-lived GitHub token for a
short-lived AWS role session, so no static AWS key is needed in repository or
environment secrets.

Before approving this migration, require the release process to retain the
exact `deployment-package.zip` and its SHA-256 digest from every successful
deployment in an approved immutable artifact store. Its retention period must
cover the organization's production rollback window. The current deployment
workflow builds the ZIP but does not itself upload it, so rollback is not ready
until an operator has verified that the artifact is retained elsewhere and can
be downloaded by immutable workflow run ID and commit SHA.

## 5. Initial OIDC deployment validation

Perform this initial validation while the old IAM access keys still exist. The
workflow must not reference or consume them; their temporary presence only
preserves the ability to investigate before retirement.

Run the deployment from the intended commit and capture the workflow run URL,
deployed commit SHA, Lambda function name, AWS region, retained artifact ID,
and artifact SHA-256 digest.

- [ ] The PR is still unmerged while this checklist is incomplete.
- [ ] The GitHub job is attached to the `production` environment.
- [ ] `AWS_ROLE_ARN`, `AWS_REGION`, and `AWS_LAMBDA_FUNCTION_NAME` resolve to
      the intended values.
- [ ] The job receives an OIDC token and the credentials action assumes the
      expected role; no static AWS key step runs.
- [ ] The deployment completes with `lambda:UpdateFunctionCode` against the
      intended single Lambda ARN.
- [ ] The deployed code and retained `deployment-package.zip` correspond to the
      recorded workflow commit and artifact digest.
- [ ] A test invocation or the normal event path produces the expected
      Notifier behavior and CloudWatch logs contain no deployment error.
- [ ] CloudTrail shows `AssumeRoleWithWebIdentity` for the expected role,
      principal subject `repo:OWNER/REPOSITORY:environment:production`, and
      session `github-actions-lambda-deploy`.
- [ ] CloudTrail attributes `UpdateFunctionCode` to that assumed-role session,
      not to the IAM user that owns the old static keys.
- [ ] The initial workflow URL, CloudTrail event IDs, test evidence, and
      artifact details are recorded in the change record.

Do not retire any old keys until every initial validation item passes. If one
fails, stop promotion, preserve the evidence, and correct the OIDC or artifact
configuration before repeating this section.

## 6. Retire the static keys

After the initial OIDC deployment and CloudTrail evidence pass:

1. Identify the IAM user and access keys previously used by GitHub Actions.
2. Confirm the workflow and the `production` environment contain no
   `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` values.
3. Deactivate every old access key. If policy requires immediate deletion,
   delete the keys instead; cover both keys if the old user has two.
4. Record the IAM user, key IDs, retirement action, and timestamp in the change
   record. Do not delete the OIDC deployment role.

Do not reactivate or recreate static keys if the next validation fails. Use the
OIDC artifact rollback in the break-glass section.

## 7. Post-retirement validation

After the old keys are deactivated or deleted, run a second deployment through
the same OIDC workflow and validate the application again.

- [ ] The second deployment succeeds while every old access key remains
      deactivated or deleted.
- [ ] A test invocation or the normal event path produces the expected
      Notifier behavior and CloudWatch logs contain no deployment error.
- [ ] CloudTrail shows `AssumeRoleWithWebIdentity` for the expected role,
      principal subject `repo:OWNER/REPOSITORY:environment:production`, and
      session `github-actions-lambda-deploy` for the second run.
- [ ] CloudTrail attributes the second `UpdateFunctionCode` event to that
      assumed-role session and shows no use of the retired IAM user.
- [ ] Record the second workflow run URL, commit SHA, CloudTrail event IDs,
      test evidence, and access-key retirement timestamp.
- [ ] Permanently delete any old key that was only deactivated, then record its
      deletion time. Do not perform another deployment with that key.

The PR remains unmerged until every checklist item passes. If any item fails,
stop promotion, preserve the initial and post-retirement evidence, and use the
rollback procedure without restoring static keys.

## 8. Break-glass rollback

Rollback redeploys the exact retained, known-good ZIP to `$LATEST`; it does not
restore static AWS keys. Selecting an old published version does not restore
`$LATEST`, because published Lambda versions are immutable. Do not pass a
version qualifier to `update-function-code`.

The rollback operator must have permission to disable and dispatch repository
Actions workflows, read the retained artifact, and approve the `production`
environment. The OIDC role must retain only the documented
`lambda:UpdateFunctionCode` permission on the named Lambda ARN. Run the AWS
command inside an approved GitHub Actions rollback job that has
`id-token: write`, uses `environment: production`, and assumes the same OIDC
role through `aws-actions/configure-aws-credentials`.

1. Disable the `Deploy Python Lambda Function` workflow in GitHub Actions to
   prevent further automatic deployments while the incident is investigated.
2. Record the failed run URL, commit SHA, Lambda function name, region, and
   relevant CloudTrail and CloudWatch event IDs.
3. Select the retained `deployment-package.zip` from the last known-good
   workflow run. Verify its immutable run ID, commit SHA, and SHA-256 digest,
   then download it to the rollback job's working directory with that exact
   filename.
4. After the rollback job assumes the OIDC role, run this exact command:

   ```bash
   aws lambda update-function-code \
     --function-name "<LAMBDA_FUNCTION_NAME>" \
     --zip-file fileb://deployment-package.zip \
     --region "<AWS_REGION>"
   ```

5. Wait for the Lambda update to complete, verify `$LATEST` contains the
   retained package, invoke the function through the approved test path, and
   check CloudWatch and CloudTrail. Record the rollback job URL, artifact
   digest, command output, and verification event IDs.
6. Keep the OIDC trust and permission policies in place. Do not restore
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or any other static keys.
7. Re-enable the normal deployment workflow only after the failed policy,
   environment variable, or application change is corrected and both
   validation checklists can be completed again.

If the OIDC role itself is unavailable, use the separately approved AWS
break-glass operator identity and its existing audited process to run the same
ZIP redeployment command. That identity is an emergency AWS operator path, not
a GitHub Actions credential, and must not be added to repository or environment
secrets.

## Completion record

Attach the provider and policy reviews, GitHub environment variable review,
initial and post-retirement workflow URLs, both CloudTrail validations,
artifact-retention evidence, static-key retirement evidence, and any rollback
evidence to the change record. The deployment migration is complete only when
the checklist is fully checked and the PR has then been reviewed and merged.
