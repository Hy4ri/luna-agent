<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
const props = defineProps<{ title: string; description?: string; status?: string; timing?: string }>()
function onSummaryClick(event: MouseEvent) {
  const summary = event.currentTarget as HTMLElement
  const details = summary.parentElement as HTMLDetailsElement | null
  const body = details?.parentElement
  if (!details || !body || window.innerWidth <= 960) return
  if (!details.open) {
    for (const peer of body.querySelectorAll<HTMLDetailsElement>(':scope > details.settings-card[open]')) {
      if (peer !== details) peer.open = false
    }
  }
}
</script>
<template>
  <details class="settings-card">
    <summary @click="onSummaryClick">
      <div class="group-heading">
        <div class="group-top">
          <span class="group-title">{{ title }}</span>
          <ChevronRight :size="15" class="group-chevron" />
        </div>
        <span v-if="status" class="group-status">{{ status }}</span>
        <span v-if="timing" class="group-timing">{{ timing }}</span>
      </div>
    </summary>
    <div class="group-content">
      <header class="detail-header">
        <div v-if="timing" class="detail-eyebrow">{{ timing }}</div>
        <h3 class="detail-title">{{ title }}</h3>
        <p v-if="description" class="group-description">{{ description }}</p>
      </header>
      <div class="detail-fields">
        <slot />
      </div>
    </div>
  </details>
</template>
<style scoped>
.settings-card {
  min-width: 0;
  align-self: start;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  overflow: clip;
}
summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  transition: border-color 0.12s, background 0.12s;
  user-select: none;
}
summary::-webkit-details-marker { display: none; }
summary:hover { background: var(--accent); }
details[open] > summary {
  border-color: var(--primary);
  background: var(--accent);
}
.group-heading {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.group-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.group-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}
.group-chevron {
  flex-shrink: 0;
  color: var(--muted-foreground);
  transition: transform 0.15s, color 0.15s;
}
details[open] > summary .group-chevron {
  color: var(--primary-text);
}
.group-status {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--primary-text);
  overflow-wrap: anywhere;
}
.group-timing {
  font-size: 11.5px;
  color: var(--muted-foreground);
}
.group-content {
  display: grid;
  gap: 20px;
  padding: 24px 28px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card);
  min-width: 0;
}
.detail-header {
  display: grid;
  gap: 4px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.detail-eyebrow {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--primary-text);
}
.detail-title {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--foreground);
}
.group-description {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--muted-foreground);
}
.detail-fields {
  display: grid;
  gap: 18px;
  min-width: 0;
}

@media (min-width: 961px) {
  .settings-card,
  .settings-card[open]::details-content {
    display: contents;
  }
  summary {
    grid-column: 1;
  }
  .group-content {
    grid-column: 2;
    max-width: 680px;
  }
}

@media (max-width: 960px) {
  summary {
    border: 0;
    border-radius: 0;
  }
  details[open] > summary .group-chevron {
    transform: rotate(90deg);
  }
  .group-content {
    border: 0;
    border-top: 1px solid var(--border);
    border-radius: 0;
    padding: 16px;
  }
  .detail-header {
    display: none;
  }
}
</style>
