<template>
  <div id="analytics-screen" class="flex-1 min-w-0 min-h-0 overflow-auto p-[30px] [padding-inline:max(24px,calc((100%-1180px)/2))] [overflow-wrap:anywhere]" :aria-busy="busy ? 'true' : 'false'">
    <header class="flex items-center gap-3 flex-wrap mb-[26px] max-w-[1180px] mx-auto">
      <Button id="analytics-menu" type="button" variant="ghost" size="icon" class="hidden max-[760px]:inline-flex h-9 w-9 text-muted-foreground hover:text-foreground" aria-label="Open navigation" aria-controls="side" @click="setDrawer(true)">
        <Menu :size="18" />
      </Button>
      <div class="flex-1 a-heading">
        <div class="eyebrow text-xs uppercase tracking-wider text-muted-foreground">Workspace / Usage</div>
        <h1 tabindex="-1" class="m-0 text-[24px] font-semibold tracking-tight leading-[1.3]">Analytics</h1>
        <p class="m-0 text-[14px] text-muted-foreground">Model usage, token flow, and recorded cost.</p>
      </div>
      <button type="button" class="icon-button" aria-label="Close analytics" @click="navigate('chat')"><X :size="18" /></button>
    </header>

    <div class="flex items-end gap-3 flex-wrap pb-5 max-w-[1180px] mx-auto">
      <label class="grid gap-[5px] text-xs text-muted-foreground">
        Model
        <select
          v-model="selected"
          aria-label="Analytics model"
          class="max-w-full w-[min(260px,100%)] min-w-0 h-9 px-3 text-sm text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All models</option>
          <option v-for="m in snapshot?.models || []" :key="m.key" :value="m.key">
            {{ m.model }} · {{ m.provider }}
          </option>
        </select>
      </label>
      <Button type="button" variant="outline" class="h-9 px-4 text-xs font-medium text-foreground bg-card border-border hover:bg-accent" :disabled="refreshing" @click="load">Refresh</Button>
      <span class="text-muted-foreground text-xs ml-auto self-center a-updated">{{ updatedText }}</span>
    </div>

    <p class="a-status max-w-[1180px] mx-auto mb-4 text-[14px]" :class="{ 'error': statusIsError }" role="status" aria-live="polite">{{ statusText }}</p>

    <div data-analytics-content class="max-w-[1180px] mx-auto">
      <template v-if="snapshot">
        <!-- KPIs -->
        <div class="grid grid-cols-4 max-[1100px]:grid-cols-2 gap-3 my-[12px] mb-[22px]">
          <div class="border border-border rounded-[var(--radius)] p-[18px] max-[760px]:p-[14px] bg-card a-kpi">
            <span class="eyebrow text-xs uppercase tracking-wider text-muted-foreground">Total tokens</span>
            <strong class="block my-[7px] text-[30px] max-[1700px]:text-[34px] max-[760px]:text-[25px] font-medium leading-[1.25] tracking-tight tabular-nums a-value" :title="full(activeUsage.totalTokens)">{{ compact(activeUsage.totalTokens) }}</strong>
            <small class="text-muted-foreground text-xs block">{{ activeSelectedModel ? full(activeSelectedModel.responses) + ' observed responses' : full(responsesCount) + ' observed responses' }}</small>
          </div>
          <div class="border border-border rounded-[var(--radius)] p-[18px] max-[760px]:p-[14px] bg-card a-kpi">
            <span class="eyebrow text-xs uppercase tracking-wider text-muted-foreground">Recorded cost · USD</span>
            <strong class="block my-[7px] text-[30px] max-[1700px]:text-[34px] max-[760px]:text-[25px] font-medium leading-[1.25] tracking-tight tabular-nums a-value">{{ usd(activeUsage.cost.total) }}</strong>
            <small class="text-muted-foreground text-xs block">Estimate, not an invoice</small>
          </div>
          <div class="border border-border rounded-[var(--radius)] p-[18px] max-[760px]:p-[14px] bg-card a-kpi">
            <span class="eyebrow text-xs uppercase tracking-wider text-muted-foreground">Cache hit rate</span>
            <strong class="block my-[7px] text-[30px] max-[1700px]:text-[34px] max-[760px]:text-[25px] font-medium leading-[1.25] tracking-tight tabular-nums a-value">{{ pct(activeUsage.cacheHitRate) }}</strong>
            <small class="text-muted-foreground text-xs block">{{ cacheTotal ? `${full(activeUsage.cacheRead)} / ${full(cacheTotal)} input tokens` : 'No input tokens recorded' }}</small>
          </div>
          <div class="border border-border rounded-[var(--radius)] p-[18px] max-[760px]:p-[14px] bg-card a-kpi">
            <span class="eyebrow text-xs uppercase tracking-wider text-muted-foreground">{{ selected ? 'Model sessions' : 'Retained sessions' }}</span>
            <strong class="block my-[7px] text-[30px] max-[1700px]:text-[34px] max-[760px]:text-[25px] font-medium leading-[1.25] tracking-tight tabular-nums a-value">{{ full(selected ? activeSelectedModel?.sessions : snapshot.sessions) }}</strong>
            <small class="text-muted-foreground text-xs block">{{ selected ? activeSelectedModel?.provider : `${full(snapshot.models.length)} models · includes subagents` }}</small>
          </div>
        </div>

        <template v-if="!snapshot.models.length">
          <p class="a-empty py-[26px] text-muted-foreground text-[14px]">No model usage recorded yet. Usage will appear after a model response.</p>
        </template>
        <template v-else>
          <!-- Grid 1: Timeline & Composition -->
          <div class="grid grid-cols-[1.45fr_1fr] max-[1100px]:grid-cols-1 gap-4 mb-[18px]">
            <!-- Daily token activity -->
            <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card">
              <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Daily token activity</h2>
              <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Last 30 active days · UTC · Dated assistant responses only; compaction attempts are not included.</p>

              <template v-if="!visibleTimeline.length">
                <p class="a-empty py-[26px] text-muted-foreground text-[14px]">No dated response history is available.</p>
              </template>
              <template v-else>
                <svg viewBox="0 0 640 235" class="w-full h-auto block overflow-visible mt-[18px] a-chart" role="img" aria-label="Daily token activity: stacked input, output, cache read and cache write tokens">
                  <g v-for="r in [0, 0.5, 1]" :key="r">
                    <line :x1="leftMargin" :y1="topMargin + chartHeight * (1 - r)" :x2="632" :y2="topMargin + chartHeight * (1 - r)" stroke="var(--border)" stroke-dasharray="3 5" />
                    <text :x="leftMargin - 9" :y="topMargin + chartHeight * (1 - r) + 4" text-anchor="end" class="fill-muted-foreground text-[12px] font-sans">{{ compact(maxTimeline * r) }}</text>
                  </g>
                  <g v-for="(day, index) in visibleTimeline" :key="day.date">
                    <title>{{ day.date }} UTC · {{ full(day.responses) }} responses&#10;{{ fields.map(([key, label]) => `${label}: ${full(day[key] as number)}`).join('\n') }}</title>
                    <rect
                      v-for="(f, i) in fields"
                      :key="f[0]"
                      :x="leftMargin + index * timelineStep + timelineStep * 0.17"
                      :y="getRectY(day, i)"
                      :width="timelineStep * 0.66"
                      :height="getRectSize(day, i)"
                      :fill="colors[i]"
                      rx="1"
                    />
                    <text
                      v-if="index === 0 || index === visibleTimeline.length - 1 || (visibleTimeline.length > 8 && index % Math.ceil(visibleTimeline.length / 5) === 0)"
                      :x="leftMargin + index * timelineStep + timelineStep / 2"
                      y="207"
                      text-anchor="middle"
                      class="fill-muted-foreground text-[12px] font-sans"
                    >{{ day.date.slice(5) }}</text>
                  </g>
                </svg>
                <div class="flex gap-[15px] flex-wrap text-xs text-muted-foreground mt-[16px] a-legend">
                  <span v-for="([_, label], i) in fields" :key="i" class="inline-flex gap-[7px] items-center">
                    <i class="w-[8px] h-[8px] inline-block rounded-[1px] shrink-0 a-dot" :style="`background:${colors[i]}`" aria-hidden="true"></i>
                    {{ label }}
                  </span>
                </div>
                <details class="mt-4">
                  <summary class="cursor-pointer text-foreground min-h-[36px]">View daily values</summary>
                  <div class="overflow-auto mt-4 a-scroll" tabindex="0" aria-label="Daily token values">
                    <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                      <caption class="text-muted-foreground text-left mb-2">Daily values (UTC)</caption>
                      <thead>
                        <tr>
                          <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Date</th>
                          <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Responses</th>
                          <th v-for="([_, label]) in fields" :key="label" scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">{{ label }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="d in visibleTimeline" :key="d.date" class="border-b border-border last:border-0">
                          <td class="p-3 text-left">{{ d.date }}</td>
                          <td class="p-3 text-right">{{ full(d.responses) }}</td>
                          <td v-for="([key]) in fields" :key="key" class="p-3 text-right">{{ full(d[key] as number) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </details>
              </template>
            </section>

            <!-- Token composition -->
            <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card">
              <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Token composition</h2>
              <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Input excludes cache reads and writes. Subsets are not counted twice.</p>

              <div class="h-4 rounded-[1px] overflow-hidden flex bg-secondary my-[22px] a-split" role="img" :aria-label="fields.map(([key, label]) => `${label}: ${full(activeUsage[key] as number)}`).join(', ')">
                <span
                  v-for="([key, label], i) in fields"
                  :key="key"
                  class="min-w-0"
                  :style="`width:${compositionSum ? (activeUsage[key] as number) / compositionSum * 100 : 0}%;background:${colors[i]}`"
                  :title="`${label}: ${full(activeUsage[key] as number)}`"
                ></span>
              </div>

              <div class="grid gap-[10px] a-breakdown">
                <div v-for="([key, label]) in fields" :key="key" class="flex gap-3 items-baseline text-[14px] a-stat-row">
                  <span class="flex-1 text-muted-foreground">{{ label }}</span>
                  <strong class="font-medium tabular-nums">{{ full(activeUsage[key] as number) }}</strong>
                </div>
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                  <span class="flex-1 text-muted-foreground">Reasoning · part of output</span>
                  <strong class="font-medium tabular-nums">{{ activeUsage.reasoning == null ? "Not reported" : full(activeUsage.reasoning) }}</strong>
                </div>
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                  <span class="flex-1 text-muted-foreground">1h writes · part of cache write</span>
                  <strong class="font-medium tabular-nums">{{ activeUsage.cacheWrite1h == null ? "Not reported" : full(activeUsage.cacheWrite1h) }}</strong>
                </div>
              </div>

              <div class="flex gap-[15px] flex-wrap text-xs text-muted-foreground mt-[16px] a-legend">
                <span v-for="([_, label], i) in fields" :key="i" class="inline-flex gap-[7px] items-center">
                  <i class="w-[8px] h-[8px] inline-block rounded-[1px] shrink-0 a-dot" :style="`background:${colors[i]}`" aria-hidden="true"></i>
                  {{ label }}
                </span>
              </div>
            </section>
          </div>

          <!-- Grid 2: Comparison & Cost Breakdown -->
          <div class="grid grid-cols-[1.45fr_1fr] max-[1100px]:grid-cols-1 gap-4 mb-[18px]">
            <!-- Model comparison -->
            <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card">
              <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Model comparison</h2>
              <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Compare the models in the current selection.</p>

              <label class="grid gap-[5px] text-xs text-muted-foreground mb-4">
                Measure
                <select
                  v-model="comparisonMetric"
                  aria-label="Model comparison metric"
                  class="max-w-full w-[min(260px,100%)] min-w-0 h-9 px-3 text-sm text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="totalTokens">Total tokens</option>
                  <option value="cost">Recorded cost</option>
                </select>
              </label>

              <div class="grid gap-[15px] mt-[18px] a-bars">
                <template v-if="!comparisonSorted.length || comparisonMax === 0">
                  <p class="a-empty py-[26px] text-muted-foreground text-[14px]">{{ comparisonMetric === 'cost' ? 'No nonzero cost is recorded. This does not mean usage was free.' : 'No tokens recorded.' }}</p>
                </template>
                <template v-else>
                  <div v-for="m in comparisonSorted" :key="m.key">
                    <div class="flex justify-between gap-3 text-xs mb-[5px] a-bar-label">
                      <span>{{ m.model }} <span class="text-muted-foreground">· {{ m.provider }}</span></span>
                      <span>{{ comparisonMetric === 'cost' ? usd(comparisonValue(m)) : compact(comparisonValue(m)) }}</span>
                    </div>
                    <div class="bg-secondary rounded-[1px] h-[7px] overflow-hidden a-bar-track" role="img" :aria-label="`${m.key}: ${comparisonMetric === 'cost' ? usd(comparisonValue(m)) : full(comparisonValue(m))}`">
                      <div class="h-full bg-primary a-bar-fill" :style="`width:${comparisonMax ? comparisonValue(m) / comparisonMax * 100 : 0}%`"></div>
                    </div>
                  </div>
                </template>
              </div>
            </section>

            <!-- Recorded cost -->
            <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card">
              <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Recorded cost</h2>
              <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">USD estimates recorded with each response. Not an invoice or subscription charge.</p>

              <div class="grid gap-[10px] a-breakdown">
                <div v-for="([key, label]) in fields" :key="key" class="flex gap-3 items-baseline text-[14px] a-stat-row">
                  <span class="flex-1 text-muted-foreground">{{ label }}</span>
                  <strong class="font-medium tabular-nums">{{ usd((activeUsage.cost as Record<string, number>)[key]) }}</strong>
                </div>
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                  <span class="flex-1 text-muted-foreground">Total</span>
                  <strong class="font-medium tabular-nums">{{ usd(activeUsage.cost.total) }}</strong>
                </div>
              </div>

              <p class="a-subtitle text-muted-foreground text-xs mt-4 mb-0">Zero can mean unpriced usage, a subscription adapter, or a zero rate.</p>
            </section>
          </div>

          <!-- Model breakdown table -->
          <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
            <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Model breakdown</h2>
            <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Select a model name for its full detail. Scroll the table to see every counter.</p>

            <div class="overflow-auto mt-4 a-scroll" tabindex="0" aria-label="Model usage table">
              <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                <thead>
                  <tr class="border-b border-border">
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Model</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Total tokens</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Input</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Output</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cache read</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cache write</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Hit rate</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cost · USD</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Responses</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="m in snapshot.models" :key="m.key" class="border-b border-border last:border-0">
                    <td class="p-3 text-left">
                      <button type="button" class="p-0 min-h-[32px] border-0 text-primary-text bg-transparent text-[14px] text-left hover:underline cursor-pointer" @click="selected = m.key">
                        {{ m.model }}
                      </button>
                      <small class="text-muted-foreground block">{{ m.provider }}</small>
                    </td>
                    <td class="p-3 text-right">{{ full(m.usage.totalTokens) }}</td>
                    <td class="p-3 text-right">{{ full(m.usage.input) }}</td>
                    <td class="p-3 text-right">{{ full(m.usage.output) }}</td>
                    <td class="p-3 text-right">{{ full(m.usage.cacheRead) }}</td>
                    <td class="p-3 text-right">{{ full(m.usage.cacheWrite) }}</td>
                    <td class="p-3 text-right">{{ pct(m.usage.cacheHitRate) }}</td>
                    <td class="p-3 text-right">{{ usd(m.usage.cost.total) }}</td>
                    <td class="p-3 text-right">{{ full(m.responses) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Selected model details -->
          <template v-if="activeSelectedModel">
            <div class="grid grid-cols-2 max-[1100px]:grid-cols-1 gap-4 my-[22px] a-grid a-section">
              <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card">
                <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Response history</h2>
                <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Observed assistant messages, not all model calls.</p>
                <div class="grid gap-[10px] a-breakdown">
                  <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                    <span class="flex-1 text-muted-foreground">Responses</span>
                    <strong class="font-medium tabular-nums">{{ full(activeSelectedModel.responses) }}</strong>
                  </div>
                  <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                    <span class="flex-1 text-muted-foreground">Error responses</span>
                    <strong class="font-medium tabular-nums">{{ full(activeSelectedModel.errors) }}</strong>
                  </div>
                  <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                    <span class="flex-1 text-muted-foreground">Aborted responses</span>
                    <strong class="font-medium tabular-nums">{{ full(activeSelectedModel.aborted) }}</strong>
                  </div>
                  <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                    <span class="flex-1 text-muted-foreground">Sessions with ledger usage</span>
                    <strong class="font-medium tabular-nums">{{ full(activeSelectedModel.sessions) }}</strong>
                  </div>
                  <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                    <span class="flex-1 text-muted-foreground">First response</span>
                    <strong class="font-medium tabular-nums">{{ when(activeSelectedModel.firstSeen) }}</strong>
                  </div>
                  <div class="flex gap-3 items-baseline text-[14px] a-stat-row">
                    <span class="flex-1 text-muted-foreground">Latest response</span>
                    <strong class="font-medium tabular-nums">{{ when(activeSelectedModel.lastSeen) }}</strong>
                  </div>
                </div>
              </section>

              <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card">
                <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Current model rates</h2>
                <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">USD per 1M tokens · Current catalog rates, not historical billing rates.</p>
                <div class="grid gap-[10px] a-breakdown">
                  <div v-for="([key, label]) in fields" :key="key" class="flex gap-3 items-baseline text-[14px] a-stat-row">
                    <span class="flex-1 text-muted-foreground">{{ label }}</span>
                    <strong class="font-medium tabular-nums">{{ activeSelectedModel.rates && (activeSelectedModel.rates as Record<string, number>)[key] > 0 ? usd((activeSelectedModel.rates as Record<string, number>)[key]) : 'Not priced' }}</strong>
                  </div>
                </div>
              </section>
            </div>
          </template>

          <!-- Tool reported usage (only when !selected) -->
          <template v-if="!selected && snapshot.tools.length">
            <section class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
              <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Tool-reported usage</h2>
              <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Separate counters. Not added to model totals because usage can overlap.</p>

              <div class="overflow-auto mt-4 a-scroll" tabindex="0" aria-label="Tool usage table">
                <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                  <thead>
                    <tr class="border-b border-border">
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Tool</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Input</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Output</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cache read</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cache write</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Total tokens</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cost · USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="t in snapshot.tools" :key="t.name" class="border-b border-border last:border-0">
                      <td class="p-3 text-left font-medium">{{ t.name }}</td>
                      <td class="p-3 text-right">{{ full(t.usage.input) }}</td>
                      <td class="p-3 text-right">{{ full(t.usage.output) }}</td>
                      <td class="p-3 text-right">{{ full(t.usage.cacheRead) }}</td>
                      <td class="p-3 text-right">{{ full(t.usage.cacheWrite) }}</td>
                      <td class="p-3 text-right">{{ full(t.usage.totalTokens) }}</td>
                      <td class="p-3 text-right">{{ usd(t.usage.cost.total) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </template>

          <details class="text-muted-foreground text-xs border-t border-border pt-[18px] pb-2 a-notes">
            <summary class="cursor-pointer text-foreground min-h-[36px]">How to read these numbers</summary>
            <p class="my-2">{{ snapshot.scope }}</p>
            <ul class="list-disc pl-4 space-y-1 my-2">
              <li v-for="(note, i) in snapshot.notes" :key="i" class="mb-[7px]">{{ note }}</li>
            </ul>
            <p class="my-2">Cache hit rate = cache read ÷ (uncached input + cache read + cache write). Uncached input is not proof of a cache miss.</p>
          </details>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { Menu, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ui, setDrawer, navigate } from '@/stores/app'
import { json } from '@/lib/api'

interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

interface ModelUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  reasoning: number | null
  cacheWrite1h: number | null
  cacheHitRate: number | null
  cost: UsageCost
  [key: string]: any
}

interface DailyItem {
  date: string
  responses: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  [key: string]: any
}

interface ModelItem {
  key: string
  provider: string
  model: string
  responses: number
  errors: number
  aborted: number
  sessions: number
  firstSeen: string | null
  lastSeen: string | null
  rates: UsageCost | null
  usage: ModelUsage
  daily: DailyItem[]
}

interface ToolItem {
  name: string
  usage: ModelUsage
}

interface AnalyticsSnapshot {
  generatedAt: string
  scope: string
  totals: ModelUsage
  sessions: number
  models: ModelItem[]
  tools: ToolItem[]
  notes: string[]
}

const opened = ref(false)
const generation = ref(0)
const selected = ref("")
const snapshot = ref<AnalyticsSnapshot | null>(null)
const refreshing = ref(false)
const busy = ref(false)
const statusText = ref("")
const statusIsError = ref(false)
const updatedText = ref("")

const colors = ["#b5d9ad", "#8fb9d1", "#d5ba8d", "#bb9dcb"]
const fields: [keyof ModelUsage, string][] = [
  ["input", "Uncached input"],
  ["output", "Output"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"]
]

const full = (n: number | null | undefined) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n || 0)
const compact = (n: number | null | undefined) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(n || 0)
const usd = (n: number | null | undefined) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n || 0)
const pct = (n: number | null | undefined) => n == null ? "Not reported" : (n * 100).toFixed(1) + "%"
const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "Not reported"

const activeModels = computed(() => {
  if (!snapshot.value) return []
  return snapshot.value.models.filter(m => !selected.value || m.key === selected.value)
})

const activeSelectedModel = computed(() => {
  if (!selected.value || !snapshot.value) return null
  return snapshot.value.models.find(m => m.key === selected.value) || null
})

const activeUsage = computed(() => {
  if (!snapshot.value) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: null, cacheWrite1h: null, cacheHitRate: null, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  if (selected.value && activeSelectedModel.value) {
    return activeSelectedModel.value.usage
  }
  return snapshot.value.totals
})

const responsesCount = computed(() => {
  return activeModels.value.reduce((n, m) => n + m.responses, 0)
})

const cacheTotal = computed(() => {
  const u = activeUsage.value
  return u.input + u.cacheRead + u.cacheWrite
})

const compositionSum = computed(() => {
  const u = activeUsage.value as any
  return fields.reduce((n, [key]) => n + (Number(u[key]) || 0), 0)
})

// Timeline computation
const visibleTimeline = computed(() => {
  const days = new Map<string, DailyItem>()
  for (const model of activeModels.value) {
    for (const day of model.daily) {
      let item = days.get(day.date)
      if (!item) {
        item = { date: day.date, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        days.set(day.date, item)
      }
      item.responses += day.responses
      for (const [key] of fields) {
        item[key] += (Number(day[key]) || 0)
      }
    }
  }
  const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  return sorted.slice(-30)
})

const leftMargin = 56
const topMargin = 12
const chartHeight = 168
const chartWidth = 574

const maxTimeline = computed(() => {
  const vis = visibleTimeline.value
  if (!vis.length) return 1
  const maxVal = Math.max(1, ...vis.map(d => fields.reduce((n, [key]) => n + (Number(d[key]) || 0), 0)))
  return maxVal
})

const timelineStep = computed(() => {
  const vis = visibleTimeline.value
  if (!vis.length) return chartWidth
  return chartWidth / vis.length
})

function getRectY(day: DailyItem, fieldIndex: number) {
  let y = topMargin + chartHeight
  const max = maxTimeline.value
  const dAny = day as any
  for (let i = 0; i <= fieldIndex; i++) {
    const key = fields[i][0]
    const val = Number(dAny[key]) || 0
    const size = (val / max) * chartHeight
    if (i === fieldIndex) {
      y -= size
    } else {
      y -= size
    }
  }
  return y
}

function getRectSize(day: DailyItem, fieldIndex: number) {
  const max = maxTimeline.value
  const key = fields[fieldIndex][0]
  const val = Number((day as any)[key]) || 0
  return (val / max) * chartHeight
}

// Comparison
const comparisonMetric = ref<"totalTokens" | "cost">("totalTokens")
const comparisonSorted = computed(() => {
  if (!snapshot.value) return []
  const val = (m: ModelItem) => comparisonMetric.value === "cost" ? m.usage.cost.total : m.usage.totalTokens
  return [...snapshot.value.models].sort((a, b) => val(b) - val(a))
})

const comparisonValue = (m: ModelItem) => {
  return comparisonMetric.value === "cost" ? m.usage.cost.total : m.usage.totalTokens
}

const comparisonMax = computed(() => {
  const sorted = comparisonSorted.value
  if (!sorted.length) return 0
  const val = (m: ModelItem) => comparisonMetric.value === "cost" ? m.usage.cost.total : m.usage.totalTokens
  return Math.max(0, ...sorted.map(val))
})

async function load() {
  if (!opened.value) return
  const own = ++generation.value
  refreshing.value = true
  busy.value = true
  statusIsError.value = false
  statusText.value = snapshot.value ? "Updating usage…" : "Loading usage…"

  try {
    const next = await json<AnalyticsSnapshot>("/v1/analytics")
    if (!opened.value || own !== generation.value) return
    snapshot.value = next
    if (selected.value && !next.models.some(m => m.key === selected.value)) {
      selected.value = ""
    }
    updatedText.value = "Updated " + when(next.generatedAt)
    statusText.value = "All retained history · Model totals include compaction usage. Charts show dated responses only."
  } catch (error: any) {
    if (opened.value && own === generation.value) {
      statusIsError.value = true
      statusText.value = (snapshot.value ? "Could not refresh. Showing the previous snapshot. " : "Could not load usage. ") + error.message + " Use Refresh to retry."
    }
  } finally {
    if (opened.value && own === generation.value) {
      refreshing.value = false
      busy.value = false
    }
  }
}

// Watch ui.view to know when to open/close
watch(() => ui.view, (newView) => {
  if (newView === "analytics") {
    opened.value = true
    load()
  } else {
    opened.value = false
    generation.value++
    refreshing.value = false
    busy.value = false
  }
}, { immediate: true })

onMounted(() => {
  if (ui.view === "analytics") {
    opened.value = true
    load()
  }
})

onUnmounted(() => {
  opened.value = false
  generation.value++
})
</script>
