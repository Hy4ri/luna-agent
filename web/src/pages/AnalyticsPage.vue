<template>
  <div id="analytics-screen" class="flex-1 min-w-0 min-h-0 overflow-auto p-[30px] [padding-inline:max(24px,calc((100%-1475px)/2))] [overflow-wrap:anywhere]" :aria-busy="busy ? 'true' : 'false'">
    <header class="flex items-center gap-3 flex-wrap mb-[26px] max-w-[1475px] mx-auto">
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

    <div class="flex items-end gap-3 flex-wrap pb-5 max-w-[1475px] mx-auto">
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

    <p class="a-status max-w-[1475px] mx-auto mb-4 text-[14px]" :class="{ 'error': statusIsError }" role="status" aria-live="polite">{{ statusText }}</p>

    <div data-analytics-content class="max-w-[1475px] mx-auto">
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

          <!-- Tools: call counts & error rate -->
          <section v-if="snapshot.toolsDetailed?.length" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
            <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Tools</h2>
            <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Calls counted from retained entries · Error = toolResult isError · Cost is tool-reported usage (not added to model totals).</p>
            <div class="overflow-auto mt-4 a-scroll" tabindex="0" aria-label="Tool calls table">
              <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                <thead>
                  <tr class="border-b border-border">
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Tool</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Calls</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Errors</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Error rate</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Total tokens</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cost · USD</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in snapshot.toolsDetailed" :key="t.name" class="border-b border-border last:border-0">
                    <td class="p-3 text-left font-medium">{{ t.name }}</td>
                    <td class="p-3 text-right">{{ full(t.calls) }}</td>
                    <td class="p-3 text-right">{{ full(t.errors) }}</td>
                    <td class="p-3 text-right">{{ t.errorRate == null ? '—' : (t.errorRate * 100).toFixed(1) + '%' }}</td>
                    <td class="p-3 text-right">{{ full(t.usage.totalTokens) }}</td>
                    <td class="p-3 text-right">{{ usd(t.usage.cost.total) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Skills -->
          <section v-if="snapshot.skills?.length" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
            <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Skills</h2>
            <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Invocation = skill_view without file_path · Sessions = distinct conversations.</p>
            <div class="overflow-auto mt-4 a-scroll" tabindex="0" aria-label="Skills table">
              <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                <thead>
                  <tr class="border-b border-border">
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Skill</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Invocations</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Sessions</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Last used</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="s in snapshot.skills" :key="s.name" class="border-b border-border last:border-0">
                    <td class="p-3 text-left font-medium">{{ s.name }}</td>
                    <td class="p-3 text-right">{{ full(s.invocations) }}</td>
                    <td class="p-3 text-right">{{ full(s.sessions) }}</td>
                    <td class="p-3 text-left">{{ when(s.lastUsed) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Projects -->
          <section v-if="snapshot.projects?.length" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
            <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Projects</h2>
            <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Tokens and cost per luna_session_projects · General = sessions without a project.</p>
            <div class="overflow-auto mt-4 a-scroll" tabindex="0" aria-label="Projects table">
              <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                <thead>
                  <tr class="border-b border-border">
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Project</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Sessions</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Total tokens</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cost · USD</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Hit rate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="p in snapshot.projects" :key="p.id" class="border-b border-border last:border-0">
                    <td class="p-3 text-left font-medium">{{ p.name }}<small class="block text-muted-foreground">#{{ p.id }}</small></td>
                    <td class="p-3 text-right">{{ full(p.sessions) }}</td>
                    <td class="p-3 text-right">{{ full(p.usage.totalTokens) }}</td>
                    <td class="p-3 text-right">{{ usd(p.usage.cost.total) }}</td>
                    <td class="p-3 text-right">{{ pct(p.usage.cacheHitRate) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <template v-if="snapshot.projectDaily?.length">
              <h3 class="mt-6 mb-2 text-[14px] font-semibold">Cost per day per project</h3>
              <p class="a-subtitle text-muted-foreground text-xs mb-3">UTC · Dated assistant responses only.</p>
              <div class="overflow-auto a-scroll max-h-[320px]" tabindex="0" aria-label="Project daily table">
                <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                  <thead>
                    <tr class="border-b border-border">
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Date</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Project</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Responses</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Tokens</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cost · USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in (snapshot.projectDaily.slice(-60))" :key="r.date + '|' + r.projectId" class="border-b border-border last:border-0">
                      <td class="p-3 text-left">{{ r.date }}</td>
                      <td class="p-3 text-left">{{ r.projectName }}</td>
                      <td class="p-3 text-right">{{ full(r.responses) }}</td>
                      <td class="p-3 text-right">{{ full(r.usage.totalTokens) }}</td>
                      <td class="p-3 text-right">{{ usd(r.usage.cost.total) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </section>

          <!-- Workers + Content actions -->
          <div class="grid grid-cols-2 max-[1100px]:grid-cols-1 gap-4 my-[22px]">
            <section v-if="snapshot.workers?.length" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card a-section">
              <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Workers</h2>
              <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">ExecTarget worker · Sessions and cost per worker.</p>
              <div class="overflow-auto a-scroll" tabindex="0" aria-label="Workers table">
                <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                  <thead>
                    <tr class="border-b border-border">
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Worker</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Sessions</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Tokens</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cost · USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="w in snapshot.workers" :key="String(w.worker)" class="border-b border-border last:border-0">
                      <td class="p-3 text-left font-medium">{{ w.label }}</td>
                      <td class="p-3 text-right">{{ full(w.sessions) }}</td>
                      <td class="p-3 text-right">{{ full(w.usage.totalTokens) }}</td>
                      <td class="p-3 text-right">{{ usd(w.usage.cost.total) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            <section v-if="snapshot.contentActions" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card a-section">
              <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Content actions</h2>
              <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Tool call counts for file and board operations.</p>
              <div class="grid gap-[10px] a-breakdown">
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row"><span class="flex-1 text-muted-foreground">Reads</span><strong class="font-medium tabular-nums">{{ full(snapshot.contentActions.reads) }}</strong></div>
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row"><span class="flex-1 text-muted-foreground">Writes</span><strong class="font-medium tabular-nums">{{ full(snapshot.contentActions.writes) }}</strong></div>
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row"><span class="flex-1 text-muted-foreground">Edits</span><strong class="font-medium tabular-nums">{{ full(snapshot.contentActions.edits) }}</strong></div>
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row"><span class="flex-1 text-muted-foreground">Bash execs</span><strong class="font-medium tabular-nums">{{ full(snapshot.contentActions.bashes) }}</strong></div>
                <div class="flex gap-3 items-baseline text-[14px] a-stat-row"><span class="flex-1 text-muted-foreground">Board ops</span><strong class="font-medium tabular-nums">{{ full(snapshot.contentActions.boards) }}</strong></div>
              </div>
            </section>
          </div>

          <!-- Reliability -->
          <section v-if="snapshot.reliability" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
            <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Reliability</h2>
            <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Error/abort = stopReason per model · Daily trend is retained dated responses.</p>
            <div class="overflow-auto a-scroll mb-6" tabindex="0" aria-label="Reliability by model">
              <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                <thead>
                  <tr class="border-b border-border">
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Model</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Responses</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Errors</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Error rate</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Aborted</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Abort rate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in snapshot.reliability.byModel" :key="r.key" class="border-b border-border last:border-0">
                    <td class="p-3 text-left font-medium">{{ r.model }}<small class="block text-muted-foreground">{{ r.provider }}</small></td>
                    <td class="p-3 text-right">{{ full(r.responses) }}</td>
                    <td class="p-3 text-right">{{ full(r.errors) }}</td>
                    <td class="p-3 text-right">{{ r.errorRate == null ? '—' : (r.errorRate * 100).toFixed(2) + '%' }}</td>
                    <td class="p-3 text-right">{{ full(r.aborted) }}</td>
                    <td class="p-3 text-right">{{ r.abortRate == null ? '—' : (r.abortRate * 100).toFixed(2) + '%' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3 class="m-0 mb-2 text-[14px] font-semibold">Daily errors</h3>
            <div v-if="!snapshot.reliability.dailyErrors.length" class="text-muted-foreground text-xs">No dated errors recorded.</div>
            <div v-else class="overflow-auto a-scroll max-h-[280px]" tabindex="0" aria-label="Daily errors">
              <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                <thead>
                  <tr class="border-b border-border">
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Date</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Responses</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Errors</th>
                    <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Aborted</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="d in snapshot.reliability.dailyErrors.slice(-30)" :key="d.date" class="border-b border-border last:border-0">
                    <td class="p-3 text-left">{{ d.date }}</td>
                    <td class="p-3 text-right">{{ full(d.responses) }}</td>
                    <td class="p-3 text-right">{{ full(d.errors) }}</td>
                    <td class="p-3 text-right">{{ full(d.aborted) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Status breakdown -->
          <section v-if="snapshot.statusBreakdown" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
            <h2 class="m-0 mb-[6px] text-[17px] font-semibold">Status overview</h2>
            <p class="a-subtitle text-muted-foreground text-xs mb-[18px]">Live session status · Click a badge to filter the sessions table.</p>
            <div class="flex gap-2 flex-wrap">
              <button
                v-for="(count, status) in snapshot.statusBreakdown"
                :key="status"
                type="button"
                class="h-7 px-3 rounded-full border text-xs font-medium transition-colors"
                :class="selectedStatuses.includes(status as SessionStatus) ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-foreground border-border hover:bg-accent'"
                @click="toggleStatus(status as SessionStatus)"
              >{{ statusLabel(status as SessionStatus) }} · {{ full(count as number) }}</button>
              <button v-if="selectedStatuses.length" type="button" class="h-7 px-3 rounded-full border text-xs bg-card border-border hover:bg-accent" @click="selectedStatuses = []">Clear filter</button>
            </div>
            <p v-if="snapshot.sessionsList?.length" class="text-xs text-muted-foreground mt-3">{{ full(filteredSessions.length) }} of {{ full(snapshot.sessionsList.length) }} sessions shown · {{ selectedSessionIds.size ? full(selectedSessionIds.size) + ' selected' : 'Select sessions for per-session analytics' }}</p>
          </section>

          <!-- Per-session analytics -->
          <section v-if="snapshot.sessionsList" class="min-w-0 p-5 border border-border rounded-[var(--radius)] bg-card a-card my-[22px] a-section">
            <div class="flex items-center gap-3 flex-wrap mb-3">
              <h2 class="m-0 text-[17px] font-semibold flex-1">Sessions</h2>
              <span v-if="selectedAggregate" class="text-xs text-muted-foreground">Selected: {{ compact(selectedAggregate.totalTokens) }} tokens · {{ usd(selectedAggregate.cost.total) }} · {{ full(selectedAggregateResponses) }} responses</span>
              <Button v-if="selectedSessionIds.size" type="button" variant="outline" size="sm" class="h-7 text-xs" @click="selectedSessionIds = new Set()">Clear selection</Button>
            </div>
            <p class="a-subtitle text-muted-foreground text-xs mb-3">Per-session usage, status, and activity · Uses recorded ledger totals (includes compaction). Subagent sessions are included.</p>

            <div class="flex gap-3 flex-wrap items-end mb-3">
              <label class="grid gap-[5px] text-xs text-muted-foreground">
                Search
                <input v-model="sessionSearch" placeholder="Title or id" class="h-9 px-3 text-sm text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring w-[220px]" />
              </label>
              <label class="grid gap-[5px] text-xs text-muted-foreground">
                Sort by
                <select v-model="sessionSort" aria-label="Session sort" class="h-9 px-3 text-sm text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring">
                  <option value="activityDesc">Last activity · newest</option>
                  <option value="activityAsc">Last activity · oldest</option>
                  <option value="tokensDesc">Tokens · high to low</option>
                  <option value="tokensAsc">Tokens · low to high</option>
                  <option value="costDesc">Cost · high to low</option>
                  <option value="costAsc">Cost · low to high</option>
                  <option value="responsesDesc">Responses · high to low</option>
                  <option value="turnsDesc">Turns · high to low</option>
                  <option value="toolsDesc">Tool calls · high to low</option>
                  <option value="durationDesc">Duration · long to short</option>
                  <option value="status">Status · A–Z</option>
                  <option value="createdDesc">Created · newest</option>
                </select>
              </label>
              <label class="grid gap-[5px] text-xs text-muted-foreground">
                Show
                <select v-model="sessionShowArchived" class="h-9 px-3 text-sm text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring">
                  <option :value="'active'">Active only</option>
                  <option :value="'all'">All including archived</option>
                  <option :value="'archived'">Archived only</option>
                </select>
              </label>
              <label class="flex items-center gap-2 text-xs text-muted-foreground ml-auto">
                <input type="checkbox" :checked="allVisibleSelected" @change="toggleAllVisible($event)" />
                Select filtered ({{ filteredSessions.length }})
              </label>
            </div>

            <template v-if="!sortedSessions.length">
              <p class="a-empty py-[26px] text-muted-foreground text-[14px]">No sessions match the current filters.</p>
            </template>
            <template v-else>
              <div v-if="selectedAggregate" class="grid grid-cols-3 max-[760px]:grid-cols-1 gap-3 mb-4 p-3 rounded-[var(--radius)] bg-secondary border border-border">
                <div><div class="text-xs text-muted-foreground">Selected tokens</div><strong class="text-sm tabular-nums">{{ full(selectedAggregate.totalTokens) }}</strong> <span class="text-xs text-muted-foreground">· hit {{ pct(selectedAggregate.cacheHitRate) }}</span></div>
                <div><div class="text-xs text-muted-foreground">Selected cost · USD</div><strong class="text-sm tabular-nums">{{ usd(selectedAggregate.cost.total) }}</strong></div>
                <div><div class="text-xs text-muted-foreground">Selected responses</div><strong class="text-sm tabular-nums">{{ full(selectedAggregateResponses) }}</strong> <span class="text-xs text-muted-foreground">· {{ full(selectedAggregateErrors) }} errors</span></div>
              </div>
              <div class="overflow-auto a-scroll" tabindex="0" aria-label="Sessions table">
                <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
                  <thead>
                    <tr class="border-b border-border">
                      <th class="p-3 text-left"><input type="checkbox" :checked="allVisibleSelected" @change="toggleAllVisible($event)" aria-label="Select all filtered" /></th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Session</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Status</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Tokens</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Cost</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-right">Responses</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Last activity</th>
                      <th scope="col" class="text-muted-foreground text-[12px] font-medium uppercase tracking-wider p-3 text-left">Models</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="s in pagedSessions" :key="s.id">
                      <tr class="border-b border-border last:border-0 hover:bg-accent/30" :class="{ 'bg-accent/20': expandedSessionId === s.id }">
                        <td class="p-3"><input type="checkbox" :checked="selectedSessionIds.has(s.id)" @change="toggleSession(s.id)" /></td>
                        <td class="p-3 text-left max-w-[260px] whitespace-normal break-words">
                          <button type="button" class="p-0 border-0 bg-transparent text-left hover:underline text-primary-text text-[13px] font-medium" @click="expandedSessionId = expandedSessionId === s.id ? null : s.id">{{ s.title || 'Untitled' }}</button>
                          <small class="block text-muted-foreground">#{{ s.id }}<span v-if="s.pinned"> · pinned</span><span v-if="s.archived"> · archived</span><span v-if="s.parent"> · subagent</span></small>
                        </td>
                        <td class="p-3 text-left">
                          <span class="inline-flex items-center h-6 px-2 rounded-full border text-[11px] font-medium" :class="statusChipClass(s.status)">{{ statusLabel(s.status) }}</span>
                          <small v-if="s.statusReason" class="block text-muted-foreground max-w-[180px] whitespace-normal">{{ s.statusReason }}</small>
                        </td>
                        <td class="p-3 text-right">{{ compact(s.usage.totalTokens) }}<small class="block text-muted-foreground">{{ pct(s.usage.cacheHitRate) }}</small></td>
                        <td class="p-3 text-right">{{ usd(s.usage.cost.total) }}</td>
                        <td class="p-3 text-right">{{ full(s.responses) }}<small v-if="s.errors || s.aborted" class="block text-muted-foreground">{{ s.errors ? full(s.errors) + ' err' : '' }}{{ s.errors && s.aborted ? ' · ' : '' }}{{ s.aborted ? full(s.aborted) + ' abort' : '' }}</small></td>
                        <td class="p-3 text-left">{{ when(s.lastActivity) }}<small class="block text-muted-foreground">{{ s.createdAt ? 'created ' + when(s.createdAt) : '' }}</small></td>
                        <td class="p-3 text-left max-w-[160px] whitespace-normal">{{ s.models.length ? s.models.join(', ') : '—' }}</td>
                      </tr>
                      <tr v-if="expandedSessionId === s.id" class="border-b border-border bg-secondary/30">
                        <td colspan="8" class="p-4 text-left whitespace-normal">
                          <div class="grid grid-cols-4 max-[760px]:grid-cols-2 gap-3 text-xs">
                            <div><span class="text-muted-foreground">Input</span><strong class="block tabular-nums">{{ full(s.usage.input) }}</strong></div>
                            <div><span class="text-muted-foreground">Output</span><strong class="block tabular-nums">{{ full(s.usage.output) }}</strong></div>
                            <div><span class="text-muted-foreground">Cache read</span><strong class="block tabular-nums">{{ full(s.usage.cacheRead) }}</strong></div>
                            <div><span class="text-muted-foreground">Cache write</span><strong class="block tabular-nums">{{ full(s.usage.cacheWrite) }}</strong></div>
                            <div><span class="text-muted-foreground">Reasoning</span><strong class="block tabular-nums">{{ s.usage.reasoning == null ? '—' : full(s.usage.reasoning) }}</strong></div>
                            <div><span class="text-muted-foreground">Hit rate</span><strong class="block tabular-nums">{{ pct(s.usage.cacheHitRate) }}</strong></div>
                            <div><span class="text-muted-foreground">Cost total</span><strong class="block tabular-nums">{{ usd(s.usage.cost.total) }}</strong></div>
                            <div><span class="text-muted-foreground">Worker</span><strong class="block tabular-nums">{{ s.worker == null ? 'main' : '#' + s.worker }}</strong></div>
                            <div><span class="text-muted-foreground">Turns (user/assistant)</span><strong class="block tabular-nums">{{ full(s.turns.user) }} / {{ full(s.turns.assistant) }} · avg {{ s.avgTokensPerTurn == null ? '—' : full(Math.round(s.avgTokensPerTurn)) }}/turn</strong></div>
                            <div><span class="text-muted-foreground">Duration</span><strong class="block tabular-nums">{{ s.durationMs == null ? '—' : (s.durationMs < 60000 ? (s.durationMs/1000).toFixed(1) + 's' : (s.durationMs/60000).toFixed(1) + 'm') }}</strong></div>
                            <div><span class="text-muted-foreground">Tools / errors</span><strong class="block tabular-nums">{{ full(s.toolCalls) }} · {{ full(s.toolErrors) }} err</strong></div>
                            <div><span class="text-muted-foreground">Subagents / depth</span><strong class="block tabular-nums">{{ full(s.subagentCount) }} · depth {{ full(s.forkDepth) }}</strong></div>
                          </div>
                          <div class="mt-3 text-xs flex gap-2 flex-wrap">
                            <span class="text-muted-foreground">Project:</span> {{ s.projectName ?? 'General' }} (#{{ s.projectId }})
                            <span class="text-muted-foreground">· Skills:</span> {{ s.skills.length ? s.skills.join(', ') : '—' }}
                          </div>
                          <div class="mt-1 text-xs"><span class="text-muted-foreground">Models:</span> {{ s.models.length ? s.models.join(', ') : 'none' }}</div>
                          <div v-if="s.statusReason" class="mt-1 text-xs"><span class="text-muted-foreground">Reason:</span> {{ s.statusReason }}</div>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
              <div v-if="sortedSessions.length > pageSize" class="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
                <Button type="button" variant="outline" size="sm" class="h-7" :disabled="sessionPage === 0" @click="sessionPage = 0">First</Button>
                <Button type="button" variant="outline" size="sm" class="h-7" :disabled="sessionPage === 0" @click="sessionPage--">Prev</Button>
                <span>Page {{ sessionPage + 1 }} of {{ totalPages }} · {{ full(sortedSessions.length) }} sessions</span>
                <Button type="button" variant="outline" size="sm" class="h-7" :disabled="sessionPage >= totalPages - 1" @click="sessionPage++">Next</Button>
              </div>
            </template>
          </section>

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
import { SESSION_STATUS_LABELS } from '@/lib/session-status'
import type { SessionStatus } from '@/lib/types'

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

interface AnalyticsSession {
  id: string
  title: string | null
  archived: boolean
  pinned: boolean
  parent: unknown
  status: SessionStatus
  statusReason: string | null
  lastActivity: string | null
  createdAt: string | null
  worker: number | null
  usage: ModelUsage
  responses: number
  errors: number
  aborted: number
  models: string[]
  turns: { user: number; assistant: number }
  durationMs: number | null
  subagentCount: number
  forkDepth: number
  toolCalls: number
  toolErrors: number
  skills: string[]
  avgTokensPerTurn: number | null
  projectId: number
  projectName: string | null
}
interface ToolDetailed { name: string; calls: number; errors: number; errorRate: number | null; usage: ModelUsage }
interface SkillRow { name: string; invocations: number; sessions: number; lastUsed: string | null }
interface ProjectRow { id: number; name: string; sessions: number; usage: ModelUsage }
interface WorkerRow { worker: number | null; sessions: number; usage: ModelUsage; label: string }

interface AnalyticsSnapshot {
  generatedAt: string
  scope: string
  totals: ModelUsage
  sessions: number
  models: ModelItem[]
  tools: ToolItem[]
  toolsDetailed?: ToolDetailed[]
  skills?: SkillRow[]
  projects?: ProjectRow[]
  workers?: WorkerRow[]
  reliability?: { byModel: { key: string; provider: string; model: string; responses: number; errors: number; aborted: number; errorRate: number | null; abortRate: number | null }[]; dailyErrors: { date: string; responses: number; errors: number; aborted: number }[] }
  projectDaily?: { date: string; projectId: number; projectName: string; responses: number; usage: ModelUsage }[]
  contentActions?: { reads: number; writes: number; edits: number; bashes: number; boards: number }
  sessionsList?: AnalyticsSession[]
  statusBreakdown?: Record<string, number>
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

// Sessions filters/sorting/selection
const sessionSearch = ref("")
const sessionSort = ref<"activityDesc" | "activityAsc" | "tokensDesc" | "tokensAsc" | "costDesc" | "costAsc" | "responsesDesc" | "status" | "createdDesc" | "durationDesc" | "turnsDesc" | "toolsDesc">("activityDesc")
const sessionShowArchived = ref<"active" | "all" | "archived">("active")
const selectedStatuses = ref<SessionStatus[]>([])
const selectedSessionIds = ref<Set<string>>(new Set())
const expandedSessionId = ref<string | null>(null)
const sessionPage = ref(0)
const pageSize = 50

const statusLabel = (s: SessionStatus) => (SESSION_STATUS_LABELS as Record<string, string>)[s] ?? s
const statusChipClass = (s: SessionStatus) => {
  if (s === "running" || s === "reviewing") return "bg-amber-100 text-amber-900 border-amber-200"
  if (s === "failed") return "bg-red-100 text-red-900 border-red-200"
  if (s === "needs_approval" || s === "needs_input") return "bg-sky-100 text-sky-900 border-sky-200"
  if (s === "limit_reached") return "bg-orange-100 text-orange-900 border-orange-200"
  if (s === "finished" || s === "review_finished") return "bg-emerald-100 text-emerald-900 border-emerald-200"
  return "bg-secondary text-foreground border-border"
}
const toggleStatus = (s: SessionStatus) => {
  const i = selectedStatuses.value.indexOf(s)
  if (i >= 0) selectedStatuses.value.splice(i, 1)
  else selectedStatuses.value.push(s)
  sessionPage.value = 0
}
const toggleSession = (id: string) => {
  const n = new Set(selectedSessionIds.value)
  if (n.has(id)) n.delete(id); else n.add(id)
  selectedSessionIds.value = n
}
const toggleAllVisible = (e: Event) => {
  const checked = (e.target as HTMLInputElement).checked
  const n = new Set(selectedSessionIds.value)
  for (const s of filteredSessions.value) if (checked) n.add(s.id); else n.delete(s.id)
  selectedSessionIds.value = n
}
watch([sessionSearch, sessionSort, sessionShowArchived, selectedStatuses], () => { sessionPage.value = 0 })

const filteredSessions = computed(() => {
  const list = snapshot.value?.sessionsList ?? []
  const q = sessionSearch.value.trim().toLowerCase()
  return list.filter(s => {
    if (sessionShowArchived.value === "active" && s.archived) return false
    if (sessionShowArchived.value === "archived" && !s.archived) return false
    if (selectedStatuses.value.length && !selectedStatuses.value.includes(s.status)) return false
    if (q && !(s.id.toLowerCase().includes(q) || (s.title ?? "").toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || (s.projectName ?? "").toLowerCase().includes(q) || s.skills.join(",").toLowerCase().includes(q))) return false
    return true
  })
})

const sortedSessions = computed(() => {
  const arr = [...filteredSessions.value]
  const k = sessionSort.value
  const cmp: Record<string, (a: AnalyticsSession, b: AnalyticsSession) => number> = {
    activityDesc: (a, b) => (b.lastActivity ?? b.createdAt ?? "").localeCompare(a.lastActivity ?? a.createdAt ?? "") || Number(b.id) - Number(a.id),
    activityAsc: (a, b) => (a.lastActivity ?? a.createdAt ?? "").localeCompare(b.lastActivity ?? b.createdAt ?? ""),
    tokensDesc: (a, b) => b.usage.totalTokens - a.usage.totalTokens,
    tokensAsc: (a, b) => a.usage.totalTokens - b.usage.totalTokens,
    costDesc: (a, b) => b.usage.cost.total - a.usage.cost.total,
    costAsc: (a, b) => a.usage.cost.total - b.usage.cost.total,
    responsesDesc: (a, b) => b.responses - a.responses,
    durationDesc: (a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1),
    turnsDesc: (a, b) => (b.turns.user + b.turns.assistant) - (a.turns.user + a.turns.assistant),
    toolsDesc: (a, b) => b.toolCalls - a.toolCalls,
    status: (a, b) => a.status.localeCompare(b.status) || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""),
    createdDesc: (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || Number(b.id) - Number(a.id),
  }
  arr.sort(cmp[k] ?? cmp.activityDesc)
  return arr
})

const totalPages = computed(() => Math.max(1, Math.ceil(sortedSessions.value.length / pageSize)))
const pagedSessions = computed(() => sortedSessions.value.slice(sessionPage.value * pageSize, sessionPage.value * pageSize + pageSize))
const allVisibleSelected = computed(() => filteredSessions.value.length > 0 && filteredSessions.value.every(s => selectedSessionIds.value.has(s.id)))

const selectedAggregate = computed<ModelUsage | null>(() => {
  if (!selectedSessionIds.value.size || !snapshot.value?.sessionsList) return null
  const agg: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cacheWrite1h: 0, cacheHitRate: null, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  let hasReasoning = false, has1h = false
  for (const s of snapshot.value.sessionsList) if (selectedSessionIds.value.has(s.id)) {
    agg.input += s.usage.input; agg.output += s.usage.output; agg.cacheRead += s.usage.cacheRead; agg.cacheWrite += s.usage.cacheWrite; agg.totalTokens += s.usage.totalTokens
    if (s.usage.reasoning != null) { agg.reasoning = (agg.reasoning ?? 0) + s.usage.reasoning; hasReasoning = true }
    if (s.usage.cacheWrite1h != null) { agg.cacheWrite1h = (agg.cacheWrite1h ?? 0) + s.usage.cacheWrite1h; has1h = true }
    agg.cost.input += s.usage.cost.input; agg.cost.output += s.usage.cost.output; agg.cost.cacheRead += s.usage.cost.cacheRead; agg.cost.cacheWrite += s.usage.cost.cacheWrite; agg.cost.total += s.usage.cost.total
  }
  if (!hasReasoning) agg.reasoning = null
  if (!has1h) agg.cacheWrite1h = null
  const denom = agg.input + agg.cacheRead + agg.cacheWrite
  agg.cacheHitRate = denom ? agg.cacheRead / denom : null
  return agg
})
const selectedAggregateResponses = computed(() => {
  if (!snapshot.value?.sessionsList) return 0
  return snapshot.value.sessionsList.filter(s => selectedSessionIds.value.has(s.id)).reduce((n, s) => n + s.responses, 0)
})
const selectedAggregateErrors = computed(() => {
  if (!snapshot.value?.sessionsList) return 0
  return snapshot.value.sessionsList.filter(s => selectedSessionIds.value.has(s.id)).reduce((n, s) => n + s.errors, 0)
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
    // prune selected ids that no longer exist
    if (next.sessionsList) {
      const ids = new Set(next.sessionsList.map(s => s.id))
      const pruned = new Set([...selectedSessionIds.value].filter(id => ids.has(id)))
      if (pruned.size !== selectedSessionIds.value.size) selectedSessionIds.value = pruned
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
