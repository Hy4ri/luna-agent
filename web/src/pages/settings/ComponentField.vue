<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  schema: any
  path: (string | number)[]
  required: boolean
  get: (path: (string | number)[]) => any
  set: (path: (string | number)[], val: any) => void
  seed: (schema: any) => any
  labelFor: (path: (string | number)[]) => string
}>()

const key = computed(() => props.path[props.path.length - 1])
const value = computed(() => props.get(props.path))
const text = computed(() => props.labelFor(props.path))
const attrs = computed(() => ({
  "data-setting": props.path.join("."),
  "aria-label": text.value
}))

function addChildItem() {
  const current = props.get(props.path) || []
  props.set(props.path, [...current, props.seed(props.schema.items)])
}

function removeChildItem(i: number) {
  const current = [...(props.get(props.path) || [])]
  current.splice(i, 1)
  props.set(props.path, current)
}

function addDictItem() {
  const entries = { ...(props.get(props.path) || {}) }
  let n = 1
  while (Object.hasOwn(entries, "VARIABLE_" + n)) n++
  entries["VARIABLE_" + n] = ""
  props.set(props.path, entries)
}

function removeDictItem(name: string) {
  const entries = { ...props.get(props.path) }
  delete entries[name]
  props.set(props.path, entries)
}
</script>

