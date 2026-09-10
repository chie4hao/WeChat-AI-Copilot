# Windows integration test: uses a disposable scheduled task and dummy Node process, no real config or messages.
$ErrorActionPreference = 'Stop'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $tempBase ('copilot service test ' + [guid]::NewGuid().ToString('N'))
$fixtureService = Join-Path $fixtureRoot 'service'
$taskName = 'WeChat AI Copilot Bridge Test-' + [guid]::NewGuid().ToString('N')
$pidFile = Join-Path $fixtureRoot 'bridge.pid'
$unrelated = $null
$passed = $false

function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Read-BridgePid {
  try {
    $info = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    if ((Get-Process -Id $info.supervisor -ErrorAction SilentlyContinue) -and (Get-Process -Id $info.node -ErrorAction SilentlyContinue)) { return $info }
  } catch {}
  return $null
}
function Wait-For($predicate, $seconds, $message) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    $value = & $predicate
    if ($value) { return $value }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo
    Write-Host ("Timeout diagnostics: state={0}, result={1}, lastRun={2}" -f $task.State, $info.LastTaskResult, $info.LastRunTime)
  }
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.Name -in @('wscript.exe','powershell.exe','node.exe') -and $_.CommandLine.Contains($fixtureRoot) } |
    Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List | Out-Host
  throw $message
}

try {
  New-Item -ItemType Directory -Path $fixtureService,(Join-Path $fixtureRoot 'src'),(Join-Path $fixtureRoot 'other-app/src') | Out-Null
  Get-ChildItem (Join-Path $PSScriptRoot '../service') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $fixtureService }
  [IO.File]::WriteAllText((Join-Path $fixtureRoot 'config.yaml'), '{}')
  [IO.File]::WriteAllText((Join-Path $fixtureRoot 'src/index.js'), 'setInterval(() => {}, 1000);')
  [IO.File]::WriteAllText((Join-Path $fixtureRoot 'other-app/src/index.js'), 'setInterval(() => {}, 1000);')
  $unrelated = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $fixtureRoot 'other-app') -WindowStyle Hidden -PassThru

  & (Join-Path $fixtureService 'install_service.ps1') -TaskName $taskName
  $first = Wait-For { Read-BridgePid } 15 'Initial bridge failed to start'
  $task = Get-ScheduledTask -TaskName $taskName
  Assert ($task.State -eq 'Running') 'The scheduled task must remain Running while supervisor is alive'
  Assert ($task.Settings.RestartCount -gt 0 -and $task.Settings.RestartInterval -eq 'PT1M') 'Supervisor recovery is not configured'
  Assert ([bool]($task.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT1M' -and -not $_.Repetition.Duration })) 'Indefinite recovery trigger is missing'
  $child = Get-CimInstance Win32_Process -Filter "ProcessId=$($first.node)"
  Assert ($child.CommandLine.Contains((Join-Path $fixtureRoot 'src/index.js'))) 'Node must use an absolute entry path'
  Write-Output 'PASS: installation starts a continuously supervised task with failure recovery'

  & (Join-Path $fixtureService 'start_bridge.ps1') -TaskName $taskName
  $again = Read-BridgePid
  Assert ($again.supervisor -eq $first.supervisor -and $again.node -eq $first.node) 'Repeated start created a duplicate'
  Write-Output 'PASS: repeated start keeps the same instance'

  Stop-Process -Id $first.node -Force
  $second = Wait-For { $p = Read-BridgePid; if ($p -and $p.node -ne $first.node) { $p } } 45 'Node was not restarted by supervisor'
  Assert ($second.supervisor -eq $first.supervisor) 'Node failure should not replace the supervisor'
  Write-Output 'PASS: Node crash is recovered by the supervisor'

  Stop-Process -Id $second.supervisor -Force
  $third = Wait-For { $p = Read-BridgePid; if ($p -and $p.supervisor -ne $second.supervisor -and $p.node -ne $second.node) { $p } } 95 'Windows did not recover supervisor failure'
  Assert ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') 'Recovered task is not running'
  $entry = [regex]::Escape((Join-Path $fixtureRoot 'src/index.js'))
  $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $entry })
  Assert ($nodes.Count -eq 1) 'Supervisor recovery left duplicate Node processes'
  Write-Output 'PASS: Windows recovers supervisor failure with exactly one Node process'

  # A stale/reused PID file must never authorize killing another application.
  @{ supervisor = $PID; node = $unrelated.Id } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -Encoding ASCII
  & (Join-Path $fixtureService 'stop_bridge.ps1') -TaskName $taskName
  Wait-For {
    -not (Get-Process -Id $third.supervisor -ErrorAction SilentlyContinue) -and
    -not (Get-Process -Id $third.node -ErrorAction SilentlyContinue)
  } 10 'Stop left bridge processes alive' | Out-Null
  Assert ([bool](Get-Process -Id $unrelated.Id -ErrorAction SilentlyContinue)) 'Stop killed an unrelated src/index.js process'
  Assert ((Get-ScheduledTask -TaskName $taskName).State -eq 'Disabled') 'Intentional stop must pause periodic recovery'
  Write-Output 'PASS: stop is scoped to the project, even when the PID file is stale'

  # Wait beyond RestartInterval to ensure deliberate stop does not trigger recovery.
  $deadline = (Get-Date).AddSeconds(65)
  while ((Get-Date) -lt $deadline) {
    Assert ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') 'Deliberate stop unexpectedly restarted the task'
    Assert (-not (Test-Path -LiteralPath $pidFile)) 'Stopped bridge created a new PID file'
    Start-Sleep -Seconds 2
  }
  Write-Output 'PASS: deliberate stop remains stopped beyond the recovery interval'
  & (Join-Path $fixtureService 'start_bridge.ps1') -TaskName $taskName
  $resumed = Wait-For { Read-BridgePid } 15 'Explicit start did not resume the paused service'
  Assert ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') 'Explicit start did not re-enable the task'
  Write-Output 'PASS: explicit start resumes the paused service'
  $passed = $true
} finally {
  if (Test-Path -LiteralPath (Join-Path $fixtureService 'stop_bridge.ps1')) { & (Join-Path $fixtureService 'stop_bridge.ps1') -TaskName $taskName }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  if ($unrelated -and -not $unrelated.HasExited) { $unrelated.Kill(); $unrelated.WaitForExit() }
  if ($passed) {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    Assert ($resolvedFixture.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedFixture).StartsWith('copilot service test ')) 'Refusing cleanup outside the test directory'
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
  } else { Write-Output "Failure logs retained at: $fixtureRoot" }
}
