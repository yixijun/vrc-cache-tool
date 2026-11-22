import path from 'node:path'

export const defaults = Object.freeze({ directory: '', size: '', expiry: '' })
export const minimum = 30
export const assetFolder = 'Cache-WindowsPlayer'

export function cacheDirectory(input, fallback) {
  if (typeof input !== 'string') throw new Error('缓存目录必须是路径字符串。')
  const value = input.trim().replaceAll('/', '\\')
  if (!value) return fallback
  const { root } = path.win32.parse(value)
  const isDrivePath = /^[a-z]:\\$/i.test(root)
  const isSharePath = /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+\\?$/.test(root)
  const segments = value.slice(root.length).split('\\').filter(Boolean)
  const invalidSegment = segments.some(segment => (
    /[<>:"|?*\x00-\x1f]/.test(segment) ||
    (segment !== '.' && segment !== '..' && /[. ]$/.test(segment)) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)
  ))
  if ((!isDrivePath && !isSharePath) || invalidSegment || /[\x00-\x1f]/.test(root)) {
    throw new Error('请输入有效的 Windows 绝对路径，例如 D:\\VRChatCache。')
  }
  return path.win32.normalize(value)
}

function settingInteger(input, label) {
  const value = typeof input === 'string' ? input.trim() : input
  if (value === '') return undefined
  const number = Number(value)
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(number) || number < minimum || number > 2147483647) {
    throw new Error(`${label}须为 30 到 2147483647 之间的整数。`)
  }
  return number
}

export function validate(form, base) {
  const directory = cacheDirectory(form.directory, base)
  const size = settingInteger(form.size, '缓存上限')
  const expiry = settingInteger(form.expiry, '过期时间')
  return {
    directory,
    size: size ?? minimum,
    expiry: expiry ?? minimum,
    overrides: {
      cache_directory: form.directory.trim() ? directory.replaceAll('\\', '/') : undefined,
      cache_size: size,
      cache_expiry_delay: expiry,
    },
  }
}
