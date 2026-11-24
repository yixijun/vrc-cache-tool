// VRChat 缓存管理 · 前端（零依赖原生 ES 模块）
// 与 C# 宿主之间沿用原协议：postMessage {id, method, arguments} -> {id, ok, value|error}
// 可选方法：load / save / diagnose / pickDirectory / openCache / openConfig / openDocs

const host = window.chrome?.webview;
const pending = new Map();
let sequence = 0;

host?.addEventListener('message', ({ data }) => {
  const resolve = pending.get(data?.id);
  if (!resolve) return;
  pending.delete(data.id);
  resolve(data);
});

function callHost(method, ...args) {
  if (!host) return Promise.reject(new Error('请从 Windows 程序打开此工具。'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, resolve);
    try {
      host.postMessage({ id, method, arguments: args });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

async function call(method, ...args) {
  const reply = await callHost(method, ...args);
  if (!reply || reply.ok !== true) throw new Error(reply?.error || '宿主没有返回结果');
  return reply.value;
}

// ---------------------------------------------------------------- 状态

const state = {
  snapshot: null,
  form: { directory: '', size: '', expiry: '' },
  running: '',
  report: null,
  testedSignature: '',
  noticeTimer: 0,
};

const NAMES = ['配置参数', '目录读写', '磁盘可用空间', '内容缓存占用'];
const LABELS = { ok: '通过', warn: '注意', error: '失败', idle: '待检测', busy: '检测中' };
const ICONS = { ok: '✓', warn: '!', error: '×', idle: '·', busy: '…' };

const $ = (id) => document.getElementById(id);
const signature = () => JSON.stringify([state.form.directory, state.form.size, state.form.expiry]);
const dirty = () => Boolean(state.snapshot) && signature() !== JSON.stringify([
  state.snapshot.form.directory, state.snapshot.form.size, state.snapshot.form.expiry,
]);
const blocked = () => !state.snapshot || state.snapshot.blocked === true;
const needsSave = () => dirty() || Boolean(state.snapshot?.warning);
const stale = () => Boolean(state.report) && signature() !== state.testedSignature;

// ---------------------------------------------------------------- 格式化

const numberFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function bytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1);
  return `${numberFmt.format(value / 1000 ** index)} ${units[index]}`;
}

// ---------------------------------------------------------------- 渲染

function renderStatus() {
  const pill = $('dirty');
  const busy = state.running;
  let text = '已同步';
  let kind = 'clean';

  if (busy === 'load') { text = '读取中'; kind = 'busy'; }
  else if (busy === 'save') { text = '保存中'; kind = 'busy'; }
  else if (busy === 'test') { text = '检测中'; kind = 'busy'; }
  else if (blocked()) { text = '配置异常'; kind = 'blocked'; }
  else if (dirty()) { text = '有改动尚未保存'; kind = 'dirty'; }

  pill.textContent = text;
  pill.dataset.state = kind;

  const snapshot = state.snapshot;
  $('cfg-path').textContent = snapshot?.file || '正在定位 config.json…';
  $('cfg-path').title = snapshot?.file || '';
  $('note').textContent = dirty()
    ? '改动尚未写入，点「应用设置」才会生效。'
    : '设置只会写入上面那份 config.json，其它键原样保留。';

  document.body.dataset.busy = busy ? '1' : '0';

  const banner = $('banner');
  const warning = snapshot?.warning;
  if (warning) {
    banner.hidden = false;
    banner.dataset.kind = snapshot.blocked ? 'error' : 'warn';
    $('banner-text').textContent = warning;
  } else {
    banner.hidden = true;
  }
}

function renderForm() {
  const { directory, size, expiry } = state.form;
  if ($('directory').value !== directory) $('directory').value = directory;
  if ($('size').value !== size) $('size').value = size;
  if ($('expiry').value !== expiry) $('expiry').value = expiry;

  const busy = Boolean(state.running);
  const lock = busy || blocked();
  for (const id of ['directory', 'size', 'expiry']) $(id).disabled = lock;

  const apply = $('apply');
  apply.disabled = lock || !needsSave();
  apply.dataset.busy = state.running === 'save' ? '1' : '0';
  apply.querySelector('.btn__label').textContent = state.running === 'save' ? '正在保存…' : '应用设置';

  const test = $('test');
  test.disabled = busy || !state.snapshot;
  test.dataset.busy = state.running === 'test' ? '1' : '0';
  test.querySelector('.btn__label').textContent = state.running === 'test' ? '检测中…' : '运行检测';

  document.querySelector('[data-act="reload"]').disabled = busy;
  document.querySelector('[data-act="reset"]').disabled = lock || (!needsSave() && !Object.values(state.form).some(Boolean));
  document.querySelector('[data-act="pick"]').disabled = lock;
  document.querySelector('[data-act="cache"]').disabled = busy || !state.snapshot;
  document.querySelector('[data-act="config"]').disabled = busy || !state.snapshot;
}

function renderReport() {
  const lead = $('diag-lead');
  if (state.running === 'test') lead.textContent = '正在检查当前表单…';
  else if (stale()) lead.textContent = '表单已修改，重新检测可更新结果。';
  else if (state.report) lead.textContent = '检测基于表单中的设置。';
  else lead.textContent = '还没有检测结果，点右上角开始体检。';

  const list = $('checks');
  const rows = state.report?.rows || [];
  const running = state.running === 'test';

  list.replaceChildren(...NAMES.map((name) => {
    const row = rows.find((item) => item.name === name);
    const status = running ? 'busy' : (row?.state || 'idle');

    const li = document.createElement('li');
    li.className = 'check';
    li.dataset.state = status;

    const icon = document.createElement('span');
    icon.className = 'check__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ICONS[status] || ICONS.idle;

    const body = document.createElement('div');
    body.className = 'check__body';

    const head = document.createElement('div');
    head.className = 'check__name';
    head.textContent = name;
    const stateText = document.createElement('span');
    stateText.className = 'check__state';
    stateText.textContent = LABELS[status] || '';
    head.append(stateText);
    body.append(head);

    if (row?.free !== undefined && Number.isFinite(row.free)) {
      const metric = document.createElement('p');
      metric.className = 'check__metric';
      metric.append(`${bytes(row.free)} 可用 `);
      if (row.total) {
        const total = document.createElement('span');
        total.textContent = `/ 共 ${bytes(row.total)}`;
        metric.append(total);
      }
      body.append(metric);
    }

    if (row?.bytes !== undefined) {
      const metric = document.createElement('p');
      metric.className = 'check__metric';
      metric.append(bytes(row.bytes));
      if (row.files !== undefined) {
        const files = document.createElement('span');
        files.textContent = ` · ${numberFmt.format(row.files)} 个文件`;
        metric.append(files);
      }
      body.append(metric);
    }

    if (row?.newest > 0) {
      const newest = document.createElement('p');
      newest.className = 'check__detail';
      newest.textContent = `最近修改 ${dateFmt.format(row.newest)}`;
      body.append(newest);
    }

    if (row?.detail) {
      const detail = document.createElement('p');
      detail.className = 'check__detail';
      detail.textContent = row.detail;
      body.append(detail);
    }

    if (row?.path) {
      const path = document.createElement('code');
      path.className = 'check__path';
      path.textContent = row.path;
      path.title = row.path;
      body.append(path);
    }

    li.append(icon, body);
    return li;
  }));

  $('target').textContent = state.report?.target || '';
  $('target').title = state.report?.target || '';

  renderUsage();
}

function renderUsage() {
  const box = $('usage');
  const rows = state.report?.rows || [];
  const cacheRow = rows.find((item) => item.name === '内容缓存占用');
  const diskRow = rows.find((item) => item.name === '磁盘可用空间');
  const running = state.running === 'test';

  box.dataset.busy = running ? '1' : '0';

  const cached = Number(cacheRow?.bytes ?? 0);
  const free = Number(diskRow?.free ?? 0);
  const total = cached + free;

  if (state.running === 'test') {
    box.dataset.state = 'busy';
    $('usage-value').textContent = '检测中…';
    return;
  }

  if (!state.report || (cached === 0 && free === 0)) {
    box.dataset.state = 'empty';
    $('usage-value').textContent = state.report ? '暂无可比较的数据' : '运行检测后可查看';
    $('usage-cache').style.width = '0%';
    $('usage-free').style.width = '0%';
    $('usage-cache-text').textContent = '—';
    $('usage-free-text').textContent = '—';
    return;
  }

  box.dataset.state = 'ready';
  const cacheShare = total > 0 ? (cached / total) * 100 : 0;
  $('usage-cache').style.width = `${Math.max(cacheShare, cached > 0 ? 1.5 : 0).toFixed(2)}%`;
  $('usage-free').style.width = `${Math.max(100 - cacheShare, free > 0 ? 1.5 : 0).toFixed(2)}%`;
  $('usage-cache-text').textContent = bytes(cached);
  $('usage-free-text').textContent = bytes(free);
  $('usage-value').textContent = `缓存 ${bytes(cached)} · 可用 ${bytes(free)}`;
}

function render() {
  renderStatus();
  renderForm();
  renderReport();
}

// ---------------------------------------------------------------- 吐司

function toast(text, kind = 'ok', duration = 3200) {
  const box = $('toast');
  if (!text) { box.hidden = true; return; }
  box.textContent = text;
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => { box.hidden = true; }, duration);
}

