set -euo pipefail

export AWS_PROFILE="954475336309"

document_id="e2e-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
table="cheapkb-meta-${AWS_ACCOUNT_ID}-${AWS_REGION}"
bucket="cheapkb-storage-${AWS_ACCOUNT_ID}-${AWS_REGION}"
source_key="raw/${document_id}/sample.txt"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  status=$?
  trap - EXIT
  set +e
  verify_aws_account
  aws s3 rm "s3://${bucket}/${source_key}" >/dev/null
  cleanup_status=$?
  if [ "${cleanup_status}" -ne 0 ]; then
    echo "Failed to remove production E2E source" >&2
    if [ "${status}" -eq 0 ]; then status=1; fi
  fi
  exit "${status}"
}

verify_aws_account() {
  account="$(aws sts get-caller-identity --query Account --output text)"
  if [ "${account}" != "954475336309" ]; then
    echo "AWS account mismatch: ${account}" >&2
    exit 1
  fi
}

# Drives the real retag code against the real vector index. Mocked unit tests
# cannot prove that PutVectors upserts by key and replaces metadata wholesale,
# and getting that wrong silently strips userId from vectors, which hides the
# document from its owner's search rather than raising an error.
verify_retag() {
  echo "Verifying document retag against the production vector index"
  E2E_DOCUMENT_ID="${document_id}" \
  E2E_TABLE_NAME="${table}" \
  E2E_VECTOR_BUCKET="cheapkb-vecs-${AWS_ACCOUNT_ID}-${AWS_REGION}" \
  E2E_VECTOR_INDEX="default" \
    node --experimental-strip-types .github/scripts/verify-retag.ts
}

# A successful deploy does not prove the endpoint is reachable from the browser:
# a missing PATCH entry in the CORS allowlist fails only at preflight, in the
# user's browser, long after CI has gone green.
verify_patch_route() {
  api_id="$(aws apigatewayv2 get-apis \
    --query "Items[?Name=='cheapkb-api-${AWS_ACCOUNT_ID}-${AWS_REGION}'].ApiId | [0]" \
    --output text)"
  if [ "${api_id}" = "None" ] || [ -z "${api_id}" ]; then
    echo "Could not find the deployed API" >&2
    exit 1
  fi

  routes="$(aws apigatewayv2 get-routes --api-id "${api_id}" \
    --query 'Items[].RouteKey' --output text)"
  case "${routes}" in
    *"PATCH /documents/{id}"*) echo "ok: PATCH /documents/{id} route deployed" ;;
    *) echo "FAIL: PATCH /documents/{id} route is missing" >&2; exit 1 ;;
  esac

  cors_methods="$(aws apigatewayv2 get-api --api-id "${api_id}" \
    --query 'CorsConfiguration.AllowMethods' --output text)"
  case "${cors_methods}" in
    *PATCH*) echo "ok: CORS allows PATCH" ;;
    *) echo "FAIL: CORS does not allow PATCH (got ${cors_methods})" >&2; exit 1 ;;
  esac
}

trap cleanup EXIT

verify_aws_account
verify_patch_route

item="$(jq -nc \
  --arg pk "DOC#${document_id}" \
  --arg id "${document_id}" \
  --arg key "${source_key}" \
  --arg now "${created_at}" \
  '{pk:{S:$pk},sk:{S:"META"},entityType:{S:"Document"},documentId:{S:$id},userId:{S:"e2e-ci"},title:{S:"Production pipeline test"},sourceKey:{S:$key},mimeType:{S:"text/plain"},status:{S:"UPLOADED"},createdAt:{S:$now},updatedAt:{S:$now},gsi1pk:{S:"STATUS#UPLOADED"},gsi1sk:{S:$now},gsi2pk:{S:"USER#e2e-ci"},gsi2sk:{S:$now}}')"
verify_aws_account
aws dynamodb put-item --table-name "${table}" --item "${item}"
verify_aws_account
printf '%s\n' 'CheapKB production pipeline end-to-end verification document.' | aws s3 cp - "s3://${bucket}/${source_key}" --content-type text/plain

for attempt in $(seq 1 60); do
  verify_aws_account
  document="$(aws dynamodb get-item \
    --table-name "${table}" \
    --key "{\"pk\":{\"S\":\"DOC#${document_id}\"},\"sk\":{\"S\":\"META\"}}" \
    --consistent-read \
    --output json)"
  status="$(jq -r '.Item.status.S // "MISSING"' <<<"${document}")"
  error="$(jq -r '.Item.lastError.S // empty' <<<"${document}")"
  echo "Pipeline status: ${status}"
  if [ "${status}" = "EMBEDDED" ]; then
    chunks="$(jq -r '.Item.chunkCount.N // "0"' <<<"${document}")"
    embedded="$(jq -r '.Item.embeddedCount.N // "0"' <<<"${document}")"
    test "${chunks}" -gt 0
    test "${embedded}" -eq "${chunks}"
    verify_aws_account
    verify_retag
    exit 0
  fi
  if [ "${status}" = "FAILED" ]; then
    echo "Pipeline failed: ${error}"
    exit 1
  fi
  sleep 5
done

echo "Pipeline timed out before reaching EMBEDDED"
exit 1
