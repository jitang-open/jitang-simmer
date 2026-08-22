using System.Runtime.InteropServices;

namespace SimmerCollector;

/// <summary>Win32 API 声明：前台窗口与进程、键鼠空闲检测（CAP-01 / CAP-03）</summary>
internal static class NativeMethods
{
    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr OpenProcess(uint processAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags,
        System.Text.StringBuilder lpExeName, ref uint lpdwSize);

    [DllImport("kernel32.dll")]
    internal static extern bool CloseHandle(IntPtr hObject);

    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    internal struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    /// <summary>距上次键鼠输入的毫秒数（CAP-03 空闲检测）</summary>
    internal static uint IdleMilliseconds
    {
        get
        {
            var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
            if (!GetLastInputInfo(ref info)) return 0;
            unchecked
            {
                return (uint)Environment.TickCount - info.dwTime;
            }
        }
    }

    /// <summary>当前前台窗口对应的进程可执行文件名（如 Code.exe），失败返回 null</summary>
    internal static string? GetForegroundProcessName()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;

        GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == 0) return null;

        IntPtr hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hProcess == IntPtr.Zero) return null;

        try
        {
            var sb = new System.Text.StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            if (!QueryFullProcessImageName(hProcess, 0, sb, ref size)) return null;
            return Path.GetFileName(sb.ToString());
        }
        finally
        {
            CloseHandle(hProcess);
        }
    }
}