// ---------------------------------------------------------------- 操作

async function perform(operation, work) {
  if (state.running) return;
  state.running = operation;
  render();
  try {
    await work();
  } catch (error) {
    toast(error?.message || String(error), 'error', 6000);
  } finally {
    state.running = '';
    render();
  }
}

function adopt(snapshot) {
  state.snapshot = snapshot;
  const form = snapshot?.form || {};
  state.form = {
    directory: form.directory ?? '',
    size: form.size ?? '',
    expiry: form.expiry ?? '',
  };
}

function reload(ask = true) {
  if (ask && dirty() && !window.confirm('重新读取会丢弃尚未保存的改动，继续吗？')) return Promise.resolve();
  return perform('load', async () => {
    adopt(await call('load'));
    if (ask && !state.snapshot?.warning) toast('已重新读取 config.json');
  });
}

function save() {
  return perform('save', async () => {
    const before = signature();
    const result = await call('save', { ...state.form }, state.snapshot?.revision ?? null);
    const sameTest = !stale();
    adopt(result.snapshot);
    if (sameTest) state.testedSignature = before;
    toast(
      result.changed
        ? `已保存${result.backup ? '并备份原配置' : ''}，重启 VRChat 后生效`
        : '配置已经是当前设置，无需写入',
      'ok',
      4200,
    );
  });
}

