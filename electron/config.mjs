import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { defaults, validate } from './settings.mjs'

const fields = { directory: 'cache_directory', size: 'cache_size', expiry: 'cache_expiry_delay' }

async function readBytes(file) {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('配置路径须指向普通文件。')
    return await readFile(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function decode(bytes) {
  if (!bytes) return '{}'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function readDocument(bytes, preserveNumbers = false) {
  const parseNumber = preserveNumbers
    ? (_key, value, context) => typeof value === 'number' ? JSON.rawJSON(context.source) : value
    : undefined
  const doc = JSON.parse(decode(bytes), parseNumber)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('根节点须为 JSON 对象。')
  return doc
}

function revision(bytes) {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null
}

async function writeAtomically(file, bytes, beforeRename) {
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx')
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await beforeRename?.()
    await rename(temp, file)
  } finally {
    await unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export function createConfigStore(base) {
  const file = path.join(base, 'config.json')
  const backup = `${file}.vrchat-cache-tool.bak`

  async function load() {
    const form = { ...defaults }
    let bytes
    let doc
    try {
      bytes = await readBytes(file)
      doc = readDocument(bytes)
    } catch (error) {
      return { file, base, form, blocked: true, warning: `无法读取 config.json。${error.message}` }
    }

    const unexpected = []
    for (const [field, key] of Object.entries(fields)) {
      if (!Object.hasOwn(doc, key)) continue
      const value = doc[key]
      form[field] = typeof value === 'string' ? value : JSON.stringify(value)
      if (field === 'directory' ? typeof value !== 'string' : !Number.isInteger(value)) unexpected.push(key)
    }

    let warning = unexpected.length ? `${unexpected.join('、')} 的 JSON 类型有误。请检查或修正后保存。` : ''
    if (!warning) {
      try { validate(form, base) } catch (error) { warning = error.message }
    }
    return { file, base, form, revision: revision(bytes), exists: bytes !== null, warning, blocked: false }
  }

  async function save(form, expectedRevision) {
    const { overrides } = validate(form, base)
    const previous = await readBytes(file)
    const changedElsewhere = () => new Error('config.json 已在其他地方修改。请重新读取，再应用设置。')
    const assertUnchanged = async () => {
      if (revision(await readBytes(file)) !== expectedRevision) throw changedElsewhere()
    }
    if (revision(previous) !== expectedRevision) throw changedElsewhere()

    let doc
    try {
      doc = readDocument(previous, true)
    } catch {
      throw new Error('config.json 不是有效的 JSON 对象。请修复文件后重新读取。')
    }
    const current = readDocument(previous)
    const changed = Object.entries(overrides).some(([key, value]) => current[key] !== value)
    if (!changed) return { snapshot: await load(), changed: false }

    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete doc[key]
      else doc[key] = value
    }

    await mkdir(base, { recursive: true })
    if (previous) await writeAtomically(backup, previous, assertUnchanged)
    await writeAtomically(file, `${JSON.stringify(doc, null, 2)}\n`, assertUnchanged)
    return { snapshot: await load(), changed: true, backup: previous ? backup : null }
  }

  return { load, save }
}
