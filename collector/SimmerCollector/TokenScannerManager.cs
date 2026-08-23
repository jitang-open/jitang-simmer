using System.Diagnostics;
using System.Text.Json;

namespace SimmerCollector;

/// <summary>
/// 协调来源发现、独立 sidecar、48 小时增量/每日全量扫描、文件监听、离线队列和批量上报。
/// 任意失败都只记录到 Token 模块，不影响前台软件时长采样。
/// </summary>
internal sealed class TokenScannerManager : IDisposable
{
    private readonly Config _config;
    private readonly TokenLocalStore _store = new();
    private readonly SemaphoreSlim _scanLock = new(1, 1);
    private readonly object _watchLock = new();
    private readonly System.Threading.Timer _scanTimer;
    private readonly System.Threading.Timer _debounceTimer;
    private List<FileSystemWatcher> _watchers = new();
    private volatile bool _paused;
    private bool _disposed;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public int PendingCount => _store.Count;

    public TokenScannerManager(Config config)
    {
        _config = config;
        _debounceTimer = new System.Threading.Timer(_ => _ = RunSafeAsync("file_changed"), null,
            Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        _scanTimer = new System.Threading.Timer(_ => _ = RunSafeAsync("scheduled"), null,
            TimeSpan.FromSeconds(3), ScanInterval());
    }

    public void SetPaused(bool paused) => _paused = paused;

    public async Task ScanNowAsync()
    {
        _scanTimer.Change(ScanInterval(), ScanInterval());
        await RunSafeAsync("manual", forceFull: true);
    }

    private TimeSpan ScanInterval() =>
        TimeSpan.FromMinutes(Math.Clamp(_config.TokenScanIntervalMinutes, 5, 24 * 60));

    private async Task RunSafeAsync(string reason, bool forceFull = false)
    {
        if (_disposed || _paused || !_config.EnableTokenStatistics) return;
        if (!await _scanLock.WaitAsync(0)) return;
        try { await ScanAndUploadAsync(reason, forceFull); }
        catch (Exception ex) { Log.Write("Token 扫描流程异常: " + ex.Message); }
        finally { _scanLock.Release(); }
    }

    private async Task ScanAndUploadAsync(string reason, bool forceFull)
    {
        var discoveries = TokenSourceDiscovery.Discover(_config);
        RefreshWatchers(discoveries);
        bool fullScan = forceFull || !_store.LastFullScan.HasValue ||
            DateTimeOffset.UtcNow - _store.LastFullScan.Value >= TimeSpan.FromHours(24) ||
            discoveries.Any(row => !_store.HasStatus(row.Source));
        var statuses = discoveries.Select(row => row.Status).ToList();
        var events = new List<TokenEvent>();
        bool scanSucceeded = false;

        string? scanner = FindScanner();
        if (scanner == null)
        {
            MarkParserFailure(statuses, discoveries, "scanner_missing");
            Log.Write("Token sidecar 未找到；已保留来源状态，软件时长采集继续运行");
        }
        else
        {
            try
            {
                TokenScanOutput output = await InvokeScannerAsync(scanner, discoveries, fullScan);
                if (output.ParserVersion != TokenProtocol.ParserVersion)
                    throw new InvalidDataException("parser_version_mismatch");
                events = output.Events.Where(row => row.IsValid()).ToList();
                scanSucceeded = true;
                Log.Write(
                    $"Token 扫描完成({reason}/{(fullScan ? "full" : "48h")})：" +
                    $"Codex {output.Diagnostics.CodexFiles} 文件，ZCode {output.Diagnostics.ZCodeDatabases} 库，" +
                    $"DSH {output.Diagnostics.DshFiles} 文件，WorkBuddy {output.Diagnostics.WorkBuddyFiles} 文件，" +
                    $"事件 {events.Count} 条");
            }
            catch (Exception ex)
            {
                MarkParserFailure(statuses, discoveries, ErrorCode(ex));
                Log.Write("Token sidecar 失败，主采集流程不受影响: " + ex.Message);
            }
        }

        _store.Merge(events, statuses, fullScan && scanSucceeded);
        await FlushQueueAsync();
    }

    private async Task FlushQueueAsync()
    {
        bool statusesSent = false;
        while (!_disposed)
        {
            var batch = _store.Peek(2000);
            var statuses = statusesSent ? new List<TokenSourceStatus>() : _store.Statuses();
            if (batch.Count == 0 && statuses.Count == 0) break;
            bool ok = await Uploader.FlushTokenAsync(_config, batch, statuses);
            if (!ok) break;
            if (batch.Count > 0) _store.Dequeue(batch);
            statusesSent = true;
            if (batch.Count == 0) break;
        }
    }

    private static async Task<TokenScanOutput> InvokeScannerAsync(
        string scanner, List<TokenDiscoveryResult> discoveries, bool fullScan)
    {
        var start = new ProcessStartInfo
        {
            FileName = scanner,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var discovery in discoveries.Where(row => row.DataRoot != null))
        {
            start.ArgumentList.Add("--" + discovery.Source + "-root");
            start.ArgumentList.Add(discovery.DataRoot!);
        }
        if (!fullScan)
        {
            start.ArgumentList.Add("--modified-since-ms");
            start.ArgumentList.Add(DateTimeOffset.UtcNow.Subtract(TimeSpan.FromHours(48)).ToUnixTimeMilliseconds().ToString());
        }

        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new InvalidOperationException("scanner_start_failed");
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw new TimeoutException("scanner_timeout");
        }
        string stdout = await stdoutTask;
        string stderr = await stderrTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException("scanner_exit_" + process.ExitCode + ":" + Truncate(stderr, 120));
        return JsonSerializer.Deserialize<TokenScanOutput>(stdout, JsonOptions)
            ?? throw new InvalidDataException("scanner_empty_result");
    }

