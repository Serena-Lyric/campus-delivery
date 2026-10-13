param([string]$EvidenceDirectory = 'D:\Application\ClaudeCode\backups\campus-round10b-20261013',
  [ValidatePattern('^campus_round10b_empty(?:_[a-z0-9]+)?$')][string]$EmptyDatabase = 'campus_round10b_empty')
$ErrorActionPreference = 'Stop'
$savedUrl = $env:DATABASE_URL
$snapshot = @'
\set ON_ERROR_STOP on
SET default_transaction_read_only = on;
SELECT format($sql$SELECT json_build_object('table', %L, 'rows', count(*), 'hash', md5(COALESCE(string_agg((to_jsonb(t) - ARRAY['merchantEstimatedReadyAt','merchantPreparationEstimateVersion','merchantArrivedAt','preparationControlState','preparationControlVersion','preparationControlReason','preparationControlUpdatedAt','preparationSourceExceptionId','preparationReportedAssignmentId','temporaryPersonalCapacityRelease','noFaultExitStatus','goodsChangeVersion','goodsChangeReviewPending','goodsChangeSourceExceptionId'])::text, '' ORDER BY (to_jsonb(t) - ARRAY['merchantEstimatedReadyAt','merchantPreparationEstimateVersion','merchantArrivedAt','preparationControlState','preparationControlVersion','preparationControlReason','preparationControlUpdatedAt','preparationSourceExceptionId','preparationReportedAssignmentId','temporaryPersonalCapacityRelease','noFaultExitStatus','goodsChangeVersion','goodsChangeReviewPending','goodsChangeSourceExceptionId'])::text), ''))) FROM %I.%I t;$sql$, tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename
\gexec
'@
function Snapshot([string]$Container, [string]$Database) {
  $lines = $snapshot | docker exec -i $Container psql -X -q -A -t -U campus -d $Database
  if ($LASTEXITCODE -ne 0) { throw 'Snapshot failed' }
  return @($lines | Where-Object { $_.Trim().StartsWith('{') } | Sort-Object)
}
function Check([string]$Container, [string]$Database, [int]$Port) {
  $env:DATABASE_URL = "postgresql://campus:campus@127.0.0.1:${Port}/${Database}?schema=public"
  pnpm db:migrate
  if ($LASTEXITCODE -ne 0) { throw 'Migration failed' }
  pnpm --filter @campus-delivery/api exec prisma migrate status
  if ($LASTEXITCODE -ne 0) { throw 'Migration status failed' }
  pnpm --filter @campus-delivery/api exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
  if ($LASTEXITCODE -ne 0) { throw 'Schema drift' }
}
try {
  # Only fixed, newly isolated targets. Never points at the user's application server/port.
  $before = @(Snapshot 'campus-round10b-restore' 'campus-delivery')
  Check 'campus-round10b-restore' 'campus-delivery' 55443
  $after = @(Snapshot 'campus-round10b-restore' 'campus-delivery')
  if (Compare-Object $before $after | Where-Object { $_.SideIndicator -eq '<=' }) { throw 'Historical business facts changed' }
  [ordered]@{ before=$before; after=$after; preserved=$true } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$EmptyDatabase-upgrade-history.json") -Encoding utf8
  docker exec campus-round10b-test createdb -U campus $EmptyDatabase
  if ($LASTEXITCODE -ne 0) { throw 'Fresh empty database creation failed; do not reset an existing target' }
  Check 'campus-round10b-test' $EmptyDatabase 55442
  pnpm db:seed
  if ($LASTEXITCODE -ne 0) { throw 'First Seed failed' }
  $seeded = @(Snapshot 'campus-round10b-test' $EmptyDatabase)
  pnpm db:seed
  if ($LASTEXITCODE -ne 0) { throw 'Repeated Seed failed' }
  $reseeded = @(Snapshot 'campus-round10b-test' $EmptyDatabase)
  # Seed may refresh demo profile/product presentation timestamps; it must preserve all order/fund/audit facts.
  $stable = @('Order', 'OrderItem', 'OrderPricing', 'OrderEvent', 'DeliveryTask', 'DeliveryAssignment', 'Settlement', 'RiderSettlement',
    'MerchantPreparationEstimateAudit', 'PreparationControlAudit', 'OrderChangeNotice', 'OrderChangeAcknowledgement', 'GoodsChangeAction', 'PickupHandoff', 'PickupCustodyDispute', 'CompensationObligation', 'CompensationAllocation',
    'ExceptionCase', 'ExceptionCaseAction', 'ExceptionEvent', 'RemakeProposal', 'MerchantDeliveryQuote', 'MerchantRescueContributionEvent', 'RiderTipEvent', 'SubsidyRecord')
  foreach ($table in $stable) {
    $prior = @($seeded | Where-Object { ($_ | ConvertFrom-Json).table -eq $table })
    $current = @($reseeded | Where-Object { ($_ | ConvertFrom-Json).table -eq $table })
    if (($prior -join "`n") -ne ($current -join "`n")) { throw "Seed changed historical facts: $table" }
  }
  [ordered]@{ before=$seeded; after=$reseeded; stableTables=$stable } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$EmptyDatabase-repeat-seed.json") -Encoding utf8
  Write-Output 'Isolated legacy upgrade preserved all business rows; empty deploy/status/diff and repeated Seed succeeded.'
} finally { $env:DATABASE_URL = $savedUrl }
