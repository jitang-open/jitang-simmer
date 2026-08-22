using Microsoft.Win32;

namespace SimmerCollector;

/// <summary>
/// 托盘常驻主程序（CAP-04）：系统托盘图标 + 菜单，
/// 协调前台窗口采样（2 秒）→ 分钟聚合 → 本地队列 → 定时上报。
/// </summary>
internal class TrayContext : ApplicationContext
{
    private readonly Config _cfg;
    private readonly LocalStore _store;
    private readonly MinuteAggregator _aggregator = new();
    private readonly NotifyIcon _tray;
    private readonly ContextMenuStrip _menu = new();
    private readonly Control _uiSync = new Control();   // 专用隐藏控件：为后台线程提供 UI 调度句柄
    private readonly System.Threading.Timer _sampleTimer;
    private readonly System.Threading.Timer _uploadTimer;
    private readonly SemaphoreSlim _uploadLock = new(1, 1);

    private bool _paused;
    private volatile bool _sessionLocked;
    private DateTime _lastUpload = DateTime.MinValue;
    private DateTime _lastSuccess = DateTime.MinValue;

    public TrayContext()
    {
        _cfg = Config.Load();
        _store = new LocalStore();
        _ = _uiSync.Handle;                            // 立即创建句柄，使 BeginInvoke 可用

        var menu = _menu;
        menu.Items.Add("暂停统计", null, (s, e) => TogglePause());
        menu.Items.Add("立即上报", null, async (s, e) => await UploadNow());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("设置…", null, (s, e) => ShowSettings());
        menu.Items.Add("打开数据文件夹", null, (s, e) => OpenDataFolder());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (s, e) => ExitApp());

        _tray = new NotifyIcon
        {
            ContextMenuStrip = menu,
            Visible = true,
            Text = "Simmer 采集器 · 启动中",
        };
        _tray.Icon = MakeIcon(paused: false);
        _tray.DoubleClick += (s, e) => ShowSettings();

        _aggregator.MinuteCompleted += rec => _store.Enqueue(rec);

        // 锁屏 / 解锁事件（CAP-03）
        SystemEvents.SessionSwitch += (s, e) =>
        {
            if (e.Reason == SessionSwitchReason.SessionLock) _sessionLocked = true;
            if (e.Reason == SessionSwitchReason.SessionUnlock) _sessionLocked = false;
        };

