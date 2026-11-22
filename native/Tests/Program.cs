using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using VrcCache;

internal static class Program
{
    private static void Main()
    {
        var root = Path.Combine(Path.GetFullPath(Path.GetTempPath()), "vrc-cache-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var service = new CacheService(root);
            var empty = Form();
            var initial = ToJson(service.Load());
            Require(!initial.GetProperty("exists").GetBoolean(), "fresh config starts absent");
            Require(!ToJson(service.Save(empty, null)).GetProperty("changed").GetBoolean(), "default settings need no file");

            var invalid = ToJson(service.Diagnose(Form(size: "29")));
            Require(invalid.GetProperty("rows")[0].GetProperty("state").GetString() == "error", "30 GB lower limit");
            Require(ToJson(service.Diagnose(Form(directory: "relative"))).GetProperty("rows")[0].GetProperty("state").GetString() == "error", "relative paths rejected");

            var json = "{\"disableRichPresence\":true,\"extra\":{\"n\":9007199254740993},\"cache_size\":45}";
            var original = Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes(json)).ToArray();
            File.WriteAllBytes(service.FilePath, original);
            var snapshot = ToJson(service.Load());
            Require(snapshot.GetProperty("form").GetProperty("size").GetString() == "45", "UTF-16 config read");
            var save = ToJson(service.Save(Form(root, "64", "75"), snapshot.GetProperty("revision").GetString()));
            var backup = save.GetProperty("backup").GetString();
            Require(File.ReadAllBytes(backup).SequenceEqual(original), "exact previous config backed up");
            using (var doc = JsonDocument.Parse(File.ReadAllText(service.FilePath)))
            {
                var persisted = doc.RootElement;
                Require(persisted.GetProperty("cache_size").GetInt32() == 64, "saved limit");
                Require(persisted.GetProperty("cache_expiry_delay").GetInt32() == 75, "saved expiry");
                Require(persisted.GetProperty("cache_directory").GetString() == root.Replace('\\', '/'), "saved absolute directory");
                Require(persisted.GetProperty("disableRichPresence").GetBoolean(), "unrelated setting retained");
                Require(persisted.GetProperty("extra").GetProperty("n").GetInt64() == 9007199254740993L, "unrelated integer retained exactly");
            }

            var revised = save.GetProperty("snapshot").GetProperty("revision").GetString();
            service.Save(empty, revised);
            using (var doc = JsonDocument.Parse(File.ReadAllText(service.FilePath)))
                Require(!doc.RootElement.TryGetProperty("cache_size", out _) && doc.RootElement.GetProperty("disableRichPresence").GetBoolean(), "defaults remove only cache keys");
            try { service.Save(Form(size: "80"), revised); throw new Exception("stale overwrite unexpectedly succeeded"); }
            catch (IOException error) when (error.Message.Contains("其他地方修改")) { }
            File.WriteAllText(service.FilePath, "{broken");
            Require(ToJson(service.Load()).GetProperty("blocked").GetBoolean(), "invalid config blocks saving");

            var report = ToJson(service.Diagnose(empty));
            Require(report.GetProperty("rows")[1].GetProperty("state").GetString() == "warn", "probe nearest existing folder");
            var cache = Directory.CreateDirectory(service.AssetDirectory("")).FullName;
            File.WriteAllBytes(Path.Combine(cache, "fixture"), new byte[2048]);
            report = ToJson(service.Diagnose(empty));
            Require(report.GetProperty("rows")[1].GetProperty("state").GetString() == "ok", "probe success");
            Require(report.GetProperty("rows")[3].GetProperty("bytes").GetInt64() == 2048 && Directory.GetFiles(cache).Length == 1, "asset scan and probe cleanup");
            Console.WriteLine("PASS: validation, config preservation and backup, reset, stale edits, broken config, and cache diagnostics.");
        }
        finally { Directory.Delete(root, true); }
    }

    private static JsonElement Form(string directory = "", string size = "", string expiry = "") => ToJson(new { directory, size, expiry });
    private static JsonElement ToJson(object value) => JsonSerializer.SerializeToElement(value);

    private static void Require(bool condition, string description)
    {
        if (!condition) throw new Exception("Test failed: " + description);
    }
}