<template>
  <!-- anyOf / oneOf (transport variants) -->
  <template v-if="schema.anyOf || schema.oneOf">
    <div class="grid gap-2">
      <label class="field-label">
        <span>Transport</span>
        <select
          :value="value?.transport || (schema.anyOf || schema.oneOf)[0].properties.transport.const"
          @change="(e: any) => {
            const variants = schema.anyOf || schema.oneOf
            const selected = variants.find((s: any) => s.properties.transport.const === e.target.value) || variants[0]
            const next = seed(selected)
            if (value?.name !== undefined) next.name = value.name
            if (value?.enabled !== undefined) next.enabled = value.enabled
            if (value?.defer !== undefined) next.defer = value.defer
            if (value?.timeoutMs !== undefined) next.timeoutMs = value.timeoutMs
            if (value?.transport !== 'stdio' && e.target.value !== 'stdio' && value?.url) {
              next.url = value.url
              next.headers = value.headers
            }
            set(path, next)
          }"
          :data-setting="[...path, 'transport'].join('.')"
          :aria-label="text + ' Transport'"
          class="input"
        >
          <option
            v-for="variant in (schema.anyOf || schema.oneOf)"
            :key="variant.properties.transport.const"
            :value="variant.properties.transport.const"
          >
            {{ variant.properties.transport.const }}
          </option>
        </select>
      </label>
      <template v-for="variant in (schema.anyOf || schema.oneOf)" :key="variant.properties.transport.const">
        <template v-if="variant.properties.transport.const === (value?.transport || (schema.anyOf || schema.oneOf)[0].properties.transport.const)">
          <template v-for="(childSchema, childName) in variant.properties" :key="childName">
            <ComponentField
              v-if="childName !== 'transport'"
              :schema="childSchema"
              :path="[...path, childName]"
              :required="(variant.required || []).includes(String(childName))"
              :get="get"
              :set="set"
              :seed="seed"
              :label-for="labelFor"
            />
          </template>
        </template>
      </template>
    </div>
  </template>

  <!-- object with properties -->
  <template v-else-if="schema.type === 'object' && schema.properties">
    <div class="grid gap-4">
      <h3 v-if="path.join('.') === 'browser.providers.camofox'" class="font-semibold">Camofox options</h3>
      <h3 v-if="path.join('.') === 'web.providers.ddgs'" class="font-semibold">DDGS options</h3>
      <template v-for="(childSchema, childName) in schema.properties" :key="childName">
        <ComponentField
          :schema="childSchema"
          :path="[...path, childName]"
          :required="(schema.required || []).includes(String(childName))"
          :get="get"
          :set="set"
          :seed="seed"
          :label-for="labelFor"
        />
      </template>
    </div>
  </template>

  <!-- dictionary object (e.g. headers, env) -->
  <template v-else-if="schema.type === 'object'">
    <div class="grid gap-4">
      <b class="font-medium">{{ text }}</b>
      <div v-for="(entryVal, entryName) in (value || {})" :key="String(entryName)" class="card p-4 grid gap-2">
        <label class="field-label">
          <span>Key</span>
          <input
            type="text"
            :value="entryName"
            @change="(e: any) => {
              const nextName = e.target.value.trim()
              if (!nextName || ['__proto__', 'constructor', 'prototype'].includes(nextName) || (nextName !== entryName && Object.hasOwn(get(path), nextName))) {
                console.warn('Use a unique, nonempty key.')
                e.target.value = String(entryName)
                return
              }
              const next = Object.fromEntries(Object.entries(get(path)).map(([k, v]) => [k === entryName ? nextName : k, v]))
              set(path, next)
            }"
            :aria-label="text + ' key'"
            class="input"
            autocomplete="off"
          />
        </label>
        <label class="field-label">
          <span>Value (saved secrets stay hidden)</span>
          <input
            type="password"
            :value="entryVal"
            @input="(e: any) => set([...path, entryName], e.target.value)"
            :data-setting="[...path, entryName].join('.')"
            :aria-label="text + ' value'"
            class="input"
            autocomplete="new-password"
          />
        </label>
        <button type="button" class="button border text-destructive px-3 py-1 rounded text-sm w-fit" @click="removeDictItem(String(entryName))">
          Remove {{ entryName }}
        </button>
      </div>
      <button type="button" class="button border px-3 py-2 rounded text-sm w-fit" @click="addDictItem">
        Add {{ path[path.length - 1] === 'headers' ? 'header' : path[path.length - 1] === 'env' ? 'environment variable' : 'item' }}
      </button>
    </div>
  </template>

  <!-- array -->
  <template v-else-if="schema.type === 'array'">
    <template v-if="schema.items.enum">
      <div class="grid gap-2" :data-setting="path.join('.')">
        <label v-for="option in schema.items.enum" :key="option" class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            :checked="(value || []).includes(option)"
            @change="(e: any) => {
              const checked = e.target.checked
              const current = get(path) || []
              set(path, schema.items.enum.filter((v: any) => v === option ? checked : current.includes(v)))
            }"
            :aria-label="option"
          />
          <span>{{ option }}</span>
        </label>
      </div>
    </template>
    <template v-else>
      <div class="grid gap-4">
        <template v-for="(item, i) in (value || [])" :key="i">
          <div v-if="schema.items.type === 'string'" class="grid gap-2">
            <ComponentField
              :schema="schema.items"
              :path="[...path, Number(i)]"
              :required="true"
              :get="get"
              :set="set"
              :seed="seed"
              :label-for="labelFor"
            />
            <button type="button" class="button border text-destructive px-3 py-1 rounded text-sm w-fit" @click="removeChildItem(Number(i))">
              Remove item {{ Number(i) + 1 }}
            </button>
          </div>
          <details v-else class="card p-4 grid gap-4" :data-section="path.join('.') + '.' + i" open>
            <summary class="cursor-pointer font-medium">
              {{ item.name || item.id || (path[path.length - 1] === 'mcpServers' ? 'MCP server' : path[path.length - 1] === 'providers' ? 'provider' : path[path.length - 1] === 'models' ? 'model' : path[path.length - 1] === 'skillDirs' ? 'skill directory' : 'Item') + ' ' + (Number(i) + 1) }}
            </summary>
            <ComponentField
              :schema="schema.items"
              :path="[...path, Number(i)]"
              :required="true"
              :get="get"
              :set="set"
              :seed="seed"
              :label-for="labelFor"
            />
            <button type="button" class="button border text-destructive px-3 py-1 rounded text-sm w-fit" @click="removeChildItem(Number(i))">
              Remove {{ path[path.length - 1] === 'mcpServers' ? 'MCP server' : path[path.length - 1] === 'providers' ? 'provider' : path[path.length - 1] === 'models' ? 'model' : path[path.length - 1] === 'skillDirs' ? 'skill directory' : path[path.length - 1] === 'args' ? 'argument' : 'item' }} {{ Number(i) + 1 }}
            </button>
          </details>
        </template>
        <button type="button" class="button border px-3 py-2 rounded text-sm w-fit" @click="addChildItem">
          Add {{ path[path.length - 1] === 'mcpServers' ? 'MCP server' : path[path.length - 1] === 'providers' ? 'provider' : path[path.length - 1] === 'models' ? 'model' : path[path.length - 1] === 'skillDirs' ? 'skill directory' : path[path.length - 1] === 'args' ? 'argument' : 'item' }}
        </button>
      </div>
    </template>
  </template>

  <!-- enum or boolean with optionality -->
  <template v-else-if="schema.enum || (schema.type === 'boolean' && !required)">
    <label class="field-label">
      <span>{{ text }}</span>
      <select
        v-bind="attrs"
        :value="value === undefined ? '' : String(value)"
        @change="(e: any) => set(path, e.target.value === '' && !required ? undefined : schema.type === 'boolean' ? e.target.value === 'true' : e.target.value)"
        class="input"
      >
        <option value="">
          {{ key === 'thinkingLevel' ? (path.length > 1 ? 'Inherit parent thinking level' : 'Model default') : ['enabled', 'defer'].includes(String(key)) ? 'Default (enabled)' : schema.type === 'boolean' ? 'Default (off)' : 'Not set' }}
        </option>
        <option v-for="option in (schema.enum || [true, false])" :key="String(option)" :value="String(option)">
          {{ schema.type === 'boolean' ? (option ? 'Yes' : 'No') : option }}
        </option>
      </select>
    </label>
  </template>

  <!-- boolean -->
  <template v-else-if="schema.type === 'boolean'">
    <label class="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        v-bind="attrs"
        :checked="value ?? schema.default ?? false"
        @change="(e: any) => set(path, e.target.checked)"
      />
      <span>{{ text }}</span>
    </label>
  </template>

  <!-- string / number / integer -->
  <template v-else>
    <label class="field-label">
      <span>{{ text }}</span>
      <component
        :is="key === 'instructions' ? 'textarea' : 'input'"
        v-bind="attrs"
        :type="schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'"
        :rows="key === 'instructions' ? 4 : undefined"
        :step="schema.type === 'integer' ? '1' : schema.type === 'number' ? 'any' : undefined"
        :min="schema.minimum"
        :max="schema.maximum"
        :value="value ?? ''"
        @input="(e: any) => set(path, e.target.value === '' && !required ? undefined : schema.type === 'number' || schema.type === 'integer' ? Number(e.target.value) : e.target.value)"
        placeholder="Not set"
        autocomplete="off"
        class="input"
      />
    </label>
  </template>
</template>