        // 采样定时器：每 2 秒（回调异常不得拖垮进程）
        _sampleTimer = new System.Threading.Timer(_ => Safe(Sample), null, TimeSpan.Zero, TimeSpan.FromSeconds(2));
        // 上报定时器：每分钟检查，间隔到达或队列过长时触发
        _uploadTimer = new System.Threading.Timer(_ => _ = UploadDueSafeAsync(), null,
            TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    private static void Safe(Action fn)
    {
        try { fn(); } catch { /* 定时器线程异常不得终止进程 */ }
    }

    private async Task UploadDueSafeAsync()
    {
        try { await UploadDue(); }
        catch (Exception ex) { Log.Write("定时上报异常: " + ex.Message); }
    }

    /* ---------------- 采样与聚合 ---------------- */

    private void Sample()
    {
        if (_paused) return;
        bool idle = _sessionLocked || NativeMethods.IdleMilliseconds > (uint)(_cfg.IdleThresholdMinutes * 60_000);
        string? exe = idle ? null : NativeMethods.GetForegroundProcessName();
        _aggregator.AddSample(idle, exe);
    }

    /* ---------------- 上报 ---------------- */

    private async Task UploadDue()
    {
        bool due = (DateTime.Now - _lastUpload).TotalMinutes >= _cfg.UploadIntervalMinutes;
        bool full = _store.Count >= 300;
        if (due || full) await UploadNow();
    }

    private async Task UploadNow()
    {
        if (!await _uploadLock.WaitAsync(0))
        {
            UpdateTooltip("已有上报任务进行中");
            return;
        }
        try
        {
            var batch = _store.Peek(2000);
            if (batch.Count == 0) { UpdateTooltip("队列为空"); return; }

            _lastUpload = DateTime.Now;
            bool ok = await Uploader.FlushAsync(_cfg, batch);
            if (ok)
            {
                _store.Dequeue(batch.Count);
                _lastSuccess = DateTime.Now;
                UpdateTooltip($"已上报 {batch.Count} 条");
            }
            else
            {
                UpdateTooltip($"上报失败（队列保留 {_store.Count} 条）");
            }
        }
        catch (Exception ex)
        {
            Log.Write("上报处理异常: " + ex.Message);
            UpdateTooltip($"上报异常（队列保留 {_store.Count} 条）");
        }
        finally
        {
            _uploadLock.Release();
        }
    }

    private void UpdateTooltip(string state)
    {
        string text = $"Simmer 采集器 · {(_paused ? "已暂停" : "运行中")}\n{state}";
        if (text.Length > 63) text = text.Substring(0, 63);
        if (!_uiSync.IsDisposed && _uiSync.IsHandleCreated)
        {
            try { _uiSync.BeginInvoke(() => _tray.Text = text); }
            catch (InvalidOperationException) { /* 应用退出期间忽略 UI 更新 */ }
        }
    }

    /* ---------------- 菜单动作 ---------------- */

    private void TogglePause()
    {
        _paused = !_paused;
        _tray.Icon = MakeIcon(_paused);
        _tray.ShowBalloonTip(1500, "Simmer 采集器", _paused ? "统计已暂停" : "统计已恢复", ToolTipIcon.Info);
        UpdateTooltip(_paused ? "手动暂停" : "已恢复");
        // 暂停/恢复时切分钟，避免暂停时长被计入
        _aggregator.AddSample(_paused, null);
    }

    private void ShowSettings()
    {
        using var form = new SettingsForm(_cfg);
        if (form.ShowDialog() == DialogResult.OK)
        {
            _cfg.Save();
            _tray.ShowBalloonTip(1500, "Simmer 采集器", "配置已保存", ToolTipIcon.Info);
        }
    }

    private static void OpenDataFolder() =>
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = Config.Dir,
            UseShellExecute = true,
        });

    private void ExitApp()
    {
        var rec = _aggregator.FlushCurrent();
        if (rec != null) _store.Enqueue(rec);
        _sampleTimer.Dispose();
        _uploadTimer.Dispose();
        _tray.Visible = false;
        Application.Exit();
    }

    /* ---------------- 托盘图标（代码绘制，免去 .ico 资源） ---------------- */

    private static Icon MakeIcon(bool paused)
    {
        using var bmp = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            using var brush = new SolidBrush(paused ? Color.Gray : Color.FromArgb(29, 185, 84));
            g.FillEllipse(brush, 2, 2, 12, 12);
        }
        IntPtr h = bmp.GetHicon();
        return Icon.FromHandle(h);
    }
}

/// <summary>简易设置对话框：服务器地址 / Token / 设备名 / 空闲阈值</summary>
internal class SettingsForm : Form
{
    private readonly Config _cfg;
    private readonly TextBox _txtUrl = new() { Top = 30, Left = 110, Width = 260 };
    private readonly TextBox _txtToken = new() { Top = 60, Left = 110, Width = 260 };
    private readonly TextBox _txtName = new() { Top = 90, Left = 110, Width = 260 };
    private readonly NumericUpDown _numIdle = new() { Top = 120, Left = 110, Width = 80, Minimum = 1, Maximum = 60 };

    public SettingsForm(Config cfg)
    {
        _cfg = cfg;
        Text = "Simmer 采集器 设置";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(400, 190);

        void Label(string text, int top) =>
            Controls.Add(new Label { Text = text, AutoSize = true, Top = top + 3, Left = 15 });

        Label("服务器地址", 30); Label("上报 Token", 60); Label("设备名称", 90); Label("空闲阈值(分钟)", 120);

        _txtUrl.Text = cfg.ServerUrl;
        _txtToken.Text = cfg.Token;
        _txtName.Text = cfg.DeviceName;
        _numIdle.Value = cfg.IdleThresholdMinutes;
        Controls.AddRange([_txtUrl, _txtToken, _txtName, _numIdle]);

        var ok = new Button { Text = "保存", DialogResult = DialogResult.OK, Top = 150, Left = 210, Width = 85 };
        var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Top = 150, Left = 305, Width = 80 };
        ok.Click += (s, e) =>
        {
            cfg.ServerUrl = _txtUrl.Text.Trim();
            cfg.Token = _txtToken.Text.Trim();
            cfg.DeviceName = _txtName.Text.Trim();
            cfg.IdleThresholdMinutes = (int)_numIdle.Value;
        };
        Controls.Add(ok);
        Controls.Add(cancel);
        AcceptButton = ok;
        CancelButton = cancel;
    }
}
