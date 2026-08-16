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

The normal workflow separates its trust boundaries. The package job has
`contents: read` only, no `id-token: write`, and no `production` environment.
It is the only job that installs dependencies or executes package install
scripts. Those install scripts cannot request a GitHub OIDC token or inherit
production environment secrets or variables.

The deploy job has `needs: package`, `environment: production`, and only
`actions: read`, `contents: read`, and `id-token: write`. It uses
`actions: read` to retrieve the package produced by the current workflow run
and `contents: read` to check current `main`. Rollback has the same three job
permissions and production environment. Neither workflow has a static
credential fallback.

Both workflows use the shared `production-lambda-deployment` concurrency group
with `cancel-in-progress: false`. A newer run waits rather than cancelling a
deployment during an AWS API call. In the normal workflow, the deploy job checks
that its workflow SHA is current `main` before it downloads the artifact, checks
the checksum, or requests OIDC. Rollback repeats its current-`main` guard after
all source-run and artifact validation and immediately before OIDC.

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

Review the workflows while the PR is still unmerged. Confirm the package job has
only `contents: read`, has no environment, and contains every dependency install
and packaging command. Confirm `deployment-package.zip` and
`deployment-package.zip.sha256` are uploaded as
`lambda-deployment-package` for 30 days and missing files fail the job. Confirm
the production deploy job depends on that package job and checks current `main`
before downloading and verifying the artifact. Confirm all actions are pinned
to full commit SHAs and neither workflow has a `pull_request` trigger.

Once every item above has evidence, mark the PR ready for review. Keep it
unmerged if any AWS or GitHub setup remains outstanding.

## 6. Merge-triggered first deployment

Approve and merge the reviewed PR to `main`. The push starts the first deployment.
The production reviewer must compare the displayed environment variables and
commit SHA with the change record before approving the job.

The package job installs dependencies, builds the ZIP and checksum, and uploads
them without the production environment or OIDC permission. After the
`needs: package` dependency succeeds, the production deploy job verifies that
`github.sha` is still current `main` before downloading
`lambda-deployment-package` from the current workflow run. It verifies the
bundled checksum, exchanges the GitHub OIDC token for the role session
`github-actions-lambda-deploy`, and immediately calls the hosted runner's AWS
CLI. There is no workflow-installed AWS CLI or static-key path.

Validate the deployment and capture the workflow run URL and ID, commit SHA,
artifact name, artifact SHA-256, role ARN, region, function name, environment
approval, AWS response, and application validation evidence. Verify the Lambda
through its approved test invocation or normal event path and inspect
CloudWatch for errors.

Once the run succeeds, open its GitHub Actions run page and record the full
40-character lowercase head commit SHA. Cross-check that value against the
linked commit on `main`. Download that run's hardcoded
`lambda-deployment-package` artifact, extract it, run
`sha256sum --check deployment-package.zip.sha256`, and then independently run
`sha256sum deployment-package.zip`. Record the resulting 64-character lowercase
SHA-256 in the deployment record with the run ID and commit SHA. These
independently recorded values become the rollback inputs; do not wait for an
incident to create them.

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
2. Select a successful deployment run ID from `deploy-lambda.yml` on `main`
   whose known-good artifact is still within its 30-day retention period. Use
   the numeric ID in the run URL as `deployment_run_id`.
3. Obtain `expected_commit_sha` from the run page's head commit SHA. It must be
   exactly 40 lowercase hexadecimal characters. Cross-check it against the
   commit link on `main` and the deployment record captured after that run.
4. Obtain `expected_sha256` from that deployment record. It must be exactly
   64 lowercase hexadecimal characters. Download the prior run's artifact from the
   GitHub Actions run page, verify its bundled checksum, and independently
   compute the ZIP digest. Cross-check the computed digest against the recorded
   SHA-256 before dispatch.
5. Dispatch **Roll Back Python Lambda Function** from current `main` with
   `deployment_run_id`, `expected_commit_sha`, and `expected_sha256`. The
   artifact name is hardcoded as `lambda-deployment-package`; the operator
   cannot select an arbitrary artifact name.
6. The production reviewer compares all three inputs with the prior run and
   deployment record before approval. The job validates their exact forms,
   verifies that the source is a successful `deploy-lambda.yml` run on `main`,
   and requires its `head_sha` to equal `expected_commit_sha`.
7. The job downloads the hardcoded artifact, verifies the bundled checksum,
   then independently compares the computed digest to `expected_sha256`. It
   rejects either mismatch before the current-`main` guard or OIDC.
8. After the current-`main` guard, credential configuration is immediately
   followed by `UpdateFunctionCode` for the configured function and region.
9. Validate `$LATEST` through the approved invocation path and inspect
   CloudWatch. Repeat the CloudTrail checks from section 6, substituting the
   role session name `github-actions-lambda-rollback` in the STS and Lambda
   assumed-role ARN fields.
10. Record the rollback run URL, source deployment run ID, artifact digest,
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
