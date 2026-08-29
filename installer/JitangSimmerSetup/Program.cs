namespace JitangSimmerSetup;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        try
        {
            if (CommandLine.TryRun(args)) return;
            Application.Run(new InstallerForm(DeploymentConfig.Load()));
        }
        catch (Exception ex)
        {
            Environment.ExitCode = 1;
            MessageBox.Show(
                "安装程序无法继续：\n\n" + ex.Message,
                "Jitang Simmer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}

internal static class CommandLine
{
    public static bool TryRun(string[] args)
    {
        if (args.Length == 0) return false;

        if (args.Contains("--open-dashboard", StringComparer.OrdinalIgnoreCase))
        {
            var deployment = DeploymentConfig.Load();
            InstallerEngine.StartCollectorIfInstalled();
            InstallerEngine.OpenDashboard(deployment.DashboardUrl);
            return true;
        }

        if (args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
        {
            UninstallInteractive();
            return true;
        }

        if (args.Contains("--cleanup", StringComparer.OrdinalIgnoreCase))
        {
            Cleanup(args);
            return true;
        }

        if (args.Contains("--silent-install", StringComparer.OrdinalIgnoreCase))
        {
            SilentInstall(args);
            return true;
        }

        return false;
    }

    private static void UninstallInteractive()
    {
        var choice = MessageBox.Show(
            "是否同时删除这台电脑尚未上传的本地缓存和设置？\n\n" +
            "选择“否”只卸载程序并保留本地数据（推荐）。",
            "卸载 Jitang Simmer",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2);

        if (choice == DialogResult.Cancel) return;

        bool removeData = choice == DialogResult.Yes;
        InstallerEngine.BeginUninstall(removeData);
        MessageBox.Show(
            removeData ? "Jitang Simmer 已卸载，本地数据将一并清理。" : "Jitang Simmer 已卸载，本地数据已保留。",
            "卸载完成",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private static void Cleanup(string[] args)
    {
        int parentId = int.Parse(GetValue(args, "--parent") ?? "0");
        string installDir = GetValue(args, "--install-dir") ?? throw new ArgumentException("缺少安装目录");
        string configDir = GetValue(args, "--config-dir") ?? throw new ArgumentException("缺少配置目录");
        bool removeData = args.Contains("--remove-data", StringComparer.OrdinalIgnoreCase);

        InstallerEngine.FinishUninstall(parentId, installDir, configDir, removeData);
    }

    private static void SilentInstall(string[] args)
    {
        string installDir = GetValue(args, "--install-dir") ?? InstallerPaths.InstallDirectory;
        string configDir = GetValue(args, "--config-dir") ?? InstallerPaths.ConfigDirectory;
        bool testMode = args.Contains("--test-mode", StringComparer.OrdinalIgnoreCase);

        var request = new InstallRequest(
            InstallDirectory: installDir,
            ConfigDirectory: configDir,
            EnableAutoStart: !testMode,
            CreateShortcuts: !testMode,
            RegisterUninstaller: !testMode,
            StopRunningCollectors: !testMode,
            StartAfterInstall: false,
            OpenDashboardAfterInstall: false);

        InstallerEngine.Install(DeploymentConfig.Load(), request);
    }

    private static string? GetValue(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        }
        return null;
    }
}
