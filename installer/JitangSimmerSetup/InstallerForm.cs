using System.Drawing.Drawing2D;

namespace JitangSimmerSetup;

internal sealed class InstallerForm : Form
{
    private readonly DeploymentConfig _deployment;
    private readonly CheckBox _autoStart = new();
    private readonly CheckBox _openDashboard = new();
    private readonly Button _installButton = new();
    private readonly Label _status = new();
    private readonly ProgressBar _progress = new();

    public InstallerForm(DeploymentConfig deployment)
    {
        _deployment = deployment;
        Text = "Jitang Simmer 安装程序";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ClientSize = new Size(600, 455);
        BackColor = Color.FromArgb(245, 247, 250);
        Font = new Font("Microsoft YaHei UI", 9F);

        BuildHeader();
        BuildContent();
    }

    private void BuildHeader()
    {
        var header = new Panel
        {
            Dock = DockStyle.Top,
            Height = 132,
            BackColor = Color.FromArgb(18, 24, 38),
        };

        var mark = new BrandMark
        {
            Location = new Point(34, 30),
            Size = new Size(70, 70),
        };
        var title = new Label
        {
            AutoSize = true,
            Location = new Point(123, 31),
            Text = "Jitang Simmer",
            ForeColor = Color.White,
            Font = new Font("Microsoft YaHei UI", 22F, FontStyle.Bold),
        };
        var subtitle = new Label
        {
            AutoSize = true,
            Location = new Point(127, 78),
            Text = "电脑使用与 AI Token 统计  ·  v" + _deployment.Version,
            ForeColor = Color.FromArgb(174, 184, 202),
            Font = new Font("Microsoft YaHei UI", 10F),
        };

        header.Controls.Add(mark);
        header.Controls.Add(title);
        header.Controls.Add(subtitle);
        Controls.Add(header);
    }

    private void BuildContent()
    {
        var intro = new Label
        {
            AutoSize = false,
            Location = new Point(36, 156),
            Size = new Size(525, 49),
            Text = "安装后会自动连接中心服务器，并为这台电脑生成独立设备身份。\n不会复制打包电脑的历史数据或设备 ID。",
            ForeColor = Color.FromArgb(55, 65, 81),
            Font = new Font("Microsoft YaHei UI", 10F),
        };

        var pathCaption = new Label
        {
            AutoSize = true,
            Location = new Point(37, 221),
            Text = "安装位置",
            ForeColor = Color.FromArgb(107, 114, 128),
        };
        var pathValue = new Label
        {
            AutoEllipsis = true,
            Location = new Point(116, 218),
            Size = new Size(445, 24),
            Text = InstallerPaths.InstallDirectory,
            ForeColor = Color.FromArgb(31, 41, 55),
            Font = new Font("Segoe UI", 9.5F),
        };

        _autoStart.Location = new Point(37, 260);
        _autoStart.Size = new Size(330, 26);
        _autoStart.Text = "登录 Windows 后自动启动采集器";
        _autoStart.Checked = true;

        _openDashboard.Location = new Point(37, 291);
        _openDashboard.Size = new Size(330, 26);
        _openDashboard.Text = "安装完成后打开云端数据面板";
        _openDashboard.Checked = true;

        _progress.Location = new Point(37, 337);
        _progress.Size = new Size(524, 7);
        _progress.Style = ProgressBarStyle.Blocks;

        _status.Location = new Point(37, 358);
        _status.Size = new Size(348, 45);
        _status.Text = File.Exists(Path.Combine(InstallerPaths.InstallDirectory, InstallerPaths.CollectorFileName))
            ? "已检测到旧版本，可直接更新或修复。"
            : "准备安装";
        _status.ForeColor = Color.FromArgb(107, 114, 128);

        _installButton.Location = new Point(418, 363);
        _installButton.Size = new Size(143, 42);
        _installButton.FlatStyle = FlatStyle.Flat;
        _installButton.FlatAppearance.BorderSize = 0;
        _installButton.BackColor = Color.FromArgb(28, 180, 112);
        _installButton.ForeColor = Color.White;
        _installButton.Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold);
        _installButton.Cursor = Cursors.Hand;
        _installButton.Text = File.Exists(Path.Combine(InstallerPaths.InstallDirectory, InstallerPaths.CollectorFileName))
            ? "更新 / 修复" : "立即安装";
        _installButton.Click += InstallClicked;

        Controls.AddRange([
            intro, pathCaption, pathValue, _autoStart, _openDashboard,
            _progress, _status, _installButton,
        ]);
        AcceptButton = _installButton;
    }

    private async void InstallClicked(object? sender, EventArgs e)
    {
        _installButton.Enabled = false;
        _autoStart.Enabled = false;
        _openDashboard.Enabled = false;
        _progress.Style = ProgressBarStyle.Marquee;
        _progress.MarqueeAnimationSpeed = 24;
        _status.ForeColor = Color.FromArgb(55, 65, 81);

        var request = new InstallRequest(
            InstallDirectory: InstallerPaths.InstallDirectory,
            ConfigDirectory: InstallerPaths.ConfigDirectory,
            EnableAutoStart: _autoStart.Checked,
            CreateShortcuts: true,
            RegisterUninstaller: true,
            StopRunningCollectors: true,
            StartAfterInstall: true,
            OpenDashboardAfterInstall: _openDashboard.Checked);

        try
        {
            await Task.Run(() => InstallerEngine.Install(_deployment, request, UpdateStatus));
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 100;
            _status.Text = "安装完成·采集器已启动";
            _status.ForeColor = Color.FromArgb(18, 130, 82);
            _installButton.Enabled = true;
            _installButton.Text = "完成";
            _installButton.Click -= InstallClicked;
            _installButton.Click += (_, _) => Close();
        }
        catch (Exception ex)
        {
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = 0;
            _status.Text = "安装失败：" + ex.Message;
            _status.ForeColor = Color.FromArgb(185, 28, 28);
            _installButton.Enabled = true;
            _installButton.Text = "重试";
            _autoStart.Enabled = true;
            _openDashboard.Enabled = true;
        }
    }

    private void UpdateStatus(string message)
    {
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(() => _status.Text = message);
    }
}

internal sealed class BrandMark : Control
{
    public BrandMark()
    {
        DoubleBuffered = true;
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var gradient = new LinearGradientBrush(
            ClientRectangle,
            Color.FromArgb(36, 210, 136),
            Color.FromArgb(76, 126, 255),
            45F);
        e.Graphics.FillEllipse(gradient, 1, 1, Width - 2, Height - 2);

        using var pen = new Pen(Color.White, 5F)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
        };
        PointF[] pulse =
        [
            new(14, 37), new(25, 37), new(31, 22),
            new(39, 49), new(46, 31), new(56, 31),
        ];
        e.Graphics.DrawLines(pen, pulse);
    }
}
