import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, open, opendir, statfs, unlink } from 'node:fs/promises'
import path from 'node:path'
import { assetFolder, validate } from './settings.mjs'

export async function closestDirectory(target) {
  const { root } = path.parse(target)
  const segments = target.slice(root.length).split(path.sep).filter(Boolean)
  let parent = root
  for (const segment of ['', ...segments]) {
    const current = path.join(parent, segment)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) throw new Error(`请使用实际目录，路径含有链接或目录联接：${current}`)
      if (!entry.isDirectory()) throw new Error(`路径不是文件夹：${current}`)
      parent = current
    } catch (error) {
      if (error.code === 'ENOENT' && segment) return { path: parent, exists: false }
      throw error
    }
  }
  return { path: parent, exists: true }
}

async function probe(directory) {
  const file = path.join(directory, `.vrchat-cache-test-${randomUUID()}.tmp`)
  const payload = randomBytes(4096)
  const handle = await open(file, 'wx+')
  try {
    await handle.writeFile(payload)
    await handle.sync()
    const result = Buffer.alloc(payload.length)
    const { bytesRead } = await handle.read(result, 0, result.length, 0)
    if (bytesRead !== payload.length || !result.equals(payload)) throw new Error('读回内容校验失败。')
  } finally {
    try { await handle.close() } finally { await unlink(file) }
  }
}

async function scanAssets(directory) {
  const pending = [directory]
  const deadline = Date.now() + 5000
  const totals = { bytes: 0, files: 0, newest: 0, partial: false }
  while (pending.length) {
    try {
      const next = pending.pop()
      const info = await lstat(next)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        totals.partial = true
        continue
      }
      for await (const entry of await opendir(next)) {
        if (Date.now() >= deadline) return { ...totals, partial: true }
        const name = path.join(next, entry.name)
        if (entry.isDirectory()) pending.push(name)
        else if (entry.isSymbolicLink()) totals.partial = true
        else if (entry.isFile()) {
          try {
            const stat = await lstat(name)
            if (!stat.isFile()) { totals.partial = true; continue }
            totals.files++
            totals.bytes += stat.size
            totals.newest = Math.max(totals.newest, stat.mtimeMs)
          } catch { totals.partial = true }
        }
      }
    } catch { totals.partial = true }
    if (Date.now() >= deadline && pending.length) return { ...totals, partial: true }
  }
  return totals
}

const row = (name, state, detail, extra) => ({ name, state, detail, ...extra })

export async function diagnose(form, base) {
  let settings
  try { settings = validate(form, base) } catch (error) {
    return { rows: [row('配置参数', 'error', error.message)] }
  }

  const params = row('配置参数', 'ok', `${settings.size} GB 上限 · ${settings.expiry} 天未访问后过期`)
  const target = path.join(settings.directory, assetFolder)
  let cache
  try { cache = await closestDirectory(target) } catch (error) {
    return { target, rows: [params, row('目录读写', 'error', error.message)] }
  }

  const [write, space] = await Promise.allSettled([
    probe(cache.path),
    statfs(cache.path),
  ])
  const assets = cache.exists ? await scanAssets(target) : null
  const rows = [params]
  rows.push(write.status === 'fulfilled'
    ? (cache.exists
      ? row('目录读写', 'ok', '测试文件已写入、读回并移除。')
      : row('目录读写', 'warn', `缓存目录尚未创建，已通过上级目录读写测试。`, { path: cache.path }))
    : row('目录读写', 'error', `读写测试失败。${write.reason.message}`))

  if (space.status === 'fulfilled') {
    const { bavail, blocks, bsize } = space.value
    const free = bavail * bsize
    const total = blocks * bsize
    const size = assets?.bytes ?? 0
    const warning = free + size < settings.size * 1e9
    rows.push(row('磁盘可用空间', warning ? 'warn' : 'ok',
      warning ? '当前可用空间与已扫描缓存之和低于设置上限。' : '当前可用空间足以容纳设置的缓存上限。',
      { free, total }))
  } else rows.push(row('磁盘可用空间', 'warn', `无法读取文件系统容量。${space.reason.message}`))

  if (assets) {
    const { bytes, files, newest, partial } = assets
    rows.push(row('内容缓存占用', partial ? 'warn' : 'ok',
      partial ? '部分文件未能扫描，显示已统计的数据。' : '', { bytes, files, newest }))
  } else rows.push(row('内容缓存占用', 'idle', '尚未发现 Cache-WindowsPlayer。'))

  return { target, rows }
}
