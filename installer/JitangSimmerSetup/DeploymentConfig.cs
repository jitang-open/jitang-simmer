using System.Reflection;
using System.Text.Json;

namespace JitangSimmerSetup;

internal sealed class DeploymentConfig
{
    public string ServerUrl { get; init; } = "";
    public string DashboardUrl { get; init; } = "";
    public string Token { get; init; } = "";
    public string Version { get; init; } = "0.10.0";

    public static DeploymentConfig Load()
    {
        const string resourceName = "JitangSimmerSetup.deployment.json";
        using Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException("安装包缺少部署配置，请重新生成安装包。");

        var config = JsonSerializer.Deserialize<DeploymentConfig>(stream, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidOperationException("安装包部署配置无效。");

        if (!Uri.TryCreate(config.ServerUrl, UriKind.Absolute, out _))
            throw new InvalidOperationException("中心服务器地址无效。");
        if (!Uri.TryCreate(config.DashboardUrl, UriKind.Absolute, out _))
            throw new InvalidOperationException("数据面板地址无效。");
        if (string.IsNullOrWhiteSpace(config.Token))
            throw new InvalidOperationException("安装包没有上报凭据。");

        return config;
    }
}
