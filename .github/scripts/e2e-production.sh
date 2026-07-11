set -euo pipefail

document_id="e2e-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
table="cheapkb-meta-${AWS_ACCOUNT_ID}-${AWS_REGION}"
bucket="cheapkb-storage-${AWS_ACCOUNT_ID}-${AWS_REGION}"
source_key="raw/${document_id}/sample.txt"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  status=$?
  trap - EXIT
  set +e
  aws s3 rm "s3://${bucket}/${source_key}" >/dev/null
  cleanup_status=$?
  if [ "${cleanup_status}" -ne 0 ]; then
    echo "Failed to remove production E2E source" >&2
    if [ "${status}" -eq 0 ]; then status=1; fi
  fi
  exit "${status}"
}
trap cleanup EXIT

item="$(jq -nc \
  --arg pk "DOC#${document_id}" \
  --arg id "${document_id}" \
  --arg key "${source_key}" \
  --arg now "${created_at}" \
  '{pk:{S:$pk},sk:{S:"META"},entityType:{S:"Document"},documentId:{S:$id},userId:{S:"e2e-ci"},title:{S:"Production pipeline test"},sourceKey:{S:$key},mimeType:{S:"text/plain"},status:{S:"UPLOADED"},createdAt:{S:$now},updatedAt:{S:$now},gsi1pk:{S:"STATUS#UPLOADED"},gsi1sk:{S:$now},gsi2pk:{S:"USER#e2e-ci"},gsi2sk:{S:$now}}')"
aws dynamodb put-item --table-name "${table}" --item "${item}"
printf '%s\n' 'CheapKB production pipeline end-to-end verification document.' | aws s3 cp - "s3://${bucket}/${source_key}" --content-type text/plain

for attempt in $(seq 1 60); do
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
