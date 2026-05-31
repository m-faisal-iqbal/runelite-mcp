param(
  [switch]$RestartRuneLite,
  [switch]$BuildOnly,
  [switch]$InstallOnly,
  [int]$MaxMemoryMb = 512
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PluginRoot = Join-Path $RepoRoot "osrs-mcp-plugin"
$ServerRoot = Join-Path $RepoRoot "osrs-mcp-server"
$RuneLiteRoot = Join-Path $env:LOCALAPPDATA "RuneLite"
$RuneLiteJre = Join-Path $RuneLiteRoot "jre\bin\java.exe"
$RuneLiteConfig = Join-Path $RuneLiteRoot "config.json"
$RuneLiteRepo = Join-Path $env:USERPROFILE ".runelite\repository2"
$RuneLitePluginJar = Join-Path $env:USERPROFILE ".runelite\plugins\osrs-mcp-plugin.jar"
$ToolRoot = Join-Path $env:TEMP "codex-runelite-tools"
$EcjJar = Join-Path $ToolRoot "ecj-3.33.0.jar"
$HelperClasses = Join-Path $PluginRoot "build\runelite-dev-launcher"
$PluginClasses = Join-Path $PluginRoot "build\classes\java\main"
$PluginJar = Join-Path $PluginRoot "build\libs\osrs-mcp-plugin-1.0-SNAPSHOT.jar"
$McpServerIndex = Join-Path $ServerRoot "build\index.js"
$ApiPorts = 8080..8090

function Write-Step($message) {
  Write-Host "[osrs-mcp] $message"
}

function Get-OsrsMcpServerProcesses {
  $serverPattern = "*$McpServerIndex*"
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.ExecutablePath -eq "C:\Program Files\nodejs\node.exe" -and
      $_.CommandLine -like $serverPattern
    }
}

function Get-ApiBaseUrl {
  param(
    [switch]$RequireCurrentSchema
  )

  foreach ($apiPort in $ApiPorts) {
    $baseUrl = "http://localhost:$apiPort/api"
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/" -TimeoutSec 2
      if (-not $RequireCurrentSchema -or (($response.Content -like "*/api/snapshot*") -and ($response.Content -like "*/api/identity*"))) {
        return $baseUrl
      }
    } catch {
      # Port is closed, stale, or responding too slowly. Try the next candidate.
    }
  }

  return $null
}

function Test-Api {
  return [bool](Get-ApiBaseUrl)
}

function Test-CurrentApiSchema {
  param(
    [string]$BaseUrl
  )

  if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $BaseUrl = Get-ApiBaseUrl -RequireCurrentSchema
  }

  if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    return $false
  }

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/" -TimeoutSec 2
    return ($response.Content -like "*/api/snapshot*") -and ($response.Content -like "*/api/identity*")
  } catch {
    return $false
  }
}

function Set-RuneLiteMemory {
  if (-not (Test-Path -LiteralPath $RuneLiteConfig)) {
    return
  }

  $json = Get-Content -LiteralPath $RuneLiteConfig -Raw | ConvertFrom-Json
  $xmx = "-Xmx${MaxMemoryMb}m"
  $vmArgs = @($json.vmArgs | Where-Object { $_ -notmatch "^-Xmx" })
  $insertAt = [Math]::Min(3, $vmArgs.Count)
  $before = @()
  $after = @()
  if ($insertAt -gt 0) {
    $before = @($vmArgs[0..($insertAt - 1)])
  }
  if ($insertAt -lt $vmArgs.Count) {
    $after = @($vmArgs[$insertAt..($vmArgs.Count - 1)])
  }
  $json.vmArgs = @($before + $xmx + $after)
  $json | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $RuneLiteConfig -Encoding UTF8
}

function Ensure-Compiler {
  New-Item -ItemType Directory -Force -Path $ToolRoot | Out-Null
  if ((-not (Test-Path -LiteralPath $EcjJar)) -or ((Get-Item -LiteralPath $EcjJar).Length -lt 1000000)) {
    Write-Step "Downloading lightweight Java compiler..."
    curl.exe -L --connect-timeout 20 --max-time 180 -o $EcjJar "https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.33.0/ecj-3.33.0.jar"
  }
}

function Get-RuneLiteClasspath {
  if (-not (Test-Path -LiteralPath $RuneLiteRepo)) {
    throw "RuneLite repository cache not found: $RuneLiteRepo. Start RuneLite normally once so it downloads its jars."
  }

  (Get-ChildItem -LiteralPath $RuneLiteRepo -Filter "*.jar" | ForEach-Object { $_.FullName }) -join ";"
}

