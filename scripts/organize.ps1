param([string]$Tag=(Get-Date -Format "yyyyMMdd-HHmmss"))
if(!(Test-Path .\_backups)){ New-Item -ItemType Directory -Path .\_backups | Out-Null }
$dst = ".\_backups\HERMES_$Tag.zip"
Compress-Archive -Path .\app,.\modules,.\services,.\config,.\data\*.json*,.\logs\*.log -DestinationPath $dst -Force
Write-Host "Backup -> $dst"
