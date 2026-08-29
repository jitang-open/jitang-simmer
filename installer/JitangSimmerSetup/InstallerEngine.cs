using Microsoft.Win32;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace JitangSimmerSetup;

internal sealed record InstallRequest(
    string InstallDirectory,
    string ConfigDirectory,
    bool EnableAutoStart,
    bool CreateShortcuts,
    bool RegisterUninstaller,
    bool StopRunningCollectors,
    bool StartAfterInstall,
    bool OpenDashboardAfterInstall);

internal static class InstallerPaths
{
    public const string ProductName = "Jitang Simmer";
    public const string CollectorFileName = "SimmerCollector.exe";
    public const string ScannerFileName = "simmer-token-scan.exe";
    public const string SetupFileName = "Jitang-Simmer-Setup.exe";
    public const string AutoStartValueName = "Jitang Simmer Collector";

    public static string InstallDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs", ProductName);

    public static string ConfigDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "SimmerCollector");

    public static string StartMenuDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Microsoft", "Windows", "Start Menu", "Programs", ProductName);

    public static string DesktopShortcut { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
        ProductName + ".lnk");
}

internal static class InstallerEngine
{
    private const string CollectorResource = "JitangSimmerSetup.payload.SimmerCollector.exe";
    private const string ScannerResource = "JitangSimmerSetup.payload.simmer-token-scan.exe";
    private const string UninstallKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\JitangSimmer";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static void Install(DeploymentConfig deployment, InstallRequest request, Action<string>? progress = null)
    {
        string installDir = Path.GetFullPath(request.InstallDirectory);
        string configDir = Path.GetFullPath(request.ConfigDirectory);
        ValidateInstallTarget(installDir);
        ValidateConfigTarget(configDir);

        progress?.Invoke("正在准备安装…");
        if (request.StopRunningCollectors) StopCollectors();
        Directory.CreateDirectory(installDir);

        progress?.Invoke("正在安装采集器…");
        ExtractResource(CollectorResource, Path.Combine(installDir, InstallerPaths.CollectorFileName));
        ExtractResource(ScannerResource, Path.Combine(installDir, InstallerPaths.ScannerFileName));
        CopySetupExecutable(Path.Combine(installDir, InstallerPaths.SetupFileName));

        progress?.Invoke("正在配置云端连接…");
        WriteCollectorConfig(configDir, deployment, request.EnableAutoStart);

        if (request.EnableAutoStart)
            SetAutoStart(Path.Combine(installDir, InstallerPaths.CollectorFileName));
        else
            RemoveAutoStart();

        if (request.RegisterUninstaller)
            RegisterUninstaller(installDir, deployment.Version);

        if (request.CreateShortcuts)
        {
            progress?.Invoke("正在创建快捷方式…");
            CreateShortcuts(installDir);
        }

        progress?.Invoke("正在完成安装…");
        if (request.StartAfterInstall)
            StartCollector(Path.Combine(installDir, InstallerPaths.CollectorFileName));
        if (request.OpenDashboardAfterInstall)
            OpenDashboard(deployment.DashboardUrl);
    }

    public static void StartCollectorIfInstalled()
    {
        string collector = Path.Combine(InstallerPaths.InstallDirectory, InstallerPaths.CollectorFileName);
        if (!File.Exists(collector)) return;
        if (Process.GetProcessesByName("SimmerCollector").Length > 0) return;
        StartCollector(collector);
    }

    public static void OpenDashboard(string dashboardUrl)
    {
        Process.Start(new ProcessStartInfo(dashboardUrl) { UseShellExecute = true });
    }

    public static void BeginUninstall(bool removeData)
    {
        string installDir = Path.GetFullPath(InstallerPaths.InstallDirectory);
        string configDir = Path.GetFullPath(InstallerPaths.ConfigDirectory);
        ValidateDefaultUninstallTargets(installDir, configDir);

        StopCollectors();
        RemoveAutoStart();
        RemoveUninstallRegistration();
        RemoveShortcuts();

        string currentExecutable = Environment.ProcessPath
            ?? throw new InvalidOperationException("无法定位卸载程序。");
        string helper = Path.Combine(Path.GetTempPath(), $"Jitang-Simmer-Cleanup-{Guid.NewGuid():N}.exe");
        File.Copy(currentExecutable, helper, overwrite: true);

        var start = new ProcessStartInfo(helper)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        start.ArgumentList.Add("--cleanup");
        start.ArgumentList.Add("--parent");
        start.ArgumentList.Add(Environment.ProcessId.ToString());
        start.ArgumentList.Add("--install-dir");
        start.ArgumentList.Add(installDir);
        start.ArgumentList.Add("--config-dir");
        start.ArgumentList.Add(configDir);
        if (removeData) start.ArgumentList.Add("--remove-data");
        Process.Start(start);
    }

