param(
    [string]$OutputDirectory = '',
    [switch]$Portable
)

$ErrorActionPreference = 'Stop'

$collectorRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $collectorRoot
$scannerProject = Join-Path $collectorRoot 'SimmerTokenScan'
$collectorProject = Join-Path $collectorRoot 'SimmerCollector'
$runtimeRoot = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $collectorRoot
} else {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$runtimeScanner = Join-Path $runtimeRoot 'simmer-token-scan.exe'
$runtimeCollector = Join-Path $runtimeRoot 'SimmerCollector.exe'

$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
$cargo = if ($cargoCommand) { $cargoCommand.Source } else {
    $userCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path -LiteralPath $userCargo) { $userCargo }
    else { Join-Path $env:LOCALAPPDATA 'SimmerDev\cargo\bin\cargo.exe' }
}
if (-not (Test-Path -LiteralPath $cargo)) {
    throw '未找到 Cargo。请先安装 Rust，或按交接文档准备项目用 SimmerDev 工具链。'
}

$cargoArgs = @('build', '--release')
$localRustup = Join-Path $env:LOCALAPPDATA 'SimmerDev\rustup'
$localLlvm = Join-Path $env:LOCALAPPDATA 'SimmerDev\llvm-mingw\llvm-mingw-20260616-ucrt-x86_64\bin'
if (Test-Path -LiteralPath $localLlvm) {
    $env:RUSTUP_HOME = $localRustup
    $env:CARGO_HOME = Join-Path $env:LOCALAPPDATA 'SimmerDev\cargo'
    $env:Path = "$localLlvm;$env:CARGO_HOME\bin;$env:Path"
    $env:CC = 'clang'
    $env:AR = 'llvm-ar'
    $env:RUSTFLAGS = '-C target-feature=+crt-static'
    $cargoArgs = @('+stable-x86_64-pc-windows-gnullvm', 'build', '--release')
}

Push-Location $scannerProject
try { & $cargo @cargoArgs } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "Token 扫描器构建失败：$LASTEXITCODE" }

dotnet publish $collectorProject -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
if ($LASTEXITCODE -ne 0) { throw "采集器构建失败：$LASTEXITCODE" }

Copy-Item -LiteralPath (Join-Path $scannerProject 'target\release\simmer-token-scan.exe') -Destination $runtimeScanner -Force
Copy-Item -LiteralPath (Join-Path $collectorProject 'bin\Release\net8.0-windows\win-x64\publish\SimmerCollector.exe') -Destination $runtimeCollector -Force
$portableMarker = Join-Path $runtimeRoot 'portable.flag'
if ($Portable) {
    [System.IO.File]::WriteAllText($portableMarker, '')
} elseif (Test-Path -LiteralPath $portableMarker) {
    Remove-Item -LiteralPath $portableMarker -Force
}

Write-Host "构建完成：$runtimeCollector"
Write-Host "构建完成：$runtimeScanner"
if ($Portable) { Write-Host "便携数据目录：$(Join-Path $runtimeRoot 'data')" }
