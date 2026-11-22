using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace VrcCache;

public static class Host
{
    public static void Run(string assets, string appData)
    {
        using var instance = new Mutex(true, @"Local\VRChatCacheTool.WebView2", out var first);
        if (!first)
        {
            var current = Process.GetCurrentProcess();
            foreach (var other in Process.GetProcessesByName(current.ProcessName))
            {
                using (other)
                {
                    if (other.Id == current.Id || other.MainWindowHandle == IntPtr.Zero) continue;
                    ShowWindow(other.MainWindowHandle, 9);
                    SetForegroundWindow(other.MainWindowHandle);
                    break;
                }
            }
            return;
        }

        SetCurrentProcessExplicitAppUserModelID("io.github.yixijun.VRChatCacheTool");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        CoreWebView2Environment.SetLoaderDllFolderPath(Path.Combine(assets, "native"));
        using var window = new ToolWindow(assets, appData);
        Application.Run(window);
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}

internal sealed class ToolWindow : Form
{
    private const string HostName = "vrc-cache-tool.example";
    private const string Page = "https://" + HostName + "/index.html";
    private const string Docs = "https://docs.vrchat.com/docs/configuration-file#cache-settings";
    private const string RuntimeDownload = "https://developer.microsoft.com/microsoft-edge/webview2/#download";
    private readonly WebView2 view = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(16, 19, 25) };
    private readonly CacheService service = new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "AppData", "LocalLow", "VRChat", "VRChat"));
    private readonly string assets;
    private readonly string appData;

    public ToolWindow(string assets, string appData)
    {
        this.assets = assets;
        this.appData = appData;
        Text = "VRChat 缓存工具";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1040, 725);
        MinimumSize = new Size(670, 575);
        BackColor = view.DefaultBackgroundColor;
        Controls.Add(view);
        Shown += Initialize;
    }

    protected override void OnHandleCreated(EventArgs args)
    {
        base.OnHandleCreated(args);
        var enabled = 1;
        DwmSetWindowAttribute(Handle, 20, ref enabled, sizeof(int));
    }

    private async void Initialize(object sender, EventArgs args)
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(appData, "WebView2"));
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(env);
            if (IsDisposed) return;
            var browser = view.CoreWebView2;
            browser.Settings.AreDevToolsEnabled = false;
            browser.Settings.AreDefaultContextMenusEnabled = false;
            browser.NewWindowRequested += (_, request) => request.Handled = true;
            browser.NavigationStarting += (_, navigation) => navigation.Cancel = navigation.Uri != Page;
            browser.WebMessageReceived += ReceiveMessage;
            browser.SetVirtualHostNameToFolderMapping(HostName, Path.Combine(assets, "site"), CoreWebView2HostResourceAccessKind.Deny);
            browser.Navigate(Page);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (IsDisposed) return;
            var result = MessageBox.Show(this, "此电脑尚未安装 Microsoft Edge WebView2 运行时。打开微软官方下载页面？",
                Text, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (result == DialogResult.Yes) Launch(RuntimeDownload);
            Close();
        }
        catch (Exception error)
        {
            if (IsDisposed) return;
            MessageBox.Show(this, "无法启动界面。" + error.GetBaseException().Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private async void ReceiveMessage(object sender, CoreWebView2WebMessageReceivedEventArgs message)
    {
        if (message.Source != Page) return;
        int id = 0;
        object reply;
        try
        {
            using var request = JsonDocument.Parse(message.WebMessageAsJson);
            var json = request.RootElement;
            id = json.GetProperty("id").GetInt32();
            var method = json.GetProperty("method").GetString();
            var arguments = json.GetProperty("arguments");
            var value = await Dispatch(method, arguments);
            reply = new { id, ok = true, value };
        }
        catch (Exception error) { reply = new { id, ok = false, error = error.GetBaseException().Message }; }

        if (!IsDisposed) view.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(reply));
    }

    private async Task<object> Dispatch(string method, JsonElement args)
    {
        switch (method)
        {
            case "load": return await Task.Run(service.Load);
            case "save": return await Task.Run(() => service.Save(args[0], args[1].GetString()));
            case "diagnose": return await Task.Run(() => service.Diagnose(args[0]));
            case "pickDirectory": return PickDirectory(args[0].GetString());
            case "openCache":
                var input = args[0].GetString();
                var content = service.AssetDirectory(input);
                OpenFolder(CacheService.ClosestDirectory(content).Exists ? content : service.DirectoryFor(input));
                return null;
            case "openConfig": OpenFolder(service.Base); return null;
            case "openDocs": Launch(Docs); return null;
            default: throw new ArgumentException("未知操作。");
        }
    }

    private string PickDirectory(string current)
    {
        using var dialog = new FolderBrowserDialog { Description = "选择 VRChat 缓存目录", ShowNewFolderButton = true };
        try { dialog.SelectedPath = CacheService.ClosestDirectory(service.DirectoryFor(current)).Path; }
        catch (Exception) { }
        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : null;
    }

    private static void OpenFolder(string directory)
    {
        if (!CacheService.ClosestDirectory(directory).Exists) throw new IOException("文件夹还未创建。");
        Launch(directory);
    }

    private static void Launch(string target) => Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int length);
}
