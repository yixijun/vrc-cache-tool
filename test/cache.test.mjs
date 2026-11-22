import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createConfigStore } from '../electron/config.mjs'
import { diagnose } from '../electron/diagnostics.mjs'
import { assetFolder, defaults, validate } from '../electron/settings.mjs'

async function directoryFor(test) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vrchat-cache-tool-'))
  test.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('official defaults, valid Windows paths and numeric bounds', () => {
  const base = 'C:\\default'
  const settings = validate(defaults, base)
  assert.equal(settings.directory, base)
  assert.equal(settings.size, 30)
  assert.equal(settings.expiry, 30)
  const form = { directory: 'D:\\我的缓存', size: '64', expiry: '90' }
  assert.deepEqual(validate(form, base).overrides, {
    cache_directory: 'D:/我的缓存', cache_size: 64, cache_expiry_delay: 90,
  })
  assert.equal(validate({ ...defaults, directory: '\\\\nas\\games\\缓存' }, base).directory, '\\\\nas\\games\\缓存')
  for (const directory of ['relative', 'D:cache', 'D:\\bad?', 'D:\\CON.txt', 'D:\\stream:name']) {
    assert.throws(() => validate({ ...defaults, directory }, base), /绝对路径/)
  }
  assert.throws(() => validate({ ...form, size: '29' }, base), /缓存上限/)
  assert.throws(() => validate({ ...form, expiry: '31.5' }, base), /过期时间/)
})

test('save backs up exact bytes, preserves unrelated settings and restores defaults', async test => {
  const base = await directoryFor(test)
  const store = createConfigStore(base)
  const file = path.join(base, 'config.json')
  const original = Buffer.from('\uFEFF{"disableRichPresence":true,"extra":{"n":9007199254740993},"cache_size":45}', 'utf16le')
  await writeFile(file, original)
  let snapshot = await store.load()
  assert.equal(snapshot.form.size, '45')

  const first = await store.save({ directory: 'D:\\下载缓存', size: '80', expiry: '75' }, snapshot.revision)
  assert.equal(first.changed, true)
  assert.deepEqual(await readFile(first.backup), original)
  const saved = await readFile(file, 'utf8')
  assert.match(saved, /9007199254740993/)
  assert.deepEqual(JSON.parse(saved), {
    disableRichPresence: true, extra: { n: 9007199254740992 },
    cache_directory: 'D:/下载缓存', cache_size: 80, cache_expiry_delay: 75,
  })

  snapshot = (await store.save(defaults, first.snapshot.revision)).snapshot
  assert.deepEqual(snapshot.form, defaults)
  assert.doesNotMatch(await readFile(file, 'utf8'), /"cache_/)
  assert.match(await readFile(file, 'utf8'), /9007199254740993/)
  assert.equal(await readFile(first.backup, 'utf8'), saved)
  assert.deepEqual((await readdir(base)).sort(), ['config.json', 'config.json.vrchat-cache-tool.bak'])
})

test('first save is optional, and external changes or broken JSON block overwrites', async test => {
  const base = await directoryFor(test)
  const store = createConfigStore(base)
  const file = path.join(base, 'config.json')
  const blank = await store.load()
  assert.equal(blank.exists, false)
  assert.equal((await store.save(defaults, blank.revision)).changed, false)
  assert.deepEqual(await readdir(base), [])
  const first = await store.save({ ...defaults, size: '40' }, blank.revision)
  assert.equal(first.backup, null)
  await writeFile(file, '{"cache_size":85}')
  await assert.rejects(() => store.save(defaults, first.snapshot.revision), /其他地方修改/)
  assert.equal(await readFile(file, 'utf8'), '{"cache_size":85}')
  await writeFile(file, '{broken')
  assert.equal((await store.load()).blocked, true)
  assert.equal(await readFile(file, 'utf8'), '{broken')
})

test('diagnostics scan content only and remove the probe', async test => {
  const base = await directoryFor(test)
  const target = path.join(base, assetFolder)
  const empty = await diagnose(defaults, base)
  assert.equal(empty.rows[1].state, 'warn')
  assert.equal(empty.rows[3].state, 'idle')
  assert.deepEqual(await readdir(base), [])

  await mkdir(target)
  await writeFile(path.join(target, 'asset'), Buffer.alloc(1048))
  const full = await diagnose(defaults, base)
  assert.equal(full.rows[1].state, 'ok')
  assert.equal(full.rows[3].files, 1)
  assert.equal(full.rows[3].bytes, 1048)
  assert.ok(full.rows[2].total >= full.rows[2].free)
  assert.deepEqual(await readdir(target), ['asset'])
})

test('diagnostics refuse a content directory that redirects through a junction', async test => {
  const base = await directoryFor(test)
  const destination = path.join(base, 'destination')
  await mkdir(destination)
  const link = path.join(base, assetFolder)
  await symlink(destination, link, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await diagnose(defaults, base)
  assert.equal(result.rows[1].state, 'error')
  assert.match(result.rows[1].detail, /链接或目录联接/)
  assert.deepEqual(await readdir(destination), [])
})
