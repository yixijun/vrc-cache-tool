import { createPackage } from '@electron/asar'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('要构建此发布包，请使用 Windows x64 上的 Node.js。')
}

const root = await realpath(path.dirname(import.meta.dirname))
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)
const electronRoot = path.dirname(require('electron'))
const locales = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak'])
const release = path.join(root, 'release')
const output = path.join(release, 'VRChatCacheTool-win-x64')
const iconPath = path.join(root, 'assets', 'icon.ico')
await mkdir(release, { recursive: true })
if (await realpath(release) !== release) throw new Error('release 须为项目下的普通目录。')
const staging = await mkdtemp(path.join(release, '.build-'))

try {
  const app = path.join(staging, 'app')
  const runtime = path.join(staging, 'runtime')
  await mkdir(app)
  await Promise.all([
    cp(electronRoot, runtime, {
      recursive: true,
      filter: source => {
        const relative = path.relative(electronRoot, source)
        return path.dirname(relative) !== 'locales' || path.extname(relative) !== '.pak' || locales.has(path.basename(relative))
      },
    }),
    cp(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true }),
    cp(path.join(root, 'electron'), path.join(app, 'electron'), { recursive: true }),
    writeFile(path.join(app, 'package.json'), JSON.stringify({
      name: manifest.name, productName: manifest.productName, version: manifest.version,
      type: manifest.type, main: manifest.main,
    })),
  ])
  await createPackage(app, path.join(runtime, 'resources', 'app.asar'))
  await rm(path.join(runtime, 'resources', 'default_app.asar'), { force: true })
  const originalExe = path.join(runtime, 'electron.exe')
  const executable = NtExecutable.from(await readFile(originalExe))
  const resources = NtExecutableResource.from(executable)
  const [group, ...otherGroups] = Resource.IconGroupEntry.fromEntries(resources.entries)
  if (!group || otherGroups.length) throw new Error('无法识别 Electron 的 EXE 图标资源。')
  const logo = Data.IconFile.from(await readFile(iconPath))
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries, group.id, group.lang, logo.icons.map(({ data }) => data),
  )
  resources.outputResource(executable)
  await writeFile(path.join(runtime, 'VRChatCacheTool.exe'), new Uint8Array(executable.generate()))
  await rm(originalExe)
  await cp(iconPath, path.join(runtime, 'resources', 'icon.ico'))
  await cp(path.join(root, 'README.md'), path.join(runtime, 'README.md'))
  const licensePackages = ['vue', 'react', 'react-dom', 'scheduler']
  const licenses = await Promise.all(licensePackages.map(async name => {
    const license = await readFile(path.join(root, 'node_modules', name, 'LICENSE'), 'utf8')
    return `${name}\n\n${license.trim()}\n`
  }))
  await writeFile(path.join(runtime, 'LICENSES.frontend.txt'), licenses.join('\n'))
  const existing = await realpath(output).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return output
  })
  if (existing !== output) throw new Error('便携版输出路径须为 release 下的普通目录。')
  await rm(output, { recursive: true, force: true })
  await rename(runtime, output)
  console.log(`便携版输出：${output}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
