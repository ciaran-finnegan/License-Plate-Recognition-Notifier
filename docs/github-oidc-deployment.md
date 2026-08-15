# GitHub OIDC Deployment Runbook

This runbook replaces long-lived AWS deployment credentials with GitHub Actions
OpenID Connect (OIDC) for the Notifier Lambda. It documents operator-managed
AWS and GitHub state; checking in these files does not create that state.

Keep the pull request draft and unmerged until the pre-merge external readiness
checklist passes. Merging to `main` is intentionally the first live deployment.
Do not run either workflow until the provider, role, environment protections,
and variables described here exist.

## Values to supply

Use the same values throughout the policies, GitHub variables, workflow
evidence, and CloudTrail checks.

| Placeholder | Required value | Example form |
| --- | --- | --- |
| `<AWS_ACCOUNT_ID>` | 12-digit AWS account containing the role and Lambda | `123456789012` |
| `<ROLE_NAME>` | IAM role assumed by GitHub Actions | `github-notifier-lambda-deploy` |
| `<AWS_REGION>` | Region containing the Lambda | `eu-west-1` |
| `<LAMBDA_FUNCTION_NAME>` | Exact Lambda function name | `license-plate-notifier` |

The GitHub variable `AWS_ROLE_ARN` is:

```text
arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>
```

The one permitted Lambda resource is:

```text
arn:aws:lambda:<AWS_REGION>:<AWS_ACCOUNT_ID>:function:<LAMBDA_FUNCTION_NAME>
```

## 1. Create the GitHub IAM OIDC provider

In IAM **Identity providers**, find
`token.actions.githubusercontent.com`. If the provider is absent, create the
GitHub IAM OIDC provider with these exact values:

- Issuer URL: `https://token.actions.githubusercontent.com`
- Audience (client ID): `sts.amazonaws.com`

If it already exists, verify both values and reuse it. Record this provider ARN:

```text
arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com
```

## 2. Create the OIDC trust policy

