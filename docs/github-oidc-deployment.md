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

## 1. Create the OIDC trust policy

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
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
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

## 2. Attach the deployment permission policy

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

## 3. Configure the GitHub `production` environment

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

## 4. Retire the static keys

Retire the old deployment identity only after the first OIDC deployment has
passed the validation section below.

1. Identify the IAM user and access keys previously used by GitHub Actions.
2. Confirm the workflow and the `production` environment contain no
   `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` values.
3. Disable the old access keys, observe the next validation run, and then
   delete the keys. Delete both keys if the old user has two active keys.
4. Record the IAM user, key IDs, deletion time, and validation run URL in the
   change record. Do not delete the OIDC deployment role.

If the first OIDC validation fails, leave the old keys disabled and use the
break-glass rollback below. Do not put the static keys back into the workflow
or GitHub environment while troubleshooting.

## 5. First-deploy validation checklist

Run the deployment from the intended `main` change and capture the workflow
run URL, deployed commit SHA, Lambda function name, and AWS region.

- [ ] The PR is still unmerged while this checklist is incomplete.
- [ ] The GitHub job is attached to the `production` environment.
- [ ] `AWS_ROLE_ARN`, `AWS_REGION`, and `AWS_LAMBDA_FUNCTION_NAME` resolve to
      the intended values.
- [ ] The job receives an OIDC token and the credentials action assumes the
      expected role; no static AWS key step runs.
- [ ] The deployment completes with `lambda:UpdateFunctionCode` and the
      intended single Lambda ARN.
- [ ] The Lambda code version or deployed commit matches the workflow commit.
- [ ] A test invocation or the normal event path produces the expected
      Notifier behavior and CloudWatch logs contain no deployment error.
- [ ] CloudTrail shows `AssumeRoleWithWebIdentity` for the expected role,
      principal subject `repo:OWNER/REPOSITORY:environment:production`, and
      the expected GitHub Actions session. CloudTrail must not show the retired
      static user performing this deployment.
- [ ] The old static access keys are deleted and the evidence is recorded.

The PR remains unmerged until every checklist item passes. If any item fails,
stop promotion, preserve the evidence, and use the rollback procedure.

## 6. Break-glass rollback

Rollback restores a known-good Lambda code version; it does not restore static
AWS keys.

1. Disable the `Deploy Python Lambda Function` workflow in GitHub Actions to
   prevent further automatic deployments while the incident is investigated.
2. Record the failed run URL, commit SHA, Lambda function name, region, and
   relevant CloudTrail and CloudWatch event IDs.
3. Identify the last known-good Lambda code version or deployment package
   digest. Use the approved AWS operator path to update the same
   `<LAMBDA_FUNCTION_NAME>` to that prior code version in `<AWS_REGION>`.
4. Verify the Lambda version, a test invocation, and CloudWatch logs. Confirm
   that the application behavior is restored.
5. Keep the OIDC trust and permission policies in place. Do not restore
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or any other static keys.
6. Re-enable the workflow only after the failed policy, environment variable,
   or application change is corrected and the first-deploy validation
   checklist can be completed again.

If the OIDC role itself is unavailable, use the separately approved AWS
break-glass operator identity and its existing audited process to restore the
prior Lambda code version. That identity is an emergency AWS operator path,
not a GitHub Actions credential, and must not be added to repository or
environment secrets.

## Completion record

Attach the policy review, GitHub environment variable review, first-deploy
workflow URL, CloudTrail verification, static-key deletion evidence, and any
rollback evidence to the change record. The deployment migration is complete
only when the checklist is fully checked and the PR has then been reviewed and
merged.
