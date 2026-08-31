param([string]$Main=".\app\main.js")
Set-Location $PSScriptRoot
if(!(Test-Path "..\node_modules")){ npm ci }
if(Test-Path $Main){ npx electron $Main } else { Write-Host "main.js introuvable à $Main" -F Yellow }
