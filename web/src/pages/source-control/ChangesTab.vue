<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue';
import { fetchChanges, fetchBranches, fetchDiff, mutateGit } from './client';
import type { Changes, Branches, DiffResult, SelectorParams } from './client';
import ChangeList from './ChangeList.vue';
import DiffView from './DiffView.vue';
import { GitBranch, RefreshCw, ArrowDown, ArrowUp, AlertCircle } from '@lucide/vue';
const props = defineProps<{ session?: string; project?: number }>();
const emit = defineEmits<{ repo: [repo: string | null] }>();
const selector = computed<SelectorParams>(() => ({ session: props.session, project: props.project }));
const changes = ref<Changes | null>(null), branches = ref<Branches | null>(null), diff = ref<DiffResult | null>(null);
const selectedPath = ref<string | null>(null), selectedStaged = ref(false), loadingDiff = ref(false), loadingState = ref(false);
const error = ref<string | null>(null), busyMessage = ref<string | null>(null), commitMessage = ref(''), newBranchInput = ref(''), branchSelectValue = ref(''), showNewBranchInput = ref(false);
const confirmDefaultModal = ref<{open:boolean;branch?:string;head?:string|null;message?:string}>({open:false});
const pushed = ref(false);
const compareUrl = computed(() => changes.value?.repo ? `https://github.com/${changes.value.repo}/compare/${encodeURIComponent(changes.value.branch)}?expand=1` : null);
let epoch = 0, stateTicket = 0, diffTicket = 0, disposed = false;
onUnmounted(() => { disposed = true; epoch++; diffTicket++; });
async function loadState(keepSelection = true, clearError = true) {
  const generation = epoch, ticket = ++stateTicket, owner = {...selector.value}; loadingState.value = true;
  if (clearError) error.value = null;
  try {
    const [c,b] = await Promise.all([fetchChanges(owner),fetchBranches(owner)]);
    if (disposed || generation !== epoch || ticket !== stateTicket) return;
    changes.value=c; branches.value=b; branchSelectValue.value=c.branch; emit('repo',c.repo);
    if (!keepSelection || !c.files.some(f=>f.path===selectedPath.value)) { selectedPath.value=null;diff.value=null;diffTicket++; }
    else if(selectedPath.value) void loadDiff(selectedPath.value,selectedStaged.value);
  } catch(e) { if(!disposed && generation===epoch && ticket===stateTicket) error.value=(e as Error).message; }
  finally { if(!disposed && generation===epoch && ticket===stateTicket) loadingState.value=false; }
}
async function loadDiff(path:string, staged:boolean) {
  const generation=epoch,ticket=++diffTicket,owner={...selector.value};loadingDiff.value=true;diff.value=null;
  try { const d=await fetchDiff(owner,path,staged);if(!disposed && generation===epoch && ticket===diffTicket)diff.value=d; }
  catch(e){if(!disposed && generation===epoch && ticket===diffTicket)error.value=(e as Error).message;}
  finally{if(!disposed && generation===epoch && ticket===diffTicket)loadingDiff.value=false;}
}
function handleSelectFile(path:string,staged:boolean){selectedPath.value=path;selectedStaged.value=staged;void loadDiff(path,staged);}
async function runMutation(action:string,body:Record<string,unknown>,confirmDefault=false){
  if(loadingState.value || !changes.value)return;
  const generation=epoch,owner={...selector.value},branch=changes.value.branch;loadingState.value=true;busyMessage.value=`Running ${action}…`;error.value=null;
  try{
    const result=await mutateGit(owner,action,{...body,...(action==='push'?{expectedBranch:changes.value.branch,expectedHead:changes.value.headOid}:{}),...(confirmDefault?{confirmDefault:true}:{})});
    if(disposed || generation!==epoch)return;
    changes.value=result.changes;emit('repo',result.changes.repo);
    if(action==='commit')commitMessage.value='';
    if(action==='push')pushed.value=true;
  }catch(e){
    if(disposed || generation!==epoch)return;
    const message=(e as Error).message;
    if(action==='push' && message.includes('confirm-default:'))confirmDefaultModal.value={open:true,branch,head:changes.value?.headOid,message};
    else error.value=message;
  }finally{
    if(!disposed && generation===epoch){loadingState.value=false;busyMessage.value=null;await loadState(true,false);}
  }
}
const handleStage=(paths:string[])=>runMutation('stage',{paths});
const handleUnstage=(paths:string[])=>runMutation('unstage',{paths});
function handleCommit(){if(commitMessage.value.trim() && changes.value?.files.some(f=>f.staged) && !changes.value.files.some(f=>f.conflict))return runMutation('commit',{message:commitMessage.value.trim()});}
const handleFetch=()=>runMutation('fetch',{});
const handlePull=()=>runMutation('pull',{});
const handlePush=()=>runMutation('push',{setUpstream:!changes.value?.upstream});
async function handleBranchChange(event:Event){const branch=(event.target as HTMLSelectElement).value;if(branch==='__new__'){showNewBranchInput.value=true;newBranchInput.value='';return;}showNewBranchInput.value=false;if(branch!==changes.value?.branch){pushed.value=false;await runMutation('switch',{branch});}}
async function handleCreateBranch(){if(!newBranchInput.value.trim())return;await runMutation('switch',{branch:newBranchInput.value.trim(),create:true,from:'HEAD'});if(!error.value){showNewBranchInput.value=false;newBranchInput.value='';pushed.value=false;}}
function handleKeyDownCommit(e:KeyboardEvent){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void handleCommit();}}
async function confirmAndRetryPush(){const target=confirmDefaultModal.value.branch,head=confirmDefaultModal.value.head;confirmDefaultModal.value={open:false};if(target!==changes.value?.branch || head!==changes.value?.headOid){error.value='Branch changed. Review it before pushing.';return;}await runMutation('push',{setUpstream:!changes.value?.upstream},true);}
watch(()=>[props.session,props.project],()=>{epoch++;stateTicket++;diffTicket++;changes.value=null;branches.value=null;diff.value=null;selectedPath.value=null;commitMessage.value='';pushed.value=false;loadingDiff.value=false;confirmDefaultModal.value={open:false};void loadState(false);},{immediate:true});
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0 bg-background text-foreground overflow-hidden relative">
    <!-- Global Loading / Disabled overlay bar -->
    <div v-if="loadingState" class="absolute top-0 left-0 right-0 z-50 bg-primary/20 backdrop-blur-[1px] px-3 py-1 flex items-center justify-between text-xs text-primary font-medium border-b border-primary/30">
      <div class="flex items-center gap-2">
        <RefreshCw class="w-3.5 h-3.5 animate-spin" />
        <span>{{ busyMessage || "Processing Git action…" }}</span>
      </div>
    </div>

    <!-- Top Toolbar / Status Bar -->
    <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border bg-card text-xs shrink-0">
      <div class="flex items-center gap-3 min-w-0 flex-wrap">
        <!-- Machine / CWD info -->
        <div class="flex items-center gap-1.5 text-muted-foreground truncate" title="Machine and CWD">
          <span class="font-mono bg-muted px-1.5 py-0.5 rounded text-[11px]">{{ changes?.machine || "local" }}</span>
          <span class="truncate max-w-[200px]" :title="changes?.cwd">{{ changes?.cwd || "Loading cwd…" }}</span>
        </div>

        <!-- Branch Selector & New branch -->
        <div class="flex items-center gap-1">
          <GitBranch class="w-3.5 h-3.5 text-primary shrink-0" />
          <select
            v-model="branchSelectValue"
            @change="handleBranchChange"
            class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
            :disabled="loadingState"
          >
            <option v-if="changes?.unborn" value="">(unborn)</option>
            <optgroup label="Local Branches">
              <option v-for="l in branches?.local" :key="l.name" :value="l.name">
                {{ l.name }} {{ l.ahead ? `↑${l.ahead}` : '' }} {{ l.behind ? `↓${l.behind}` : '' }}
              </option>
            </optgroup>
            <optgroup label="Remote Branches">
              <option v-for="r in branches?.remote" :key="r" :value="r">{{ r }}</option>
            </optgroup>
            <option value="__new__">+ New branch…</option>
          </select>
        </div>

        <!-- New branch input inline -->
        <div v-if="showNewBranchInput" class="flex items-center gap-1">
          <input
            v-model="newBranchInput"
            type="text"
            placeholder="branch-name"
            class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground w-28 focus:outline-none focus:border-primary"
            @keydown.enter="handleCreateBranch"
          />
          <button
            type="button"
            @click="handleCreateBranch"
            class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded"
          >
            Create
          </button>
        </div>
      </div>

      <!-- Action Buttons: Fetch, Pull, Push -->
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          @click="loadState(true)"
          class="p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh Git status"
          :disabled="loadingState"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loadingState }" />
        </button>

        <button
          type="button"
          @click="handleFetch"
          class="px-2.5 py-1 bg-card hover:bg-accent border border-border rounded transition-colors"
          :disabled="loadingState"
          title="Fetch origin"
        >
          Fetch
        </button>

        <button
          type="button"
          @click="handlePull"
          class="px-2.5 py-1 bg-card hover:bg-accent border border-border rounded transition-colors flex items-center gap-1"
          :disabled="loadingState || !changes?.upstream"
          :title="changes?.upstream ? `Pull from ${changes.upstream}` : 'Publish branch before pulling'"
        >
          <ArrowDown class="w-3 h-3" />
          <span>Pull</span>
          <span v-if="changes?.behind" class="text-[10px] bg-primary/20 text-primary px-1 rounded">{{ changes.behind }}</span>
        </button>

        <button
          type="button"
          @click="handlePush"
          class="px-2.5 py-1 bg-primary text-primary-foreground hover:bg-primary/90 rounded transition-colors flex items-center gap-1"
          :disabled="loadingState || !changes || changes.detached || changes.unborn"
          :title="changes?.upstream ? `Push to ${changes.upstream}` : 'Publish branch'"
        >
          <ArrowUp class="w-3 h-3" />
          <span>{{ changes?.upstream ? 'Push' : 'Publish branch' }}</span>
          <span v-if="changes?.ahead" class="text-[10px] bg-background/20 px-1 rounded">{{ changes.ahead }}</span>
        </button>
      </div>
    </div>

    <a v-if="pushed && compareUrl" :href="compareUrl" target="_blank" rel="noopener noreferrer" class="px-3 py-2 text-xs text-primary underline">Open pull request</a>
    <!-- Error Banner -->
    <div v-if="error" class="px-3 py-2 bg-destructive/10 text-destructive text-xs border-b border-border flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <AlertCircle class="w-4 h-4 shrink-0" />
        <span class="whitespace-pre-wrap break-words">{{ error }}</span>
      </div>
      <button type="button" @click="error = null" class="text-[11px] underline shrink-0">Dismiss</button>
    </div>

    <!-- Main Split Area: Changes list (left) + Diff View (right) + Commit Box (bottom) -->
    <div class="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
      <!-- Left Pane: Changes list + Commit message input box -->
      <div class="w-full md:w-80 lg:w-96 flex flex-col border-r border-border bg-card shrink-0 h-1/2 md:h-full min-h-0">
        <div class="flex-1 min-h-0 overflow-hidden">
          <ChangeList
            :disabled="loadingState"
            :files="changes?.files ?? []"
            :selected-path="selectedPath"
            :selected-staged="selectedStaged"
            @select="handleSelectFile"
            @stage="handleStage"
            @unstage="handleUnstage"
          />
        </div>

        <!-- Commit Box -->
        <div class="p-2 border-t border-border bg-background shrink-0 space-y-2">
          <textarea
            v-model="commitMessage"
            placeholder="Commit message (Ctrl+Enter to commit)"
            rows="2"
            class="w-full bg-muted border border-border rounded p-2 text-xs text-foreground focus:outline-none focus:border-primary resize-none"
            @keydown="handleKeyDownCommit"
            :disabled="loadingState"
          ></textarea>
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-muted-foreground">
              {{ changes?.files.filter(f => f.staged).length ?? 0 }} staged
            </span>
            <button
              type="button"
              @click="handleCommit"
              class="px-3 py-1 bg-primary text-primary-foreground text-xs rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
              :disabled="loadingState || !commitMessage.trim() || !changes?.files.some(f => f.staged) || changes.files.some(f => f.conflict)"
            >
              Commit
            </button>
          </div>
        </div>
      </div>

      <!-- Right Pane: Diff View -->
      <div class="flex-1 min-h-0 flex flex-col h-1/2 md:h-full bg-background overflow-hidden">
        <div class="px-3 py-1.5 border-b border-border bg-card text-xs font-medium text-muted-foreground flex items-center justify-between shrink-0">
          <span class="truncate">{{ selectedPath ? `${selectedPath} (${selectedStaged ? 'staged' : 'unstaged'})` : 'No file selected' }}</span>
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
          <DiffView :diff="diff" :loading="loadingDiff" />
        </div>
      </div>
    </div>

    <!-- Confirm Default Branch Push Modal -->
    <div v-if="confirmDefaultModal.open" role="dialog" aria-modal="true" aria-label="Confirm default branch push" class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div class="bg-card border border-border rounded-lg max-w-md w-full p-4 space-y-3 shadow-lg">
        <div class="flex items-center gap-2 text-amber-500 font-semibold text-sm">
          <AlertCircle class="w-5 h-5" />
          <span>Confirm Push to Default Branch</span>
        </div>
        <p class="text-xs text-muted-foreground leading-relaxed">
          {{ confirmDefaultModal.message }}
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            @click="confirmDefaultModal = { open: false }"
            class="px-3 py-1.5 text-xs bg-muted hover:bg-accent rounded border border-border"
          >
            Cancel
          </button>
          <button
            type="button"
            @click="confirmAndRetryPush"
            class="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
          >
            Confirm & Push
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