function test() {
  return perform('test', async () => {
    const current = signature();
    state.report = await call('diagnose', { ...state.form });
    state.testedSignature = current;
  });
}

function choose() {
  return perform('pick', async () => {
    const selected = await call('pickDirectory', state.form.directory ?? '');
    if (typeof selected === 'string' && selected.length > 0) {
      state.form.directory = selected;
      $('directory').focus();
    }
  });
}

function restoreDefaults() {
  state.form = { directory: '', size: '', expiry: '' };
  toast('已填入官方默认值，点「应用设置」写入', 'warn', 4200);
  render();
}

// ---------------------------------------------------------------- 绑定

function bind() {
  $('form').addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });

  $('directory').addEventListener('input', (event) => {
    state.form.directory = event.target.value;
    render();
  });

  for (const [id, key] of [['size', 'size'], ['expiry', 'expiry']]) {
    const input = $(id);
    input.addEventListener('input', (event) => {
      const cleaned = event.target.value.replace(/[^\d]/g, '');
      if (cleaned !== event.target.value) event.target.value = cleaned;
      state.form[key] = cleaned;
      render();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!needsSave() || blocked() || state.running) return;
        save();
      }
    });
  }

  $('directory').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const button = document.querySelector('[data-act="pick"]');
    if (!button.disabled) choose();
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button || button.disabled) return;
    switch (button.dataset.act) {
      case 'docs': perform('open', () => call('openDocs')); break;
      case 'reload': reload(); break;
      case 'pick': choose(); break;
      case 'reset': restoreDefaults(); break;
      case 'test': test(); break;
      case 'cache': perform('open', () => call('openCache', state.form.directory ?? '')); break;
      case 'config': perform('open', () => call('openConfig')); break;
      case 'win-min': call('windowMinimize').catch(() => {}); break;
      case 'win-max': call('windowMaximize').then(setMaximized).catch(() => {}); break;
      case 'win-close': call('windowClose').catch(() => {}); break;
      default: break;
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'F5' || (event.ctrlKey && event.key.toLowerCase() === 'r')) {
      event.preventDefault();
      reload();
    }
  });
}

