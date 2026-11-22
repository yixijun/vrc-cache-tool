# VRChat 缓存工具

Windows 上的 VRChat 下载缓存设置和检测工具。Electron 负责桌面窗口与本地文件操作，Vue 负责设置表单，React 负责检测结果。

## 使用

1. 解压 Windows x64 便携包，双击 `VRChatCacheTool.exe`。
2. 填写缓存目录、缓存上限和过期时间。留空使用 VRChat 默认值，容量和天数至少为 30。
3. 点击「运行检测」，检查当前表单、目录读写、可用空间和 `Cache-WindowsPlayer` 内容缓存占用。目标目录尚未生成时，工具检测最近的现有上级目录。
4. 点击「应用设置」后重启 VRChat。如果更换了缓存目录，可以进入一个需要下载的世界，再检查新目录的缓存占用和最近修改时间。

配置写入 `%USERPROFILE%\AppData\LocalLow\VRChat\VRChat\config.json`，保留已有的其他设置。更新已有文件前，工具会把原文件备份为同目录的 `config.json.vrchat-cache-tool.bak`。恢复默认会在应用时移除 `cache_directory`、`cache_size` 和 `cache_expiry_delay` 三项。

「内容缓存占用」统计 `Cache-WindowsPlayer` 下的文件。检测只会写入并移除临时探针；已有缓存由 VRChat 管理。目录请使用普通文件夹，VRChat 官方建议避开符号链接和目录联接。

## 从源码运行

在 Windows x64 使用 Node.js 22.12 或更新版本。

```powershell
npm ci
npm start
```

运行自动化测试和构建便携版。

```powershell
npm test
npm run package:win
```

发布目录为 `release/VRChatCacheTool-win-x64`。分发时请携带整个目录。

## 官方资料

- [Configuration File](https://docs.vrchat.com/docs/configuration-file#cache-settings)
- [Local VRChat Storage](https://docs.vrchat.com/docs/local-vrchat-storage)
- [VRChat 2024.4.1 缓存默认值变更](https://docs.vrchat.com/docs/vrchat-202441)
