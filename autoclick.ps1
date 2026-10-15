# Starts the hidden autoclick (autoclick.cs) for BoomBang Launcher. No window is shown.
param([int]$ParentPid = 0, [int]$Interval = 1, [int]$Clicks = 6, [int]$StartKey = 112, [int]$StopKey = 113, [int]$SetKey = 114)
$ErrorActionPreference = 'Stop'
$src = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'autoclick.cs')
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing
[BBAutoclick]::Run($ParentPid, $Interval, $Clicks, $StartKey, $StopKey, $SetKey)
