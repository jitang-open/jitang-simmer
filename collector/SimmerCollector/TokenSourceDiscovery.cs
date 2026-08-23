using System.Diagnostics;
using Microsoft.Win32;

namespace SimmerCollector;

/// <summary>
/// 有界的 AI 工具来源发现：只检查手动路径、环境变量、用户默认目录、PATH、注册表和开始菜单，
/// 不递归扫描磁盘。程序位置只在本机用于判断状态，永不进入上报对象。
/// </summary>
internal static class TokenSourceDiscovery
{
    public static List<TokenDiscoveryResult> Discover(Config config)
    {
        return
        [
            DiscoverOne(
                "codex",
                ResolveRoot(config.CodexHome, "CODEX_HOME", ".codex"),
                root => HasFiles(root, ["sessions", "archived_sessions"], "*.jsonl"),
                ["codex"], ["Codex"]),
            DiscoverOne(
                "zcode",
                ResolveRoot(config.ZCodeHome, null, ".zcode"),
                root => File.Exists(Path.Combine(root, "cli", "db", "db.sqlite")),
                ["zcode"], ["ZCode"]),
            DiscoverOne(
                "dsh",
                ResolveRoot(config.DshHome, "DSH_HOME", ".dsh"),
                root => HasFiles(root, ["sessions"], "session.jsonl*") ,
                ["dsh", "deepseek-harness"], ["DeepSeek Harness", "DSH"],
                HasDshNpxPackage),
            DiscoverOne(
                "workbuddy",
                ResolveRoot(config.WorkBuddyHome, "WORKBUDDY_HOME", ".workbuddy"),
                root => HasFiles(root, ["projects"], "*.jsonl"),
                ["workbuddy"], ["WorkBuddy"]),
        ];
    }

    private static TokenDiscoveryResult DiscoverOne(
        string source,
        string root,
        Func<string, bool> dataProbe,
        string[] executableNames,
        string[] displayNames,
        Func<string, bool>? extraExecutableProbe = null)
    {
        bool hasData;
        try { hasData = dataProbe(root); }
        catch (Exception ex)
        {
            return Result(source, root, false, false, "error", "data_probe_failed_" + SafeErrorCode(ex));
        }

        bool hasExecutable;
        try { hasExecutable = HasExecutable(executableNames, displayNames) || extraExecutableProbe?.Invoke(root) == true; }
        catch { hasExecutable = false; }

        string state;
        string detail;
        if (hasData && hasExecutable) { state = "ready"; detail = "data_and_app"; }
        else if (hasData) { state = "history_only"; detail = "data_only"; }
        else if (hasExecutable) { state = "installed_no_data"; detail = "app_only"; }
        else { state = "not_found"; detail = "no_data_or_app"; }
        return Result(source, root, hasData, hasExecutable, state, detail);
    }

    private static TokenDiscoveryResult Result(
        string source, string root, bool hasData, bool hasExecutable, string state, string detail)
    {
        return new TokenDiscoveryResult(source, root, hasData, hasExecutable, new TokenSourceStatus
        {
            Source = source,
            State = state,
            DetailCode = detail,
            CheckedAt = DateTimeOffset.UtcNow.ToString("O"),
            ParserVersion = TokenProtocol.ParserVersion,
        });
    }

