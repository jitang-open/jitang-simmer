param(
    [string]$OutputFile = '',
    [string]$SourceConfig = '',
    [string]$ServerUrl = '',
    [string]$DashboardUrl = '',
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'

$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $installerRoot
$project = Join-Path $installerRoot 'JitangSimmerSetup\JitangSimmerSetup.csproj'
$buildRoot = Join-Path $repoRoot 'artifacts\installer-build'
$payloadRoot = Join-Path $buildRoot 'payload'
$publishRoot = Join-Path $buildRoot 'publish'
$deploymentFile = Join-Path $buildRoot 'deployment.json'
$iconFile = Join-Path $buildRoot 'JitangSimmer.ico'

if ([string]::IsNullOrWhiteSpace($OutputFile)) {
    $OutputFile = Join-Path $repoRoot 'artifacts\Jitang-Simmer-Setup-x64.exe'
}
$OutputFile = [System.IO.Path]::GetFullPath($OutputFile)

if ([string]::IsNullOrWhiteSpace($SourceConfig)) {
    $SourceConfig = Join-Path $env:APPDATA 'SimmerCollector\config.json'
}

if ([string]::IsNullOrWhiteSpace($ServerUrl) -or [string]::IsNullOrWhiteSpace($Token)) {
    if (-not (Test-Path -LiteralPath $SourceConfig)) {
        throw "采集器配置不存在：$SourceConfig"
    }
    $source = Get-Content -Raw -Encoding UTF8 -LiteralPath $SourceConfig | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($ServerUrl)) { $ServerUrl = [string]$source.ServerUrl }
    if ([string]::IsNullOrWhiteSpace($Token)) { $Token = [string]$source.Token }
}

$ServerUrl = $ServerUrl.Trim().TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($DashboardUrl)) {
    if ($ServerUrl.EndsWith('/simmer', [System.StringComparison]::OrdinalIgnoreCase)) {
        $DashboardUrl = $ServerUrl.Substring(0, $ServerUrl.Length - 7) + '/simmer-dashboard/'
    } else {
        $DashboardUrl = $ServerUrl + '/index.html'
    }
}

$serverUri = $null
$dashboardUri = $null
if (-not [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$serverUri)) {
    throw '中心服务器地址无效。'
}
if (-not [Uri]::TryCreate($DashboardUrl, [UriKind]::Absolute, [ref]$dashboardUri)) {
    throw '数据面板地址无效。'
}
if ([string]::IsNullOrWhiteSpace($Token)) {
    throw '上报 Token 不能为空。'
}

New-Item -ItemType Directory -Path $buildRoot, $payloadRoot, $publishRoot -Force | Out-Null

function New-SetupIcon([string]$Path) {
    Add-Type -AssemblyName System.Drawing
    $bitmap = [System.Drawing.Bitmap]::new(256, 256)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $rect = [System.Drawing.Rectangle]::new(0, 0, 256, 256)
        $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            $rect,
            [System.Drawing.Color]::FromArgb(36, 210, 136),
            [System.Drawing.Color]::FromArgb(76, 126, 255),
            45.0)
        try { $graphics.FillEllipse($gradient, 8, 8, 240, 240) } finally { $gradient.Dispose() }

        $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 18)
        try {
            $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $points = [System.Drawing.Point[]]@(
                [System.Drawing.Point]::new(48, 137),
                [System.Drawing.Point]::new(86, 137),
                [System.Drawing.Point]::new(108, 79),
                [System.Drawing.Point]::new(137, 181),
                [System.Drawing.Point]::new(162, 116),
                [System.Drawing.Point]::new(208, 116)
            )
            $graphics.DrawLines($pen, $points)
        } finally { $pen.Dispose() }

        $iconHandle = $bitmap.GetHicon()
        $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
        $stream = [System.IO.File]::Create($Path)
        try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

Write-Host '正在构建采集组件…'
& (Join-Path $repoRoot 'collector\build.ps1') -OutputDirectory $payloadRoot
if ($LASTEXITCODE -ne 0) { throw "采集组件构建失败：$LASTEXITCODE" }

$collectorExe = Join-Path $payloadRoot 'SimmerCollector.exe'
$scannerExe = Join-Path $payloadRoot 'simmer-token-scan.exe'
if (-not (Test-Path -LiteralPath $collectorExe) -or -not (Test-Path -LiteralPath $scannerExe)) {
    throw '采集组件不完整。'
}

New-SetupIcon $iconFile

$deployment = [ordered]@{
    ServerUrl = $ServerUrl
    DashboardUrl = $DashboardUrl
    Token = $Token
    Version = '0.10.0'
}
[System.IO.File]::WriteAllText(
    $deploymentFile,
    ($deployment | ConvertTo-Json),
    [System.Text.UTF8Encoding]::new($false))

try {
    Write-Host '正在生成单文件安装程序…'
    $publishArgs = @(
        'publish', $project,
        '-c', 'Release',
        '-r', 'win-x64',
        '--self-contained', 'true',
        '-o', $publishRoot,
        '/p:PublishSingleFile=true',
        "/p:PayloadCollector=$collectorExe",
        "/p:PayloadScanner=$scannerExe",
        "/p:DeploymentConfigFile=$deploymentFile",
        "/p:SetupIconFile=$iconFile"
    )
    & dotnet @publishArgs
    if ($LASTEXITCODE -ne 0) { throw "安装程序构建失败：$LASTEXITCODE" }
} finally {
    if (Test-Path -LiteralPath $deploymentFile) {
        Remove-Item -LiteralPath $deploymentFile -Force
    }
}

$builtSetup = Join-Path $publishRoot 'Jitang-Simmer-Setup.exe'
if (-not (Test-Path -LiteralPath $builtSetup)) {
    throw '未找到构建后的安装程序。'
}

New-Item -ItemType Directory -Path (Split-Path -Parent $OutputFile) -Force | Out-Null
Copy-Item -LiteralPath $builtSetup -Destination $OutputFile -Force

$item = Get-Item -LiteralPath $OutputFile
$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $OutputFile
Write-Host "安装包已生成：$OutputFile"
Write-Host ("大小：{0:N1} MB" -f ($item.Length / 1MB))
Write-Host "SHA256：$($hash.Hash)"
