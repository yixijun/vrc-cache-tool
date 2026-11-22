<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import DiagnosticsPanel from './DiagnosticsPanel.vue'
import { callHost } from './bridge.js'

const empty = { directory: '', size: '', expiry: '' }
const form = reactive({ ...empty })
const snapshot = ref(null)
const running = ref('')
const notice = ref(null)
const report = ref(null)
const testedForm = ref('')
const directoryInput = ref(null)
const signature = computed(() => JSON.stringify(form))
const dirty = computed(() => snapshot.value && signature.value !== JSON.stringify(snapshot.value.form))
const blocked = computed(() => !snapshot.value || snapshot.value.blocked)
const needsSave = computed(() => dirty.value || snapshot.value?.warning)
const stale = computed(() => Boolean(report.value && signature.value !== testedForm.value))

async function perform(operation, work) {
  if (running.value) return
  running.value = operation
  notice.value = null
  try { await work() } catch (error) {
    notice.value = { type: 'error', text: error.message }
  } finally { running.value = '' }
}

async function call(method, ...args) {
  const reply = await callHost(method, ...args)
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}

function update(snapshotValue) {
  snapshot.value = snapshotValue
  Object.assign(form, snapshotValue.form)
}

function reload(ask = true) {
  if (ask && dirty.value && !window.confirm('重新读取会丢弃表单中尚未应用的修改。继续吗？')) return
  return perform('load', async () => {
    update(await call('load'))
    if (ask && !snapshot.value.warning) notice.value = { type: 'ok', text: '已重新读取配置。' }
  })
}

function restoreDefaults() {
  Object.assign(form, empty)
  notice.value = { type: 'info', text: '已填入官方默认值。点击「应用设置」写入配置。' }
}

function save() {
  return perform('save', async () => {
    const { snapshot: saved, changed, backup } = await call('save', { ...form }, snapshot.value.revision)
    const sameTest = !stale.value
    update(saved)
    if (sameTest) testedForm.value = signature.value
    notice.value = {
      type: 'ok',
      text: changed
        ? `已保存${backup ? '并备份原配置' : ''}。重启 VRChat 后生效。`
        : '配置已是当前设置。',
    }
  })
}

function test() {
  return perform('test', async () => {
    report.value = await call('diagnose', { ...form })
    testedForm.value = signature.value
  })
}

function choose() {
  return perform('pick', async () => {
    const selected = await call('pickDirectory', form.directory)
    if (selected !== null) form.directory = selected
    directoryInput.value?.focus()
  })
}

function open(method, ...args) {
  return perform('open', () => call(method, ...args))
}

onMounted(() => reload(false))
</script>

<template>
  <main class="workspace">
    <header class="intro">
      <div class="intro-main">
        <span class="app-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <div><h1>缓存管理</h1><p>设置 VRChat PC 版的下载缓存并检查本机存储。</p></div>
      </div>
      <button class="quiet docs" type="button" :disabled="!!running" @click="open('openDocs')">官方文档 <span aria-hidden="true">↗</span></button>
    </header>

    <div v-if="snapshot?.warning" class="banner" :class="snapshot.blocked ? 'error' : 'warn'" role="status">
      {{ snapshot.warning }}
    </div>

    <div class="columns">
      <section class="card settings" aria-labelledby="settings-heading">
        <header class="card-header">
          <h2 id="settings-heading">缓存设置</h2>
          <button class="quiet" type="button" :disabled="!!running" @click="reload()">重新读取</button>
        </header>

        <form class="settings-form" @submit.prevent="save">
          <fieldset :disabled="!!running || blocked">
            <div class="field">
              <label for="directory">缓存目录</label>
              <div class="path-control">
                <input id="directory" ref="directoryInput" v-model="form.directory" type="text" spellcheck="false" autocomplete="off" :placeholder="snapshot?.base || 'VRChat 默认目录'" aria-describedby="directory-help" @input="notice = null" />
                <button class="secondary" type="button" @click="choose">浏览…</button>
              </div>
              <p id="directory-help">留空使用 VRChat 默认目录。下载内容存放于 Cache-WindowsPlayer 子目录。</p>
            </div>

            <div class="numeric-fields">
              <div class="field">
                <label for="size">缓存上限</label>
                <div class="number-control"><input id="size" v-model="form.size" type="text" inputmode="numeric" autocomplete="off" placeholder="30" aria-describedby="number-help" @input="notice = null" /><span>GB</span></div>
              </div>
              <div class="field">
                <label for="expiry">过期时间</label>
                <div class="number-control"><input id="expiry" v-model="form.expiry" type="text" inputmode="numeric" autocomplete="off" placeholder="30" aria-describedby="number-help" @input="notice = null" /><span>天</span></div>
              </div>
              <p id="number-help">两项留空均使用默认值 30。过期时间从文件上次访问起算。</p>
            </div>
          </fieldset>

          <footer class="form-footer">
            <button class="quiet" type="button" :disabled="!!running || blocked || (!needsSave && !Object.values(form).some(Boolean))" @click="restoreDefaults">恢复默认</button>
            <button class="primary" type="submit" :disabled="!!running || blocked || !needsSave">{{ running === 'save' ? '正在保存…' : '应用设置' }}</button>
          </footer>
        </form>
      </section>

      <section class="card diagnostics" aria-labelledby="diagnostics-heading">
        <header class="card-header">
          <h2 id="diagnostics-heading">存储检测</h2>
          <button class="secondary accent" type="button" :disabled="!!running || !snapshot" @click="test">
            {{ running === 'test' ? '检测中…' : '运行检测' }}
          </button>
        </header>
        <DiagnosticsPanel :report="report" :stale="stale" :running="running === 'test'" />
        <footer class="diagnostics-footer">
          <button class="quiet" type="button" :disabled="!!running || !snapshot" @click="open('openCache', form.directory)">打开缓存文件夹 <span aria-hidden="true">↗</span></button>
        </footer>
      </section>
    </div>

    <footer class="workspace-footer">
      <div class="config-location">
        <button class="quiet" type="button" :disabled="!!running || !snapshot" @click="open('openConfig')">配置位置 <span aria-hidden="true">↗</span></button>
        <code :title="snapshot?.file">{{ snapshot?.file || '正在查找 config.json…' }}</code>
      </div>
      <p v-if="notice" class="status" :class="notice.type" role="status">{{ notice.text }}</p>
      <p v-else class="status" :class="dirty ? 'warn' : ''" role="status">
        {{ dirty ? '有未应用的修改' : '应用设置后，重启 VRChat 生效' }}
      </p>
    </footer>
  </main>
</template>