    private void RefreshWatchers(List<TokenDiscoveryResult> discoveries)
    {
        lock (_watchLock)
        {
            foreach (var watcher in _watchers) watcher.Dispose();
            _watchers = new List<FileSystemWatcher>();
            foreach (string root in discoveries.Select(WatchRoot).OfType<string>().Where(Directory.Exists).Distinct())
            {
                try
                {
                    var watcher = new FileSystemWatcher(root)
                    {
                        IncludeSubdirectories = true,
                        NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                        EnableRaisingEvents = true,
                    };
                    FileSystemEventHandler changed = (_, _) => DebounceScan();
                    RenamedEventHandler renamed = (_, _) => DebounceScan();
                    watcher.Changed += changed;
                    watcher.Created += changed;
                    watcher.Deleted += changed;
                    watcher.Renamed += renamed;
                    watcher.Error += (_, _) => DebounceScan();
                    _watchers.Add(watcher);
                }
                catch (Exception ex) { Log.Write("Token 文件监听器创建失败: " + ex.Message); }
            }
        }
    }

    private static string? WatchRoot(TokenDiscoveryResult discovery)
    {
        if (discovery.DataRoot == null) return null;
        // WorkBuddy 的应用目录里还有频繁变化的配置、认证与 SQLite WAL；只监听逐请求日志目录。
        return discovery.Source == "workbuddy"
            ? Path.Combine(discovery.DataRoot, "projects")
            : discovery.DataRoot;
    }

    private void DebounceScan()
    {
        if (!_disposed) _debounceTimer.Change(TimeSpan.FromSeconds(5), Timeout.InfiniteTimeSpan);
    }

    private static void MarkParserFailure(
        List<TokenSourceStatus> statuses, List<TokenDiscoveryResult> discoveries, string detailCode)
    {
        foreach (var discovery in discoveries.Where(row => row.HasData))
        {
            var status = statuses.First(row => row.Source == discovery.Source);
            status.State = detailCode == "scanner_missing" ? "incompatible" : "error";
            status.DetailCode = detailCode;
            status.CheckedAt = DateTimeOffset.UtcNow.ToString("O");
        }
    }

    private static string? FindScanner()
    {
        string? configured = Environment.GetEnvironmentVariable("SIMMER_TOKEN_SCANNER");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return Path.GetFullPath(configured);

        var candidates = new List<string>
        {
            Path.Combine(AppContext.BaseDirectory, "simmer-token-scan.exe"),
        };
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        for (int level = 0; level < 7 && directory != null; level++, directory = directory.Parent)
        {
            candidates.Add(Path.Combine(directory.FullName, "SimmerTokenScan", "target", "release", "simmer-token-scan.exe"));
            candidates.Add(Path.Combine(directory.FullName, "collector", "SimmerTokenScan", "target", "release", "simmer-token-scan.exe"));
        }
        return candidates.FirstOrDefault(File.Exists);
    }

    private static string ErrorCode(Exception exception) => exception switch
    {
        TimeoutException => "scanner_timeout",
        InvalidDataException => "scanner_incompatible",
        _ => "scanner_error",
    };

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max];

    public void Dispose()
    {
        _disposed = true;
        _scanTimer.Dispose();
        _debounceTimer.Dispose();
        lock (_watchLock)
        {
            foreach (var watcher in _watchers) watcher.Dispose();
            _watchers.Clear();
        }
        // 扫描可能仍在等待 sidecar/HTTP；进程即将退出，不在这里释放信号量，
        // 避免异步 finally 在退出竞态中对已释放对象调用 Release。
    }
}
