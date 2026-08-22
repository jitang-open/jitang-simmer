namespace SimmerCollector;

static class Program
{
    /// <summary>单实例互斥 + 托盘启动（CAP-04）</summary>
    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, "SimmerCollector_SingleInstance", out bool createdNew);
        if (!createdNew) return;   // 已有实例在运行，静默退出

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext());
    }
}