// 无边框窗口：标题区拖动、双击最大化、按钮图标随状态切换

function setMaximized(maximized) {
  const button = document.querySelector('[data-act="win-max"]');
  if (!button) return;
  button.classList.toggle('is-max', Boolean(maximized));
  button.title = maximized ? '还原' : '最大化';
  button.setAttribute('aria-label', button.title);
}

function bindWindowChrome() {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const interactive = (target) => Boolean(target.closest('.winbar, button, a, input, select, .el-select'));

  hero.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || interactive(event.target)) return;
    call('windowDrag').catch(() => {});
  });

  hero.addEventListener('dblclick', (event) => {
    if (interactive(event.target)) return;
    call('windowMaximize').then(setMaximized).catch(() => {});
  });
}

// 背景随鼠标轻微视差（降低动效时不做）

function bindAurora() {
  const aurora = document.querySelector('.aurora');
  if (!aurora) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let frame = 0;
  let targetX = 0;
  let targetY = 0;

  window.addEventListener('pointermove', (event) => {
    targetX = (event.clientX / window.innerWidth - 0.5) * 2;
    targetY = (event.clientY / window.innerHeight - 0.5) * 2;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      aurora.style.setProperty('--px', targetX.toFixed(3));
      aurora.style.setProperty('--py', targetY.toFixed(3));
    });
  }, { passive: true });
}

// 启动序列：logo 在屏幕中央出现 → 飞回左上角 → UI 依次入场

function playBootSequence() {
  const body = document.body;
  const mark = document.querySelector('.mark');

  const finish = () => {
    body.classList.remove('booting');
    body.classList.add('booted');
  };

  // 兜底：任何情况下 4.2 秒后都要显示界面
  const failsafe = setTimeout(finish, 4200);

  if (!mark || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    clearTimeout(failsafe);
    finish();
    return;
  }

  const FADE = 320;   // 中心放大淡入
  const HOLD = 560;   // 中心停留
  const FLY = 640;    // 飞回左上角

  const ghost = mark.cloneNode(true);
  ghost.classList.add('boot-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.transform = 'translate(-50%, -50%) scale(1.9)';
  ghost.style.opacity = '0';
  body.appendChild(ghost);

  // 阶段一：放大淡入
  requestAnimationFrame(() => {
    ghost.style.transition = 'transform ' + FADE + 'ms cubic-bezier(0.22, 1, 0.36, 1), opacity ' + FADE + 'ms ease-out';
    ghost.style.transform = 'translate(-50%, -50%) scale(2.35)';
    ghost.style.opacity = '1';
  });

  // 阶段二：停留结束后重新测量真实图标位置，再飞回去
  //（首帧布局可能因字体/行高微调而变化，必须用飞行前的最新位置）
  setTimeout(() => {
    const home = mark.getBoundingClientRect();
    const dx = (home.left + home.width / 2) - window.innerWidth / 2;
    const dy = (home.top + home.height / 2) - window.innerHeight / 2;

    ghost.style.transition = 'transform ' + FLY + 'ms cubic-bezier(0.16, 1, 0.3, 1)';
    ghost.style.transform =
      'translate(calc(-50% + ' + dx.toFixed(1) + 'px), calc(-50% + ' + dy.toFixed(1) + 'px)) scale(1)';

    setTimeout(() => {
      // 先让真实图标出现，隔一帧再移除替身，保证衔接无缝
      clearTimeout(failsafe);
      finish();
      requestAnimationFrame(() => ghost.remove());
    }, FLY + 30);
  }, FADE + HOLD);
}

try {
  playBootSequence();
} catch (error) {
  document.body.classList.remove('booting');
  document.body.classList.add('booted');
}
bindAurora();
bindWindowChrome();
bind();
render();
reload(false);
