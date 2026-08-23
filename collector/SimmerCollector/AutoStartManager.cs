using Microsoft.Win32;

namespace SimmerCollector;

/// <summary>
/// 当前用户级 Windows 登录自启。只管理自己的 HKCU Run 值，不需要管理员权限。
/// </summary>
internal static class AutoStartManager
{
    internal const string ValueName = "Jitang Simmer Collector";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    internal static string ExecutablePath => Path.GetFullPath(Application.ExecutablePath);
    internal static string Command => BuildCommand(ExecutablePath);

    public static void Apply(bool enabled) => Apply(enabled, ExecutablePath);

    internal static void Apply(bool enabled, string executablePath)
    {
        if (enabled)
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
                ?? throw new InvalidOperationException("autostart_registry_unavailable");
            key.SetValue(ValueName, BuildCommand(executablePath), RegistryValueKind.String);
            return;
        }

        using var existing = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        existing?.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    public static bool IsRegistered() => IsRegistered(ExecutablePath);

    internal static bool IsRegistered(string executablePath)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        return string.Equals(key?.GetValue(ValueName) as string, BuildCommand(executablePath), StringComparison.OrdinalIgnoreCase);
    }

    internal static string BuildCommand(string executablePath) => $"\"{Path.GetFullPath(executablePath)}\"";
}