Create `<ROLE_NAME>` with this trust policy. The audience and subject are
literal constraints. Do not substitute the repository name, use a wildcard, or
add a branch-form subject.

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
          "token.actions.githubusercontent.com:sub": "repo:ciaran-finnegan/License-Plate-Recognition-Notifier:environment:production"
        }
      }
    }
  ]
}
```

Confirm the final trust relationship contains exactly:

- Audience: `sts.amazonaws.com`
- Subject: `repo:ciaran-finnegan/License-Plate-Recognition-Notifier:environment:production`

The subject binds the role to the repository's `production` environment. The
environment deployment-branch rule below supplies the `main` restriction.

## 3. Attach the deployment permission policy

Attach only this policy to `<ROLE_NAME>`. Replace each placeholder with the
value recorded above.

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

Do not add `Resource: "*"`, more Lambda functions, or unrelated actions. Both
deploy and rollback workflows require only `lambda:UpdateFunctionCode` for this
one ARN.

## 4. Configure the GitHub `production` environment

Create the repository environment named exactly `production` and add these
environment **variables**, not secrets:

- `AWS_ROLE_ARN` = `arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>`
- `AWS_REGION` = `<AWS_REGION>`
- `AWS_LAMBDA_FUNCTION_NAME` = `<LAMBDA_FUNCTION_NAME>`

Configure all available environment protections:

- Add at least one required reviewer who can validate the release evidence.
- Enable **prevent self-review** where supported by the repository's GitHub plan.
- Set deployment branches to `main` only.
- Keep administrator bypass disabled where supported; administrators must not
  bypass the production reviewer gate.

The deployment and rollback jobs must retain `environment: production`. The
normal job has `contents: read` and `id-token: write`; rollback additionally
has `actions: read` so it can retrieve an artifact from a selected workflow
run. Neither workflow has a static credential fallback.

Both workflows use the shared `production-lambda-deployment` concurrency group
with `cancel-in-progress: false`. A newer run waits rather than cancelling a
deployment during an AWS API call. Immediately before OIDC, each workflow also
checks that its workflow SHA is still current `main`.

## 5. Pre-merge external readiness

Complete and record this checklist while the PR remains draft and unmerged.
This stage creates and reviews external state but does not run deployment code.

- [ ] The OIDC provider exists with the exact issuer and audience.
- [ ] The role trust policy has the literal repository/environment subject.
- [ ] The role permission policy names only the intended Lambda ARN.
- [ ] The `production` environment exists with its required reviewer,
      self-review protection, `main` deployment branch, and administrator
      bypass control configured as supported.
- [ ] `AWS_ROLE_ARN`, `AWS_REGION`, and `AWS_LAMBDA_FUNCTION_NAME` contain the
      exact reviewed values and are environment variables rather than secrets.
- [ ] The first deploy and rollback approvers know the expected account, role,
      region, function, and change record location.
- [ ] Repository Actions artifact retention permits the workflow's 30-day
      retention, and the rollback window is no longer than 30 days.

Inventory every legacy credential location before the first deploy:

- Repository secrets in **Settings > Secrets and variables > Actions**.
- `production` and every other environment secrets scope.
- Organization secrets whose repository access includes this repository.
- Every IAM user previously used by automation and every access key ID on each
  such user, including inactive or second keys.

Record each scope checked, secret name, IAM user, access key ID, current key
status, owner, and intended retirement action. Do not expose secret values in
the record. Do not deactivate or delete the keys yet; first prove the OIDC path.

Review the workflows while the PR is still unmerged. Confirm that dependencies,
`deployment-package.zip`, and `deployment-package.zip.sha256` are produced
before credentials, then uploaded as `lambda-deployment-package` for 30 days.
Missing artifact files must fail the job. Confirm all actions are pinned to full
commit SHAs and neither workflow has a `pull_request` trigger.

Once every item above has evidence, mark the PR ready for review. Keep it
unmerged if any AWS or GitHub setup remains outstanding.

## 6. Merge-triggered first deployment

Approve and merge the reviewed PR to `main`. The push starts the first deployment.
The production reviewer must compare the displayed environment variables and
commit SHA with the change record before approving the job.

The job packages and uploads the ZIP and checksum without AWS credentials. It
then verifies the run SHA is still current `main`, exchanges the GitHub OIDC
token for the role session `github-actions-lambda-deploy`, and calls the hosted
runner's AWS CLI. There is no workflow-installed AWS CLI or static-key path.

Validate the deployment and capture the workflow run URL and ID, commit SHA,
artifact name, artifact SHA-256, role ARN, region, function name, environment
approval, AWS response, and application validation evidence. Verify the Lambda
through its approved test invocation or normal event path and inspect
CloudWatch for errors.

### Exact CloudTrail checks

Find the STS event for the run and verify these exact fields:

- `eventSource` = `sts.amazonaws.com`
- `eventName` = `AssumeRoleWithWebIdentity`
- `requestParameters.roleArn` = `arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>`
- `requestParameters.roleSessionName` = `github-actions-lambda-deploy`
- `responseElements.subjectFromWebIdentityToken` =
  `repo:ciaran-finnegan/License-Plate-Recognition-Notifier:environment:production`
- `responseElements.audience` = `sts.amazonaws.com`
- `responseElements.assumedRoleUser.arn` =
  `arn:aws:sts::<AWS_ACCOUNT_ID>:assumed-role/<ROLE_NAME>/github-actions-lambda-deploy`

Find the matching Lambda management event and verify:

- `eventSource` = `lambda.amazonaws.com`
- `eventName` = `UpdateFunctionCode20150331v2`
- `requestParameters.functionName` = `<LAMBDA_FUNCTION_NAME>`
- `userIdentity.type` = `AssumedRole`
- `userIdentity.arn` =
  `arn:aws:sts::<AWS_ACCOUNT_ID>:assumed-role/<ROLE_NAME>/github-actions-lambda-deploy`
- `userIdentity.sessionContext.sessionIssuer.arn` =
  `arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ROLE_NAME>`
- `errorCode` and `errorMessage` are absent.

Correlate the two events by account, role session name, event time, and the
workflow run. Record both CloudTrail event IDs. The Lambda event must target the
reviewed function and must not identify the legacy IAM user.

Do not proceed to key retirement unless the workflow, application, artifact,
CloudWatch, and both CloudTrail checks pass.

## 7. Retire the static keys

Re-run the repository, environment, and organization secrets inventories and
compare them with the pre-merge record. Remove every legacy AWS deployment
secret from every applicable scope. Then deactivate every IAM access key for
every inventoried deployment IAM user, including any second key.

Record each secret removal and each access key ID, IAM user, deactivation time,
operator, and AWS audit event. Do not permanently delete a key yet. The
deactivated state provides a clear checkpoint for the next OIDC-only run
without allowing the old identity to authenticate.

Do not reactivate, replace, or recreate a key if revalidation fails. Correct the
OIDC/environment configuration or use the OIDC rollback workflow.

## 8. workflow_dispatch revalidation

From the current `main` branch, manually run **Deploy Python Lambda Function**
with `workflow_dispatch`. A production reviewer must approve it. The shared
concurrency group must be idle or let this run wait; do not cancel a deployment
that may already be in its AWS call.

Repeat all application, artifact, CloudWatch, and exact CloudTrail validation
from section 6. Confirm the new run succeeds while every old access key remains
deactivated and that CloudTrail again identifies
`github-actions-lambda-deploy`, not a legacy IAM user.

After revalidation passes, permanently delete every deactivated IAM access key
from every inventoried deployment user. Repeat the repository secrets,
environment secrets, and organization secrets inventories, verify no deployment
key remains, and record every key deletion event and timestamp. If a dedicated
IAM user has no other approved purpose, remove it through the normal IAM change
process after its keys are gone.

The migration is complete only after this manual run and permanent deletion
evidence pass review.

## 9. Break-glass rollback

`.github/workflows/rollback-lambda.yml` is the only GitHub Actions rollback
path. It is `workflow_dispatch` only, uses the same production environment and
OIDC role, and never restores static credentials.

1. Disable **Deploy Python Lambda Function** to prevent another automatic push
   deployment while the incident is active. Leave the rollback workflow enabled.
2. Select a successful deployment run ID from the `deploy-lambda.yml` workflow
   on `main` whose known-good `lambda-deployment-package` artifact remains
   within its 30-day retention period. Record the run URL, commit SHA, artifact
   name, and expected SHA-256.
3. Dispatch **Roll Back Python Lambda Function** from current `main`. Enter the
   successful deployment run ID as `deployment_run_id` and the artifact name as
   `artifact_name`.
4. The production reviewer compares both inputs with the incident record before
   approval. The job uses `actions: read` to verify the selected run completed
   successfully, came from `deploy-lambda.yml` on `main`, and to download that
   exact artifact.
5. The job verifies `deployment-package.zip` against
   `deployment-package.zip.sha256`, guards current `main`, and only then obtains
   OIDC credentials. Credential configuration is immediately followed by
   `UpdateFunctionCode` for the configured function and region.
6. Validate `$LATEST` through the approved invocation path and inspect
   CloudWatch. Repeat the CloudTrail checks from section 6, substituting the
   role session name `github-actions-lambda-rollback` in the STS and Lambda
   assumed-role ARN fields.
7. Record the rollback run URL, source deployment run ID, artifact digest,
   environment approval, AWS response, CloudTrail event IDs, and application
   result. Re-enable normal deployment only after the incident fix is reviewed.

If the artifact is missing, expired, has a checksum mismatch, the source run is
not successful, current `main` has changed, environment approval is denied, or
OIDC fails, stop. Investigate through the audited incident process; do not add a
static key fallback or bypass the production environment.

## Completion record

Retain the policy reviews, pre-merge readiness evidence, environment settings,
first and manual workflow run URLs, artifact checksums, CloudTrail events,
application validation, complete secret-scope inventories, access-key
deactivation and deletion records, and any rollback evidence with the change.
