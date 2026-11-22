<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import Report from './Report.jsx'

const props = defineProps({ report: Object, stale: Boolean, running: Boolean })
const host = ref(null)
let root
function render() {
  root?.render(createElement(Report, { report: props.report, stale: props.stale, running: props.running }))
}
onMounted(() => { root = createRoot(host.value); render() })
watch(props, render)
onBeforeUnmount(() => root?.unmount())
</script>

<template><div ref="host" class="results-host"></div></template>