function Build-Plugin {
  Ensure-Compiler

  $classPath = Get-RuneLiteClasspath
  if (Test-Path -LiteralPath $PluginClasses) {
    Remove-Item -LiteralPath $PluginClasses -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $PluginClasses | Out-Null

  Write-Step "Compiling RuneLite plugin..."
  & $RuneLiteJre -jar $EcjJar -11 -encoding UTF-8 -cp $classPath -d $PluginClasses `
    (Join-Path $PluginRoot "src\main\java\com\osrsmcp\OsrsMcpPlugin.java") `
    (Join-Path $PluginRoot "src\main\java\com\osrsmcp\ApiServer.java") | Out-String | Write-Host

  if (Test-Path -LiteralPath $HelperClasses) {
    Remove-Item -LiteralPath $HelperClasses -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $HelperClasses | Out-Null

  Write-Step "Compiling local RuneLite dev launcher..."
  & $RuneLiteJre -jar $EcjJar -11 -encoding UTF-8 -cp "$PluginClasses;$classPath" -d $HelperClasses `
    (Join-Path $PSScriptRoot "RunOsrsMcpPlugin.java") | Out-String | Write-Host

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PluginJar) | Out-Null
  if (Test-Path -LiteralPath $PluginJar) {
    Remove-Item -LiteralPath $PluginJar -Force
  }

  Write-Step "Packaging plugin jar..."
  $zip = [System.IO.Compression.ZipFile]::Open($PluginJar, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $manifest = $zip.CreateEntry("META-INF/MANIFEST.MF")
    $writer = New-Object System.IO.StreamWriter($manifest.Open(), [System.Text.Encoding]::ASCII)
    try { $writer.Write("Manifest-Version: 1.0`r`n`r`n") } finally { $writer.Dispose() }

    $metadata = @{
      plugins = @("com.osrsmcp.OsrsMcpPlugin")
      internalName = "osrs-mcp-plugin"
      displayName = "OSRS MCP"
      version = "1.0-SNAPSHOT"
      author = "Faisal Iqbal"
      description = "Exposes a local HTTP API for the OSRS MCP server"
      tags = @("mcp", "ai", "http")
    } | ConvertTo-Json -Compress
    $metaEntry = $zip.CreateEntry("runelite_plugin.json")
    $writer = New-Object System.IO.StreamWriter($metaEntry.Open(), [System.Text.Encoding]::UTF8)
    try { $writer.Write($metadata) } finally { $writer.Dispose() }

    Get-ChildItem -LiteralPath $PluginClasses -Recurse -File | ForEach-Object {
      $entry = $_.FullName.Substring($PluginClasses.Length + 1).Replace("\", "/")
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally {
    $zip.Dispose()
  }
}

function Install-PluginJar {
  Write-Step "Installing plugin jar to $RuneLitePluginJar..."
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RuneLitePluginJar) | Out-Null
  Copy-Item -LiteralPath $PluginJar -Destination $RuneLitePluginJar -Force
  Write-Host "Plugin jar copied. Standard RuneLite may not load local development plugins from this folder on every launcher build."
  Write-Host "If it does not appear in normal RuneLite, use Start-OSRS-MCP.bat or Restart-OSRS-MCP.bat to launch the dev plugin classpath."
}

function Build-Server {
  Write-Step "Building TypeScript MCP server..."
  Push-Location $ServerRoot
  try {
    cmd /c npm run build
  } finally {
    Pop-Location
  }
}

function Stop-StaleMcpServers {
  $servers = @(Get-OsrsMcpServerProcesses)
  if ($servers.Count -gt 0) {
    Write-Step "Stopping stale standalone MCP server processes. Codex starts this stdio server from config when needed."
    $servers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  }
}

function Start-RuneLiteWithPlugin {
  $normalRuneLite = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "RuneLite.exe" })
  $devRuneLite = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match "java|javaw" -and $_.CommandLine -like "*RunOsrsMcpPlugin*" })

  if ($RestartRuneLite) {
    Write-Step "Restart requested: closing RuneLite processes so the local plugin can load..."
    $normalRuneLite | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    $devRuneLite | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
  }

  $apiBaseUrl = Get-ApiBaseUrl
  if ($apiBaseUrl -and -not $RestartRuneLite) {
    $currentApiBaseUrl = Get-ApiBaseUrl -RequireCurrentSchema
    if ($currentApiBaseUrl) {
      Write-Step "RuneLite plugin API is already available at $currentApiBaseUrl/."
    } else {
      Write-Host ""
      Write-Host "RuneLite plugin API is responding, but it looks like an older plugin build."
      Write-Host "I will NOT close it automatically. To load this new build, close RuneLite yourself,"
      Write-Host "then run Start-OSRS-MCP.bat again, or run Restart-OSRS-MCP.bat when you are ready."
      Write-Host ""
    }
    return
  }

  if (($normalRuneLite.Count -gt 0 -or $devRuneLite.Count -gt 0) -and -not $RestartRuneLite) {
    Write-Host ""
    Write-Host "RuneLite is already running, but the OSRS MCP API is not responding."
    Write-Host "I will NOT close it automatically. To load the local plugin, close RuneLite yourself,"
    Write-Host "then run Start-OSRS-MCP.bat again, or run Restart-OSRS-MCP.bat when you are ready."
    Write-Host ""
    return
  }

  $runClassPath = "$HelperClasses;$PluginClasses;$(Get-RuneLiteClasspath)"
  $javaArgs = "-ea -Xmx${MaxMemoryMb}m -Xss2m -cp `"$runClassPath`" RunOsrsMcpPlugin"
  Write-Step "Starting RuneLite with OSRS MCP plugin..."
  Start-Process -FilePath $RuneLiteJre `
    -ArgumentList $javaArgs `
    -WorkingDirectory $RuneLiteRoot `
    -WindowStyle Normal

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $currentApiBaseUrl = Get-ApiBaseUrl -RequireCurrentSchema
    if ($currentApiBaseUrl) {
      Write-Step "RuneLite API is ready: $currentApiBaseUrl/"
      return
    }
  }

  Write-Host "RuneLite was launched, but the API was not ready within 30 seconds. Check %USERPROFILE%\.runelite\logs\client.log."
}

if (-not (Test-Path -LiteralPath $RuneLiteJre)) {
  throw "RuneLite bundled Java was not found: $RuneLiteJre"
}

Set-RuneLiteMemory
Build-Plugin
Build-Server

if ($InstallOnly) {
  Install-PluginJar
} elseif (-not $BuildOnly) {
  Stop-StaleMcpServers
  Start-RuneLiteWithPlugin
}

Write-Step "Done."
