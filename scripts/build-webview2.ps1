$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$release = Join-Path $project 'release'
$build = Join-Path $release ('build-' + [Guid]::NewGuid().ToString('N'))
$dist = Join-Path $project 'dist'
$output = Join-Path $release 'portable'
$binary = 'VRChatCacheTool-win-x64.exe'
if (!(Test-Path -LiteralPath (Join-Path $dist 'index.html'))) { throw '先运行 npm run build。' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw '请在 Windows x64 上构建。' }

New-Item -ItemType Directory -Path $build -Force | Out-Null
try {
    $hostOut = Join-Path $build 'host'
    $launcherOut = Join-Path $build 'launcher'
    $pack = Join-Path $build 'Payload.zip'
    dotnet build (Join-Path $project 'native/Host/Host.csproj') -c Release -o $hostOut
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Create($pack)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        function Add-PayloadFile([string]$source, [string]$entry) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $entry, [IO.Compression.CompressionLevel]::SmallestSize) | Out-Null
        }

        foreach ($dll in (Get-ChildItem -LiteralPath $hostOut -File -Filter '*.dll')) {
            if ($dll.Name -eq 'WebView2Loader.dll') { Add-PayloadFile $dll.FullName ('native/' + $dll.Name) }
            elseif ($dll.Name -ne 'Microsoft.Web.WebView2.Wpf.dll') { Add-PayloadFile $dll.FullName ('managed/' + $dll.Name) }
        }
        foreach ($asset in (Get-ChildItem -LiteralPath $dist -Recurse -File)) {
            $relative = [IO.Path]::GetRelativePath($dist, $asset.FullName).Replace('\', '/')
            Add-PayloadFile $asset.FullName ('site/' + $relative)
        }
        foreach ($package in @('vue', 'react', 'react-dom', 'scheduler')) {
            Add-PayloadFile (Join-Path $project "node_modules/$package/LICENSE") "licenses/$package.txt"
        }
        $manifests = Get-Content -LiteralPath (Join-Path $project 'native/Host/obj/project.assets.json') -Raw | ConvertFrom-Json -AsHashtable
        foreach ($library in $manifests.libraries.Values) {
            foreach ($name in ($library.files | Where-Object { $_ -match '^(LICENSE|NOTICE|THIRD[-_ ]?PARTY)[^/]*$' })) {
                foreach ($folder in $manifests.packageFolders.Keys) {
                    $source = Join-Path $folder ($library.path + '/' + $name)
                    if (Test-Path -LiteralPath $source -PathType Leaf) {
                        Add-PayloadFile $source ('licenses/' + $library.path.Replace('/', '-') + '-' + $name)
                        break
                    }
                }
            }
        }
    } finally { $zip.Dispose() }

    dotnet build (Join-Path $project 'native/Launcher/Launcher.csproj') -c Release -o $launcherOut "-p:PayloadFile=$pack"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $exe = Get-Item -LiteralPath (Join-Path $launcherOut $binary)
    if ($exe.Length -ge 1000000) { throw "EXE 超过 1 MB：$($exe.Length) 字节。" }
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    [IO.File]::Move($exe.FullName, (Join-Path $output $binary), $true)
    Write-Output "Windows x64 EXE: $($exe.Length) bytes"
} finally {
    $resolved = (Resolve-Path -LiteralPath $build).Path
    if ([IO.Path]::GetDirectoryName($resolved) -eq $release) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
