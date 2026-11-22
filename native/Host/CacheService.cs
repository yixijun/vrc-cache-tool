using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace VrcCache;

internal sealed class CacheService
{
    private const int Minimum = 30;
    private static readonly string[] Keys = { "cache_directory", "cache_size", "cache_expiry_delay" };
    private static readonly string[] Fields = { "directory", "size", "expiry" };
    private static readonly Regex AbsolutePath = new(@"^(?:[A-Za-z]:\\|\\\\[^\\/:*?""<>|]+\\[^\\/:*?""<>|]+(?:\\|$))", RegexOptions.CultureInvariant);
    private static readonly Regex DeviceName = new(@"^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private readonly object saveLock = new();

    public string Base { get; }
    public string FilePath => Path.Combine(Base, "config.json");

    public CacheService(string directory) => Base = directory;

    public object Load()
    {
        var form = Fields.ToDictionary(field => field, _ => "");
        try
        {
            var bytes = ReadBytes();
            using var document = Parse(bytes);
            var invalid = new List<string>();
            for (var i = 0; i < Keys.Length; i++)
            {
                if (!document.RootElement.TryGetProperty(Keys[i], out var field)) continue;
                form[Fields[i]] = field.ValueKind == JsonValueKind.String ? field.GetString() : field.GetRawText();
                if (i == 0 ? field.ValueKind != JsonValueKind.String : !IsInteger(field)) invalid.Add(Keys[i]);
            }

            var warning = invalid.Count == 0 ? "" : string.Join("、", invalid) + " 的 JSON 类型有误。请检查或修正后保存。";
            if (warning.Length == 0)
            {
                try { Validate(form["directory"], form["size"], form["expiry"]); }
                catch (ArgumentException exception) { warning = exception.Message; }
            }
            return new { file = FilePath, @base = Base, form, revision = Revision(bytes), exists = bytes != null, warning, blocked = false };
        }
        catch (Exception error)
        {
            return new { file = FilePath, @base = Base, form, warning = "无法读取 config.json。" + error.Message, blocked = true };
        }
    }

    public object Save(JsonElement form, string expectedRevision)
    {
        lock (saveLock)
        {
            var values = Validate(form);
            var previous = ReadBytes();
            EnsureRevision(previous, expectedRevision);
            using var document = Parse(previous);
            var current = document.RootElement;
            object[] overrides = { values.CustomDirectory?.Replace('\\', '/'), values.Size, values.Expiry };
            if (Keys.Select((key, i) => SameSetting(current, key, overrides[i])).All(equal => equal))
                return new { snapshot = Load(), changed = false };

            Directory.CreateDirectory(Base);
            var backup = previous == null ? null : FilePath + ".vrchat-cache-tool.bak";
            var temporary = FilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    using (var writer = new Utf8JsonWriter(file, new JsonWriterOptions { Indented = true }))
                    {
                        writer.WriteStartObject();
                        foreach (var property in current.EnumerateObject())
                            if (!Keys.Contains(property.Name, StringComparer.Ordinal)) property.WriteTo(writer);
                        for (var i = 0; i < Keys.Length; i++)
                        {
                            if (overrides[i] is string path) writer.WriteString(Keys[i], path);
                            else if (overrides[i] is int number) writer.WriteNumber(Keys[i], number);
                        }
                        writer.WriteEndObject();
                    }
                    file.WriteByte(10);
                    file.Flush(true);
                }
                EnsureRevision(ReadBytes(), expectedRevision);
                if (previous == null) File.Move(temporary, FilePath);
                else File.Replace(temporary, FilePath, backup);
            }
            finally { File.Delete(temporary); }
            return new { snapshot = Load(), changed = true, backup };
        }
    }

    private static bool SameSetting(JsonElement document, string key, object value)
    {
        if (!document.TryGetProperty(key, out var property)) return value == null;
        if (value is string path) return property.ValueKind == JsonValueKind.String && property.GetString() == path;
        return value is int number && IsInteger(property) && property.GetInt32() == number;
    }

    private static bool IsInteger(JsonElement property) => property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out _);

    private byte[] ReadBytes()
    {
        try
        {
            var attributes = File.GetAttributes(FilePath);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new IOException("配置路径须指向普通文件。");
            return File.ReadAllBytes(FilePath);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    private static JsonDocument Parse(byte[] bytes)
    {
        if (bytes == null) return JsonDocument.Parse("{}");
        using var reader = new StreamReader(new MemoryStream(bytes), new UTF8Encoding(false, true), true);
        var json = JsonDocument.Parse(reader.ReadToEnd());
        if (json.RootElement.ValueKind == JsonValueKind.Object) return json;
        json.Dispose();
        throw new InvalidDataException("根节点须为 JSON 对象。");
    }

    private static string Revision(byte[] bytes)
    {
        if (bytes == null) return null;
        using var hash = SHA256.Create();
        return Convert.ToBase64String(hash.ComputeHash(bytes));
    }

    private static void EnsureRevision(byte[] bytes, string expected)
    {
        if (Revision(bytes) != expected) throw new IOException("config.json 已在其他地方修改。请重新读取，再应用设置。");
    }

    private static int? ParseNumber(string value, string label)
    {
        value = value.Trim();
        if (value.Length == 0) return null;
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number < Minimum)
            throw new ArgumentException(label + "须为 30 到 2147483647 之间的整数。");
        return number;
    }

    private static string NormalizeDirectory(string value)
    {
        value = value.Trim().Replace('/', '\\');
        if (value.Length == 0) return null;
        var root = AbsolutePath.Match(value);
        if (root.Success && !value.Any(char.IsControl))
        {
            var segments = value.Substring(root.Length).Split('\\');
            if (!segments.Any(segment => segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                (segment != "." && segment != ".." && (segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal))) ||
                DeviceName.IsMatch(segment)))
                return Path.GetFullPath(value);
        }
        throw new ArgumentException("请输入有效的 Windows 绝对路径，例如 D:\\VRChatCache。");
    }

    public string DirectoryFor(string input) => NormalizeDirectory(input) ?? Base;
    public string AssetDirectory(string input) => Path.Combine(DirectoryFor(input), "Cache-WindowsPlayer");

    private static (string CustomDirectory, int? Size, int? Expiry) Validate(string directory, string size, string expiry) =>
        (NormalizeDirectory(directory), ParseNumber(size, "缓存上限"), ParseNumber(expiry, "过期时间"));

    private static (string CustomDirectory, int? Size, int? Expiry) Validate(JsonElement form) =>
        Validate(form.GetProperty("directory").GetString(), form.GetProperty("size").GetString(), form.GetProperty("expiry").GetString());

    public static (string Path, bool Exists) ClosestDirectory(string target)
    {
        var root = Path.GetPathRoot(target);
        var current = root;
        foreach (var segment in new[] { "" }.Concat(target.Substring(root.Length).Split('\\').Where(piece => piece.Length != 0)))
        {
            var next = Path.Combine(current, segment);
            FileAttributes attributes;
            try { attributes = File.GetAttributes(next); }
            catch (FileNotFoundException) when (segment.Length > 0) { return (current, false); }
            catch (DirectoryNotFoundException) when (segment.Length > 0) { return (current, false); }
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("请使用实际目录，路径含有链接或目录联接：" + next);
            if ((attributes & FileAttributes.Directory) == 0) throw new IOException("路径不是文件夹：" + next);
            current = next;
        }
        return (current, true);
    }

    public object Diagnose(JsonElement form)
    {
        var rows = new List<object>();
        string target;
        int size;
        try
        {
            var settings = Validate(form);
            size = settings.Size ?? Minimum;
            target = Path.Combine(settings.CustomDirectory ?? Base, "Cache-WindowsPlayer");
            rows.Add(new { name = "配置参数", state = "ok", detail = $"{size} GB 上限 · {settings.Expiry ?? Minimum} 天未访问后过期" });
        }
        catch (Exception error)
        {
            rows.Add(new { name = "配置参数", state = "error", detail = error.Message });
            return new { rows };
        }

        (string Path, bool Exists) cache;
        try { cache = ClosestDirectory(target); }
        catch (Exception error)
        {
            rows.Add(new { name = "目录读写", state = "error", detail = error.Message });
            return new { target, rows };
        }

        try
        {
            Probe(cache.Path);
            rows.Add(new { name = "目录读写", state = cache.Exists ? "ok" : "warn",
                detail = cache.Exists ? "测试文件已写入、读回并移除。" : "缓存目录尚未创建，已通过上级目录读写测试。",
                path = cache.Exists ? null : cache.Path });
        }
        catch (Exception error) { rows.Add(new { name = "目录读写", state = "error", detail = "读写测试失败。" + error.Message }); }

        var assets = cache.Exists ? Scan(target) : (0L, 0L, 0L, false);
        if (GetDiskFreeSpaceEx(cache.Path, out var free, out var total, out _))
        {
            var low = (double)free + assets.Item1 < size * 1e9;
            rows.Add(new { name = "磁盘可用空间", state = low ? "warn" : "ok", free, total,
                detail = low ? "当前可用空间与已扫描缓存之和低于设置上限。" : "当前可用空间足以容纳设置的缓存上限。" });
        }
        else rows.Add(new { name = "磁盘可用空间", state = "warn", detail = "无法读取文件系统容量。" });

        if (cache.Exists) rows.Add(new { name = "内容缓存占用", state = assets.Item4 ? "warn" : "ok",
            detail = assets.Item4 ? "部分文件未能扫描，显示已统计的数据。" : "",
            bytes = assets.Item1, files = assets.Item2, newest = assets.Item3 });
        else rows.Add(new { name = "内容缓存占用", state = "idle", detail = "尚未发现 Cache-WindowsPlayer。" });
        return new { target, rows };
    }

    private static void Probe(string directory)
    {
        var file = Path.Combine(directory, ".vrchat-cache-test-" + Guid.NewGuid().ToString("N") + ".tmp");
        var bytes = new byte[4096];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
        using var stream = new FileStream(file, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.DeleteOnClose | FileOptions.WriteThrough);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(true);
        stream.Position = 0;
        for (var i = 0; i < bytes.Length; i++)
            if (stream.ReadByte() != bytes[i]) throw new IOException("读回内容校验失败。");
    }

    private static (long, long, long, bool) Scan(string directory)
    {
        long bytes = 0, files = 0, newest = 0;
        var partial = false;
        var clock = Stopwatch.StartNew();
        var pending = new Stack<string>();
        pending.Push(directory);
        while (pending.Count > 0)
        {
            if (clock.ElapsedMilliseconds >= 5000) return (bytes, files, newest, true);
            try
            {
                var next = pending.Pop();
                if ((File.GetAttributes(next) & FileAttributes.ReparsePoint) != 0) { partial = true; continue; }
                foreach (var entry in new DirectoryInfo(next).EnumerateFileSystemInfos())
                {
                    if (clock.ElapsedMilliseconds >= 5000) return (bytes, files, newest, true);
                    if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) { partial = true; continue; }
                    if (entry is DirectoryInfo) pending.Push(entry.FullName);
                    else if (entry is FileInfo file)
                    {
                        bytes += file.Length;
                        files++;
                        newest = Math.Max(newest, new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds());
                    }
                }
            }
            catch (IOException) { partial = true; }
            catch (UnauthorizedAccessException) { partial = true; }
        }
        return (bytes, files, newest, partial);
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetDiskFreeSpaceEx(string directory, out ulong available, out ulong total, out ulong free);
}
