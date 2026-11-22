using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        try
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload.zip"))
            using (var sha = SHA256.Create())
            {
                var fingerprint = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                stream.Position = 0;
                using (var payload = new ZipArchive(stream, ZipArchiveMode.Read, true))
                {
                    var appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRChatCacheTool");
                    var assets = Path.Combine(appData, "payload", fingerprint);
                    foreach (var entry in payload.Entries.Where(e => !e.FullName.StartsWith("managed/", StringComparison.Ordinal)))
                        Materialize(entry, assets);

                    var archiveLock = new object();
                    ResolveEventHandler resolve = (_, args) =>
                    {
                        var name = new AssemblyName(args.Name).Name;
                        lock (archiveLock)
                        {
                            var library = payload.GetEntry("managed/" + name + ".dll");
                            return library == null ? null : Assembly.Load(Read(library));
                        }
                    };
                    AppDomain.CurrentDomain.AssemblyResolve += resolve;
                    try
                    {
                        var host = Assembly.Load(Read(payload.GetEntry("managed/VRChatCacheTool.Host.dll")));
                        host.GetType("VrcCache.Host").GetMethod("Run").Invoke(null, new object[] { assets, appData });
                    }
                    finally { AppDomain.CurrentDomain.AssemblyResolve -= resolve; }
                }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.GetBaseException().Message, "VRChat 缓存工具", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static byte[] Read(ZipArchiveEntry entry)
    {
        using (var file = entry.Open())
        using (var contents = new MemoryStream())
        {
            file.CopyTo(contents);
            return contents.ToArray();
        }
    }

    private static void Materialize(ZipArchiveEntry entry, string root)
    {
        var file = Path.GetFullPath(Path.Combine(root, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
        if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("便携版资源路径无效。");

        var bytes = Read(entry);
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        if (File.Exists(file) && File.ReadAllBytes(file).SequenceEqual(bytes)) return;
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, bytes);
            if (File.Exists(file)) File.Replace(temporary, file, null);
            else
            {
                try { File.Move(temporary, file); }
                catch (IOException) when (File.Exists(file) && File.ReadAllBytes(file).SequenceEqual(bytes)) { }
            }
        }
        finally { File.Delete(temporary); }
    }
}
