const host = window.chrome?.webview
const pending = new Map()
let sequence = 0

host?.addEventListener('message', ({ data }) => {
  pending.get(data.id)?.(data)
  pending.delete(data.id)
})

export function callHost(method, ...args) {
  if (!host) return Promise.reject(new Error('请从 Windows 程序打开此工具。'))
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, resolve)
    try { host.postMessage({ id, method, arguments: args }) } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}
