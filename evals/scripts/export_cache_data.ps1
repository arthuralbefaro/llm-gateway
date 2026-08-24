<#
.SYNOPSIS
Exports Request and CacheEntry to csv so the cache value analysis is reproducible.

.DESCRIPTION
Python reads the csv and never connects to the database, which keeps the
analysis runnable from a checkout without postgres and adds no driver
dependency. Run it from the repo root with the stack up.

    .\evals\scripts\export_cache_data.ps1
#>

[CmdletBinding()]
param(
    [string]$Container = 'llm-gateway-postgres-1',
    [string]$User = 'gateway',
    [string]$Database = 'gateway',
    [string]$SqlDir = 'evals/sql',
    [string]$OutDir = 'evals/data'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $OutDir)) {
    throw "output directory $OutDir does not exist"
}

# the queries live in files and reach psql through stdin because windows
# powershell strips the double quotes that postgres needs around camelCase
# identifiers when they are passed as native command arguments
foreach ($query in Get-ChildItem -Path $SqlDir -Filter '*.sql') {
    $target = Join-Path $OutDir ($query.BaseName + '.csv')
    $lines = Get-Content $query.FullName -Raw |
        docker exec -i $Container psql -U $User -d $Database --csv -q

    if ($null -eq $lines) {
        throw "no rows returned for $($query.Name)"
    }

    # windows powershell writes a bom with -Encoding utf8, and a bom breaks the
    # csv header for anything that reads the first field by name
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines(
        (Join-Path (Get-Location) $target), $lines, $utf8)

    Write-Output "$target  $($lines.Count - 1) rows"
}
