const icons = { ok: '✓', warn: '!', error: '×', idle: '·' }
const labels = { ok: '通过', warn: '注意', error: '失败', idle: '待检测' }
const names = ['配置参数', '目录读写', '磁盘可用空间', '内容缓存占用']
const formatNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const formatDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

function bytes(value) {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1)
  return `${formatNumber.format(value / 1000 ** index)} ${units[index]}`
}

export default function Report({ report, stale, running }) {
  const summary = running ? '正在检查当前表单…'
    : stale ? '表单已修改，重新检测可更新结果。'
    : report ? '检测使用表单中的设置。' : '检测目录读写、可用空间和内容缓存占用。'

  return <div className="results" aria-busy={running} aria-live="polite">
    <p className={stale && !running ? 'result-summary warn' : 'result-summary'}>{summary}</p>
    <ul className="result-list">
      {names.map(name => {
        const row = report?.rows.find(item => item.name === name)
        const state = row?.state ?? 'idle'
        return <li key={name} className="result-item">
          <span className={`result-icon ${state}`} role="img" aria-label={labels[state]}>{icons[state]}</span>
          <div className="result-copy">
            <h3>{name}</h3>
            {row?.free !== undefined && <p className="metric">{bytes(row.free)} 可用 <span>／ {bytes(row.total)}</span></p>}
            {row?.bytes !== undefined && <p className="metric">{bytes(row.bytes)} <span>· {row.files.toLocaleString('zh-CN')} 个文件</span></p>}
            {row?.newest > 0 && <p>最近修改 {formatDate.format(row.newest)}</p>}
            {row?.detail && <p>{row.detail}</p>}
            {row?.path && <code className="result-path" title={row.path}>{row.path}</code>}
          </div>
        </li>
      })}
    </ul>
    {report?.target && <code className="target-path" title={report.target}>{report.target}</code>}
  </div>
}