    private static string ResolveRoot(string manual, string? environmentName, string defaultFolder)
    {
        string? selected = string.IsNullOrWhiteSpace(manual) ? null : manual.Trim();
        if (selected == null && environmentName != null)
            selected = Environment.GetEnvironmentVariable(environmentName);
        selected = string.IsNullOrWhiteSpace(selected)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), defaultFolder)
            : Environment.ExpandEnvironmentVariables(selected.Trim());
        return Path.GetFullPath(selected);
    }

    private static bool HasFiles(string root, string[] subdirectories, string pattern)
    {
        foreach (string subdirectory in subdirectories)
        {
            string directory = Path.Combine(root, subdirectory);
            if (!Directory.Exists(directory)) continue;
            try
            {
                if (Directory.EnumerateFiles(directory, pattern, SearchOption.AllDirectories).Any()) return true;
            }
            catch (UnauthorizedAccessException) { /* 继续检查其他有界候选 */ }
            catch (IOException) { /* 正在写入或临时不可读，继续 */ }
        }
        return false;
    }

    private static bool HasExecutable(string[] names, string[] displayNames)
    {
        if (IsRunning(names) || IsOnPath(names) || IsInAppPaths(names) ||
            IsInUninstallRegistry(displayNames) || HasStartMenuShortcut(displayNames)) return true;

        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        foreach (string displayName in displayNames)
        {
            foreach (string root in new[] { local, programFiles, programFilesX86 })
            {
                if (string.IsNullOrEmpty(root)) continue;
                foreach (string candidate in new[]
                {
                    Path.Combine(root, displayName, displayName + ".exe"),
                    Path.Combine(root, "Programs", displayName, displayName + ".exe"),
                })
                    if (File.Exists(candidate)) return true;
            }
        }
        return false;
    }

    /// <summary>
    /// DSH 常通过 npx 启动，进程名因此是 node.exe，PATH 中也没有 dsh.cmd。
    /// 这里只检查 npm 的固定、有界安装位置，不递归扫描用户磁盘。
    /// </summary>
    private static bool HasDshNpxPackage(string _)
    {
        string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (File.Exists(Path.Combine(roaming, "npm", "node_modules", "@deepseek-ai", "dsh", "package.json")))
            return true;

        string npxRoot = Path.Combine(local, "npm-cache", "_npx");
        if (!Directory.Exists(npxRoot)) return false;
        try
        {
            return Directory.EnumerateDirectories(npxRoot)
                .Any(directory => File.Exists(Path.Combine(
                    directory, "node_modules", "@deepseek-ai", "dsh", "package.json")));
        }
        catch (UnauthorizedAccessException) { return false; }
        catch (IOException) { return false; }
    }

    private static bool IsRunning(string[] names)
    {
        var wanted = names.Select(name => Path.GetFileNameWithoutExtension(name)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var process in Process.GetProcesses())
        {
            try { if (wanted.Contains(process.ProcessName)) return true; }
            catch { /* 部分系统进程不可读取 */ }
            finally { process.Dispose(); }
        }
        return false;
    }

    private static bool IsOnPath(string[] names)
    {
        string[] extensions = ["", ".exe", ".cmd", ".bat"];
        foreach (string rawDirectory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            string directory = rawDirectory.Trim().Trim('"');
            if (directory.Length == 0) continue;
            foreach (string name in names)
                foreach (string extension in extensions)
                    if (File.Exists(Path.Combine(directory, name + extension))) return true;
        }
        return false;
    }

    private static bool IsInAppPaths(string[] names)
    {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(hive, view);
                foreach (string name in names)
                {
                    using var key = baseKey.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\App Paths\{name}.exe");
                    if (key?.GetValue(null) is string value && File.Exists(value.Trim('"'))) return true;
                }
            }
            catch { /* 该注册表视图不可用 */ }
        }
        return false;
    }

    private static bool IsInUninstallRegistry(string[] displayNames)
    {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(hive, view);
                using var uninstall = baseKey.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall");
                if (uninstall == null) continue;
                foreach (string subkeyName in uninstall.GetSubKeyNames())
                {
                    using var app = uninstall.OpenSubKey(subkeyName);
                    string display = app?.GetValue("DisplayName") as string ?? "";
                    if (displayNames.Any(name => display.Contains(name, StringComparison.OrdinalIgnoreCase))) return true;
                }
            }
            catch { /* 继续其他视图 */ }
        }
        return false;
    }

    private static bool HasStartMenuShortcut(string[] displayNames)
    {
        foreach (string root in new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
        })
        {
            if (!Directory.Exists(root)) continue;
            try
            {
                if (Directory.EnumerateFiles(root, "*.lnk", SearchOption.AllDirectories)
                    .Select(Path.GetFileNameWithoutExtension)
                    .Any(file => file != null && displayNames.Any(name => file.Contains(name, StringComparison.OrdinalIgnoreCase))))
                    return true;
            }
            catch { /* 开始菜单不可读时忽略 */ }
        }
        return false;
    }

    private static string SafeErrorCode(Exception ex) => ex switch
    {
        UnauthorizedAccessException => "access_denied",
        IOException => "io",
        _ => "unknown",
    };
}
