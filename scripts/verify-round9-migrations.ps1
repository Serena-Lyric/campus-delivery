param(
  [ValidateSet('A', 'B', 'C')][string]$Stage,
  [switch]$SnapshotOnly,
  [switch]$FromRound8,
  [string[]]$Databases = @('campus-delivery', 'campus_round9_old', 'campus_round9_empty'),
  [string]$EvidenceDirectory = (Join-Path $env:LOCALAPPDATA 'Codex/backups/campus-delivery-round9-20261012')
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$savedDatabaseUrl = $env:DATABASE_URL
$snapshotSql = @'
CREATE TEMP TABLE round9_snapshot (name text, rows bigint, fingerprint text);
DO $$ DECLARE r record; projection text; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename <> '_prisma_migrations' ORDER BY tablename LOOP
    projection := CASE r.tablename
      WHEN 'Merchant' THEN 'to_jsonb(t) - ''dailyConfirmationEnabled'' - ''dailyConfirmationVersion'' - ''dailyConfirmationEffectiveAt'''
      ELSE 'to_jsonb(t)' END;
    EXECUTE format('INSERT INTO round9_snapshot SELECT %L, count(*), md5(COALESCE(string_agg((%s)::text, E''\n'' ORDER BY (%s)::text), '''')) FROM %I t', r.tablename, projection, projection, r.tablename);
  END LOOP;
END $$;
SELECT name || '|' || rows || '|' || fingerprint FROM round9_snapshot ORDER BY name;
'@
if ($Stage -ne 'A' -and !$FromRound8) {
  $snapshotSql = $snapshotSql.Replace(" - ''dailyConfirmationEnabled'' - ''dailyConfirmationVersion'' - ''dailyConfirmationEffectiveAt''", '')
}
function Read-HistorySnapshot([string]$Database) {
  $result = $snapshotSql | docker exec -i campus-round9-postgres psql -X -q -A -t -U campus -d $Database -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "Snapshot failed: $Database" }
  return @($result)
}
Push-Location $repoRoot
try {
  New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
  foreach ($database in $Databases) {
    if ($database -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid database name' }
    $before = Read-HistorySnapshot $database
    if ($SnapshotOnly) {
      [ordered]@{ stage = $Stage; database = $database; after = $before } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$Stage-$database-history.json") -Encoding utf8
      Write-Output "Snapshot saved: $database"
      continue
    }
    $env:DATABASE_URL = "postgresql://campus:campus@127.0.0.1:55439/${database}?schema=public"
    pnpm db:migrate
    if ($LASTEXITCODE -ne 0) { throw "Migration failed: $database" }
    pnpm --filter @campus-delivery/api exec prisma migrate status
    if ($LASTEXITCODE -ne 0) { throw "Migration status failed: $database" }
    pnpm --filter @campus-delivery/api exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
    if ($LASTEXITCODE -ne 0) { throw "Schema drift: $database" }
    $after = Read-HistorySnapshot $database
    # Compare every pre-existing table, including original merchant/product fields and all audits.
    foreach ($row in $before) {
      if ($row -notin $after) { throw "Historical facts changed: $database, $row" }
    }
    [ordered]@{ stage = $Stage; database = $database; before = $before; after = $after; preserved = $true } |
      ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$Stage-$database-history.json") -Encoding utf8
    Write-Output "Verified $database stage $Stage : historical rows unchanged; migration status and schema drift clean."
  }
} finally {
  $env:DATABASE_URL = $savedDatabaseUrl
  Pop-Location
}