    public static void FinishUninstall(int parentId, string installDir, string configDir, bool removeData)
    {
        installDir = Path.GetFullPath(installDir);
        configDir = Path.GetFullPath(configDir);
        ValidateDefaultUninstallTargets(installDir, configDir);

        if (parentId > 0)
        {
            try
            {
                using Process parent = Process.GetProcessById(parentId);
                parent.WaitForExit();
            }
            catch (ArgumentException) { }
        }

        DeleteDirectoryWithRetries(installDir);
        if (removeData) DeleteDirectoryWithRetries(configDir);
        ScheduleSelfDelete();
    }

    private static void ExtractResource(string resourceName, string destination)
    {
        using Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"安装包缺少组件：{Path.GetFileName(destination)}");
        WriteStreamAtomically(input, destination);
    }

    private static void CopySetupExecutable(string destination)
    {
        string source = Environment.ProcessPath
            ?? throw new InvalidOperationException("无法定位安装程序。");

        if (string.Equals(Path.GetFullPath(source), Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase))
            return;

        using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read);
        WriteStreamAtomically(input, destination);
    }

    private static void WriteStreamAtomically(Stream input, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        string temporary = destination + ".new-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                input.CopyTo(output);
                output.Flush(flushToDisk: true);
            }
            File.Move(temporary, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static void WriteCollectorConfig(string configDir, DeploymentConfig deployment, bool enableAutoStart)
    {
        Directory.CreateDirectory(configDir);
        string path = Path.Combine(configDir, "config.json");
        JsonObject config = new();

        if (File.Exists(path))
        {
            string json = File.ReadAllText(path, Encoding.UTF8);
            config = JsonNode.Parse(json)?.AsObject()
                ?? throw new InvalidOperationException("现有采集器配置无法读取，请先备份或修复 config.json。");
        }

        string deviceId = GetString(config, "DeviceId");
        if (string.IsNullOrWhiteSpace(deviceId))
            deviceId = Guid.NewGuid().ToString("N")[..12];

        string deviceName = GetString(config, "DeviceName");
        if (string.IsNullOrWhiteSpace(deviceName))
            deviceName = Environment.MachineName;

        config["DeviceId"] = deviceId;
        config["DeviceName"] = deviceName;
        config["ServerUrl"] = deployment.ServerUrl.TrimEnd('/');
        config["Token"] = deployment.Token;
        config["IdleThresholdMinutes"] ??= 5;
        config["UploadIntervalMinutes"] ??= 5;
        config["StartWithWindows"] = enableAutoStart;
        config["EnableHardwareMonitoring"] ??= true;
        config["EnableTokenStatistics"] ??= true;
        config["TokenScanIntervalMinutes"] ??= 15;
        config["CodexHome"] ??= "";
        config["ZCodeHome"] ??= "";
        config["DshHome"] ??= "";
        config["WorkBuddyHome"] ??= "";

        string temporary = path + ".new-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, config.ToJsonString(new JsonSerializerOptions
            {
                WriteIndented = true,
            }), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static string GetString(JsonObject config, string propertyName)
    {
        try { return config[propertyName]?.GetValue<string>() ?? ""; }
        catch (InvalidOperationException) { return ""; }
    }

    private static void RegisterUninstaller(string installDir, string version)
    {
        string setup = Path.Combine(installDir, InstallerPaths.SetupFileName);
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKeyPath, writable: true)
            ?? throw new InvalidOperationException("无法注册卸载入口。");
        key.SetValue("DisplayName", InstallerPaths.ProductName);
        key.SetValue("DisplayVersion", version);
        key.SetValue("Publisher", "Jitang");
        key.SetValue("InstallLocation", installDir);
        key.SetValue("DisplayIcon", setup);
        key.SetValue("UninstallString", $"\"{setup}\" --uninstall");
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
    }

    private static void RemoveUninstallRegistration()
    {
        using RegistryKey? root = Registry.CurrentUser.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Uninstall", writable: true);
        root?.DeleteSubKeyTree("JitangSimmer", throwOnMissingSubKey: false);
    }

    private static void SetAutoStart(string collectorPath)
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
            ?? throw new InvalidOperationException("无法设置登录自启动。");
        key.SetValue(InstallerPaths.AutoStartValueName, $"\"{collectorPath}\"", RegistryValueKind.String);
    }

    private static void RemoveAutoStart()
    {
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        key?.DeleteValue(InstallerPaths.AutoStartValueName, throwOnMissingValue: false);
    }

    private static void CreateShortcuts(string installDir)
    {
        Directory.CreateDirectory(InstallerPaths.StartMenuDirectory);
        string setup = Path.Combine(installDir, InstallerPaths.SetupFileName);
        string collector = Path.Combine(installDir, InstallerPaths.CollectorFileName);

        CreateShellShortcut(
            Path.Combine(InstallerPaths.StartMenuDirectory, "Jitang Simmer 采集器.lnk"),
            collector, "", installDir, collector);
        CreateShellShortcut(
            Path.Combine(InstallerPaths.StartMenuDirectory, "Jitang Simmer 数据面板.lnk"),
            setup, "--open-dashboard", installDir, setup);
        CreateShellShortcut(
            Path.Combine(InstallerPaths.StartMenuDirectory, "卸载 Jitang Simmer.lnk"),
            setup, "--uninstall", installDir, setup);
        CreateShellShortcut(
            InstallerPaths.DesktopShortcut,
            setup, "--open-dashboard", installDir, setup);
    }

    private static void CreateShellShortcut(string shortcutPath, string target, string arguments, string workingDirectory, string icon)
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("Windows 快捷方式服务不可用。");
        dynamic shell = Activator.CreateInstance(shellType)
            ?? throw new InvalidOperationException("无法创建 Windows 快捷方式。");
        dynamic shortcut = shell.CreateShortcut(shortcutPath);
        shortcut.TargetPath = target;
        shortcut.Arguments = arguments;
        shortcut.WorkingDirectory = workingDirectory;
        shortcut.IconLocation = icon + ",0";
        shortcut.Description = InstallerPaths.ProductName;
        shortcut.Save();
    }

    private static void RemoveShortcuts()
    {
        string startMenu = Path.GetFullPath(InstallerPaths.StartMenuDirectory);
        string expectedStartMenu = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Microsoft", "Windows", "Start Menu", "Programs", InstallerPaths.ProductName);
        if (string.Equals(startMenu, Path.GetFullPath(expectedStartMenu), StringComparison.OrdinalIgnoreCase)
            && Directory.Exists(startMenu))
        {
            Directory.Delete(startMenu, recursive: true);
        }

        if (File.Exists(InstallerPaths.DesktopShortcut))
            File.Delete(InstallerPaths.DesktopShortcut);
    }

    private static void StartCollector(string collectorPath)
    {
        Process.Start(new ProcessStartInfo(collectorPath)
        {
            UseShellExecute = true,
            WorkingDirectory = Path.GetDirectoryName(collectorPath),
        });
    }

    private static void StopCollectors()
    {
        foreach (Process process in Process.GetProcessesByName("SimmerCollector"))
        {
            using (process)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5_000);
                }
                catch (InvalidOperationException) { }
            }
        }
    }

    private static void DeleteDirectoryWithRetries(string path)
    {
        if (!Directory.Exists(path)) return;
        for (int attempt = 0; attempt < 20; attempt++)
        {
            try
            {
                Directory.Delete(path, recursive: true);
                return;
            }
            catch (IOException) when (attempt < 19) { Thread.Sleep(250); }
            catch (UnauthorizedAccessException) when (attempt < 19) { Thread.Sleep(250); }
        }
    }

    private static void ScheduleSelfDelete()
    {
        string current = Environment.ProcessPath ?? "";
        if (string.IsNullOrWhiteSpace(current)) return;

        var start = new ProcessStartInfo("cmd.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        start.ArgumentList.Add("/d");
        start.ArgumentList.Add("/c");
        start.ArgumentList.Add($"ping 127.0.0.1 -n 2 > nul & del /f /q \"{current}\"");
        Process.Start(start);
    }

    private static void ValidateInstallTarget(string path)
    {
        string root = Path.GetPathRoot(path) ?? "";
        if (string.Equals(path.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("安装目录不能是磁盘根目录。");
    }

    private static void ValidateConfigTarget(string path)
    {
        string root = Path.GetPathRoot(path) ?? "";
        if (string.Equals(path.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("配置目录不能是磁盘根目录。");
    }

    private static void ValidateDefaultUninstallTargets(string installDir, string configDir)
    {
        if (!string.Equals(installDir, Path.GetFullPath(InstallerPaths.InstallDirectory), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("拒绝卸载未知安装目录。");
        if (!string.Equals(configDir, Path.GetFullPath(InstallerPaths.ConfigDirectory), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("拒绝清理未知配置目录。");
    }
}
