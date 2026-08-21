/**
 * dsh-comfyui-commander — DSH 标准 Cordis 插件(Host-only)
 *
 * 让 DSH Agent 通过自然语言全自动控制 ComfyUI(默认 http://127.0.0.1:8188):
 * 工作流列表 / 加载 / UI→API 转换、任务提交与参数覆盖、进度监控(队列+WebSocket)、
 * 结果获取与下载、批量/多阶段编排。
 *
 * 通信方式:通过 ctx.subprocess 派生 `node -e` 辅助进程,用 Node 的全局
 * fetch/WebSocket 与 ComfyUI 交互 —— 零外部 npm 依赖(仅需本机有 node)。
 * 工作流文件采用官方 userdata API 读取/保存,永不写回用户已保存的工作流。
 *
 * @module dsh-comfyui-commander
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'comfyui-commander'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

/** 安全配置默认值:危险操作默认关闭(删除/覆盖/修改),需手动改配置文件开启。 */
const DEFAULT_SAFETY = Object.freeze({
  allowDelete: false,
  allowOverwrite: false,
  allowModify: false,
})

/** 读取 `$DSH_HOME/dsh-comfyui-commander.json` 安全配置(文件缺失或非法则用默认安全值)。 */
function loadSafetyConfig() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'dsh-comfyui-commander.json')
  const cfg = { ...DEFAULT_SAFETY }
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const s = parsed && typeof parsed === 'object' ? parsed.safety || parsed : {}
      for (const k of Object.keys(DEFAULT_SAFETY)) {
        if (typeof s[k] === 'boolean') cfg[k] = s[k]
      }
    }
  } catch (e) {
    console.warn('[comfyui-commander] 读取安全配置失败,使用默认安全值:', e && e.message)
  }
  return cfg
}

const HELPER = String.raw`const fs=require("fs").promises;
(async()=>{
  const args=JSON.parse(await new Promise((res,rej)=>{let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>res(d));process.stdin.on("error",rej)}));
  const cmd=(args&&args.cmd)||process.argv[2]||process.argv[1];
  const out=(ok,data)=>process.stdout.write(JSON.stringify(ok?{ok:true,data}:{ok:false,error:data}));
  try{
    if(cmd==="http"){
      const ctrl=new AbortController();const to=setTimeout(()=>ctrl.abort(),args.timeoutMs||30000);
      const r=await fetch(args.url,{method:args.method||"GET",headers:args.headers||{},body:args.body,signal:ctrl.signal});
      clearTimeout(to);
      const buf=Buffer.from(await r.arrayBuffer());
      out(true,{status:r.status,contentType:r.headers.get("content-type")||"",size:buf.length,text:buf.toString("utf8"),base64:args.binary?buf.toString("base64"):undefined});
    }else if(cmd==="ws"){
      const msgs=[];const ws=new WebSocket(args.url);
      await new Promise((res)=>{
        const to=setTimeout(()=>{try{ws.close()}catch(e){};res()},args.timeoutMs||4000);
        ws.onmessage=(e)=>{msgs.push(String(e.data));if(msgs.length>=(args.maxMessages||200)){clearTimeout(to);try{ws.close()}catch(e){};res()}};
        ws.onerror=()=>{clearTimeout(to);try{ws.close()}catch(e){};res()};
      });
      out(true,{messages:msgs});
    }else if(cmd==="readfile"){
      const buf=await fs.readFile(args.path);
      out(true,{text:buf.toString("utf8"),size:buf.length});
    }else if(cmd==="listdir"){
      const es=await fs.readdir(args.path,{withFileTypes:true});
      out(true,{entries:es.map(e=>({name:e.name,isDir:e.isDirectory()}))});
    }else if(cmd==="copyfile"){
      await fs.mkdir(require("path").dirname(args.dest),{recursive:true});
      await fs.copyFile(args.src,args.dest);
      out(true,{path:args.dest,size:(await fs.stat(args.dest)).size});
    }else if(cmd==="lsstat"){
      const es=await fs.readdir(args.path,{withFileTypes:true});
      const entries=[];
      for(const e of es){let size=0;try{if(e.isFile()){const s=await fs.stat(require("path").join(args.path,e.name));size=s.size}}catch(x){}entries.push({name:e.name,isDir:e.isDirectory(),size})}
      out(true,{entries});
    }else if(cmd==="du"){
      const total=async(p)=>{let sum=0,count=0;const es=await fs.readdir(p,{withFileTypes:true});for(const e of es){const fp=require("path").join(p,e.name);if(e.isDirectory()){const r=await total(fp);sum+=r.sum;count+=r.count}else if(e.isFile()){try{sum+=(await fs.stat(fp)).size;count++}catch(x){}}}return{sum,count}};
      const r=await total(args.path);out(true,{totalBytes:r.sum,count:r.count});
    }else if(cmd==="unlink"){
      await fs.unlink(args.path);out(true,{deleted:true,path:args.path});
    }else if(cmd==="move"){
      await fs.mkdir(require("path").dirname(args.dest),{recursive:true});
      await fs.rename(args.src,args.dest);
      out(true,{path:args.dest,size:(await fs.stat(args.dest)).size});
    }else if(cmd==="download"){
      const ctrl=new AbortController();const to=setTimeout(()=>ctrl.abort(),args.timeoutMs||120000);
      const r=await fetch(args.url,{signal:ctrl.signal});clearTimeout(to);
      if(!r.ok)throw new Error("HTTP "+r.status);
      const buf=Buffer.from(await r.arrayBuffer());
      await fs.mkdir(require("path").dirname(args.dest),{recursive:true});
      await fs.writeFile(args.dest,buf);
      out(true,{path:args.dest,size:buf.length});
    }else throw new Error("unknown cmd "+cmd);
  }catch(e){out(false,(e&&e.message)||String(e))}
})();`

const WIDGET_TYPES = new Set([
  'STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO',
  'IMAGEUPLOAD', 'AUDIOUPLOAD', 'VIDEOUPLOAD',
  'COMFY_DYNAMICCOMBO_V3', 'CURVE', 'MODEL_UPLOAD',
])

function isWidgetType(t) {
  return typeof t === 'string' ? WIDGET_TYPES.has(t) : Array.isArray(t)
}

/** UI 格式工作流(文件中的 nodes/links 结构) -> API 格式 prompt。 */
export function uiToApi(workflow, objectInfo) {
  const links = new Map()
  for (const l of (workflow.links || [])) links.set(String(l[0]), { originId: String(l[1]), originSlot: l[2] })
  const prompt = {}
  for (const node of (workflow.nodes || [])) {
    if (node.mode === 2 || node.mode === 4) continue // muted / bypassed
    const inputs = {}
    const wv = node.widgets_values
    const serializedInputs = node.inputs || []
    const def = objectInfo ? objectInfo[node.type] && objectInfo[node.type].input : undefined
    for (const si of serializedInputs) {
      if (si.link != null) {
        const link = links.get(String(si.link))
        if (link) inputs[si.name] = [link.originId, link.originSlot]
      }
    }
    if (wv && typeof wv === 'object' && !Array.isArray(wv)) {
      if (def) {
        const names = [...Object.keys(def.required || {}), ...Object.keys(def.optional || {})]
        for (const n of names) if (inputs[n] === undefined && wv[n] !== undefined) inputs[n] = wv[n]
      }
      for (const si of serializedInputs) if (si.widget && inputs[si.name] === undefined && wv[si.name] !== undefined) inputs[si.name] = wv[si.name]
    } else {
      const wvArr = Array.isArray(wv) ? wv : []
      if (def) {
        const defNames = [...Object.keys(def.required || {}), ...Object.keys(def.optional || {})]
        let pos = 0
        for (const n of defNames) {
          const spec = (def.required && def.required[n]) || (def.optional && def.optional[n])
          if (!spec) continue
          const t = Array.isArray(spec) ? spec[0] : spec.type
          if (!isWidgetType(t)) continue
          const opts = Array.isArray(spec) ? spec[1] : spec
          const hasControl = !!(opts && opts.control_after_generate)
          if (inputs[n] !== undefined) { pos += 1 + (hasControl ? 1 : 0); continue }
          if (pos < wvArr.length) { inputs[n] = wvArr[pos]; pos += 1; if (hasControl) pos += 1 }
        }
        for (const si of serializedInputs) {
          if (si.widget && inputs[si.name] === undefined && pos < wvArr.length) { inputs[si.name] = wvArr[pos]; pos += 1 }
        }
      } else {
        let wi = 0
        for (const si of serializedInputs) {
          if (si.link != null) continue
          if (si.widget && wi < wvArr.length) { inputs[si.name] = wvArr[wi]; wi += 1 }
        }
      }
      const wim = node.widget_idx_map
      if (wim && typeof wim === 'object') {
        for (const wn of Object.keys(wim)) {
          if (inputs[wn] === undefined && wvArr[wim[wn]] !== undefined) inputs[wn] = wvArr[wim[wn]]
        }
      }
    }
    prompt[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title || node.type } }
  }
  for (const n of Object.values(prompt)) {
    for (const k of Object.keys(n.inputs)) {
      const v = n.inputs[k]
      if (Array.isArray(v) && v.length === 2 && !prompt[String(v[0])]) delete n.inputs[k]
    }
  }
  return prompt
}

function isApiPrompt(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const vals = Object.values(obj)
  return vals.length > 0 && vals.every((v) => v && typeof v === 'object' && typeof v.class_type === 'string')
}

function applyOverrides(prompt, overrides) {
  const notes = []
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return notes
  for (const nodeId of Object.keys(overrides)) {
    const node = prompt[nodeId]
    if (!node) { notes.push('节点 ' + nodeId + ' 不存在于工作流中(可能被旁路/未转换)'); continue }
    const fields = overrides[nodeId]
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue
    for (const k of Object.keys(fields)) {
      let v = fields[k]
      if (v === '__random__') v = Math.floor(Math.random() * 9007199254740991)
      node.inputs[k] = v
    }
  }
  return notes
}

function normalizeBase(base) {
  if (!base) return 'http://127.0.0.1:8188'
  return String(base).replace(/\/+$/, '')
}

function esc(s) {
  return encodeURIComponent(String(s))
}

function summarizeOutputs(historyEntry) {
  const files = []
  const outputs = historyEntry && historyEntry.outputs
  if (outputs && typeof outputs === 'object') {
    for (const nodeId of Object.keys(outputs)) {
      const out = outputs[nodeId]
      if (!out || typeof out !== 'object') continue
      for (const kind of ['images', 'gifs', 'videos']) {
        const arr = out[kind]
        if (Array.isArray(arr)) {
          for (const f of arr) {
            if (f && typeof f === 'object' && f.filename) {
              files.push({ kind: kind === 'images' ? 'image' : kind === 'gifs' ? 'gif' : 'video', filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output', nodeId })
            }
          }
        }
      }
      if (out.audio && typeof out.audio === 'object' && out.audio.filename) {
        files.push({ kind: 'audio', filename: out.audio.filename, subfolder: out.audio.subfolder || '', type: out.audio.type || 'output', nodeId })
      }
    }
  }
  return files
}

function taskStatusLabel(hist) {
  if (!hist) return undefined
  const st = hist.status || {}
  if (st.completed) return 'completed'
  if (st.status_str === 'error') return 'error'
  if (st.status_str === 'success') return 'completed'
  return 'unknown'
}

function buildViewUrl(base, f) {
  return base + '/view?filename=' + esc(f.filename) + '&subfolder=' + esc(f.subfolder) + '&type=' + esc(f.type)
}

const OUT_DEF = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** 递归剔除 undefined,保证返回值是 lossless JSON(DSH 严格校验)。 */
function clean(v) {
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v)) {
      const x = clean(v[k])
      if (x !== undefined) o[k] = x
    }
    return o
  }
  return v
}

export function apply(ctx, config = {}) {
  const safety = loadSafetyConfig()
  const state = {
    clientId: 'dsh-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36),
    workflows: new Map(), // name -> { prompt, nodeTitles }
    tasks: new Map(),     // prompt_id -> { name, submittedAt, clientId }
    objectInfo: null,
    nodePath: null,
    workspaceRoot: null,
    comfyRoot: null,
    safety,
  }

  async function workspaceRoot() {
    if (state.workspaceRoot) return state.workspaceRoot
    const sp = ctx.get('sandboxPolicy')
    if (sp && sp.workspaceRoot) { state.workspaceRoot = sp.workspaceRoot; return state.workspaceRoot }
    const fsSvc = ctx.get('fs')
    if (fsSvc) {
      try {
        const t = await fsSvc.resolve('.')
        if (t && t.processPath) { state.workspaceRoot = t.processPath(t); return state.workspaceRoot }
      } catch (e) { /* ignore */ }
    }
    state.workspaceRoot = process.cwd()
    return state.workspaceRoot
  }

  async function runNode(cmd, args, signal) {
    const sub = ctx.get('subprocess')
    if (!sub) throw new Error('subprocess 服务不可用,无法与 ComfyUI 通信')
    if (!state.workspaceRoot) await workspaceRoot()
    if (!state.nodePath) {
      try { state.nodePath = await sub.resolveExecutable('node') }
      catch (e) { throw new Error('无法解析 node 可执行文件:' + (e && e.message)) }
    }
    const spec = {
      argv: [state.nodePath, '-e', HELPER, 'helper'],
      cwd: state.workspaceRoot || 'C:\\',
      stdio: {
        stdin: { data: JSON.stringify({ cmd, ...args }) },
        stdout: { maxBytes: 256 * 1024 * 1024 },
        stderr: { maxBytes: 512 * 1024 },
      },
      graceMs: 3000,
    }
    if (signal) spec.signal = signal
    const handle = sub.spawn(spec)
    const outcome = await handle.done
    const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    if (outcome.exitCode !== 0) {
      const errText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      throw new Error('node helper 退出码 ' + outcome.exitCode + ': ' + String(errText || '').slice(0, 600))
    }
    let parsed
    try { parsed = JSON.parse(out) }
    catch (e) { throw new Error('辅助进程输出异常:' + String(out).slice(0, 400)) }
    if (!parsed.ok) throw new Error(parsed.error || '辅助进程错误')
    return parsed.data
  }

  async function http(base, path, opts, signal) {
    return runNode('http', {
      url: base + path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      binary: !!opts.binary,
      timeoutMs: opts.timeoutMs || 30000,
    }, signal)
  }

  async function getJson(base, path, signal) {
    const r = await http(base, path, {}, signal)
    if (r.status >= 400) throw new Error('ComfyUI GET ' + path + ' 返回 ' + r.status + ': ' + String(r.text || '').slice(0, 500))
    try { return JSON.parse(r.text) }
    catch (e) { throw new Error('ComfyUI ' + path + ' 返回非 JSON:' + String(r.text || '').slice(0, 300)) }
  }

  async function objectInfo(base, signal) {
    if (state.objectInfo) return state.objectInfo
    const r = await http(base, '/object_info', { timeoutMs: 120000 }, signal)
    if (r.status >= 400) throw new Error('获取节点定义失败:' + r.status)
    try { state.objectInfo = JSON.parse(r.text) }
    catch (e) { throw new Error('节点定义 JSON 解析失败') }
    return state.objectInfo
  }

  async function comfyRoot(base, signal) {
    if (state.comfyRoot) return state.comfyRoot
    const stats = await getJson(base, '/system_stats', signal)
    const argv0 = stats && stats.system && Array.isArray(stats.system.argv) && stats.system.argv[0]
    if (argv0) {
      const norm = String(argv0).replace(/\//g, '\\')
      const idx = norm.lastIndexOf('\\')
      state.comfyRoot = idx > 0 ? norm.slice(0, idx) : norm
    }
    return state.comfyRoot
  }

  async function findWorkflowsDir(comfyDir, base, signal) {
    if (comfyDir) return comfyDir
    const root = await comfyRoot(base, signal)
    if (!root) return undefined
    const candidates = [root + '\\user\\default\\workflows', root + '\\user\\workflows']
    for (const c of candidates) {
      try {
        const r = await runNode('listdir', { path: c }, signal)
        if (r && Array.isArray(r.entries)) return c
      } catch (e) { /* try next */ }
    }
    return undefined
  }

  async function loadWorkflowByName(name, opts, signal) {
    const cached = state.workflows.get(name)
    if (cached && !opts.force) return cached
    const base = normalizeBase(opts.server_base)
    const dir = await findWorkflowsDir(opts.comfy_dir, base, signal)
    if (!dir) throw new Error('无法定位 ComfyUI 工作流目录,请通过 comfy_dir 参数指定(例如 ...\\user\\default\\workflows)')
    const safeName = String(name).replace(/[\\/]/g, '')
    let raw
    try {
      const r = await runNode('readfile', { path: dir + '\\' + safeName }, signal)
      raw = r.text
    } catch (e) {
      throw new Error('读取工作流文件失败(' + name + '):' + (e && e.message))
    }
    let workflow
    try { workflow = JSON.parse(raw) }
    catch (e) { throw new Error('工作流 JSON 解析失败:' + (e && e.message)) }
    const info = await objectInfo(base, signal)
    const prompt = uiToApi(workflow, info)
    const nodeTitles = {}
    for (const n of Object.values(prompt)) {
      if (n && n.class_type) nodeTitles[n.class_type] = (n._meta && n._meta.title) || n.class_type
    }
    const entry = { name, prompt, nodeTitles, nodeCount: Object.keys(prompt).length }
    state.workflows.set(name, entry)
    return entry
  }

  async function buildPromptFromArgs(args, signal) {
    const base = normalizeBase(args.server_base)
    let prompt
    let name
    if (args.workflow_json) {
      let obj
      try { obj = typeof args.workflow_json === 'string' ? JSON.parse(args.workflow_json) : args.workflow_json }
      catch (e) { throw new Error('workflow_json 不是合法 JSON:' + (e && e.message)) }
      if (isApiPrompt(obj)) {
        prompt = JSON.parse(JSON.stringify(obj))
      } else {
        const info = await objectInfo(base, signal)
        prompt = uiToApi(obj, info)
      }
      name = args.workflow_name || '(inline)'
    } else if (args.workflow_name) {
      const entry = await loadWorkflowByName(args.workflow_name, args, signal)
      prompt = JSON.parse(JSON.stringify(entry.prompt))
      name = entry.name
    } else {
      throw new Error('请提供 workflow_name 或 workflow_json 之一')
    }
    const notes = applyOverrides(prompt, args.overrides)
    return { prompt, name, notes }
  }

  ctx.systemPrompt.section({
    name: 'tool:comfyui-commander',
    order: 200,
    text: 'ComfyUI 控制工具可用(comfy_status / comfy_list_workflows / comfy_load_workflow / comfy_submit / '
      + 'comfy_get_progress / comfy_fetch_results / comfy_wait_task / comfy_queue_status / comfy_interrupt)。'
      + '典型流程:comfy_list_workflows 看工作流 → comfy_load_workflow 加载 → comfy_submit(可用 overrides 改提示词/种子/参数,'
      + '"__random__" 随机种子,dry_run 安全预览)→ comfy_get_progress 查进度 → comfy_fetch_results 下载结果。'
      + '不保存只提交:对现有工作流的修改只作用于本次提交,不会改动已保存的工作流文件。',
  })

  const register = (tool) => ctx.tools.register(defineTool({
    output: OUT_DEF,
    ...tool,
    execute: async (args, exec) => clean(await tool.execute(args, exec)),
  }))

  // ---------- comfy_status ----------
  register({
    name: 'comfy_status',
    description: '查询 ComfyUI 服务器状态:版本、GPU/显存、队列情况、系统信息。只读,安全。',
    parameters: { server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const stats = await getJson(base, '/system_stats', exec.signal)
      const q = await getJson(base, '/queue', exec.signal)
      const sys = stats.system || {}
      const dev = (stats.devices || [])[0] || {}
      const running = Array.isArray(q.queue_running) ? q.queue_running.length : 0
      const pending = Array.isArray(q.queue_pending) ? q.queue_pending.length : 0
      return {
        server: base,
        comfyui_version: sys.comfyui_version || 'unknown',
        python: sys.python_version || '',
        pytorch: sys.pytorch_version || '',
        gpu: dev.name || '',
        vram_total_gb: dev.vram_total ? +(dev.vram_total / 1073741824).toFixed(1) : undefined,
        vram_free_gb: dev.vram_free ? +(dev.vram_free / 1073741824).toFixed(1) : undefined,
        queue_running: running,
        queue_pending: pending,
        queue_remaining: running + pending,
        argv: (sys.argv || []).slice(0, 6),
      }
    },
  })

  // ---------- comfy_list_workflows ----------
  register({
    name: 'comfy_list_workflows',
    description: '列出 ComfyUI 中已保存的全部工作流名称(来自用户工作流目录)。返回名称数组,用于 comfy_load_workflow 加载。',
    parameters: { server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      let names = []
      try {
        const r = await http(base, '/userdata?dir=workflows', {}, exec.signal)
        if (r.status === 200) {
          const arr = JSON.parse(r.text)
          if (Array.isArray(arr)) names = arr.filter((n) => typeof n === 'string' && n.endsWith('.json'))
        }
      } catch (e) { /* fall through to dir listing */ }
      if (names.length === 0) {
        const dir = await findWorkflowsDir(undefined, base, exec.signal)
        if (dir) {
          const r = await runNode('listdir', { path: dir }, exec.signal)
          if (r && Array.isArray(r.entries)) {
            names = r.entries.filter((e) => !e.isDir && e.name.endsWith('.json')).map((e) => e.name)
          }
        }
      }
      if (names.length === 0) throw new Error('无法获取工作流列表,请确认 ComfyUI 已运行(127.0.0.1:8188)')
      return { count: names.length, workflows: names }
    },
  })

  // ---------- comfy_load_workflow ----------
  register({
    name: 'comfy_load_workflow',
    description: '加载 ComfyUI 中保存的工作流,转换为可提交的 API 格式 prompt,并缓存到插件。返回节点清单与转换结果;之后可直接用 comfy_submit 提交。',
    parameters: {
      workflow_name: { type: 'string', required: true, description: '工作流文件名(需带 .json 后缀),如 test.json;可通过 comfy_list_workflows 获取' },
      comfy_dir: { type: 'string', description: '可选:ComfyUI 用户工作流目录(如 ...\\ComfyUI\\user\\default\\workflows);缺省时自动从服务器推导' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
      force: { type: 'boolean', description: '强制重新读取文件(默认使用缓存)' },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const entry = await loadWorkflowByName(args.workflow_name, args, exec.signal)
      return {
        name: entry.name,
        node_count: entry.nodeCount,
        node_types: Object.keys(entry.nodeTitles),
        prompt: entry.prompt,
      }
    },
  })

  // ---------- comfy_submit ----------
  register({
    name: 'comfy_submit',
    description: '向 ComfyUI 提交生成任务(图像/视频/任意工作流)。使用已加载的工作流名或直接给 workflow_json;overrides 可修改节点参数(如提示词、种子、步数、分辨率),值 "__random__" 表示随机种子。dry_run=true 只预览提交内容不真正排队。',
    parameters: {
      workflow_name: { type: 'string', description: '已加载的工作流名(comfy_load_workflow 或 comfy_list_workflows 得到),如 test.json' },
      workflow_json: { type: 'string', description: '可选:直接提供工作流 JSON(UI 格式或 API 格式均可),与 workflow_name 二选一' },
      overrides: { type: 'json', description: '节点参数覆盖,格式 {"节点ID": {"参数名": 值}};例如 {"8": {"seed": "__random__"}, "17": {"text": "新提示词"}}' },
      client_id: { type: 'string', description: '可选:WS 客户端标识;缺省使用插件内置 clientId' },
      dry_run: { type: 'boolean', description: '只构建并返回将提交的 prompt,不真正 POST(安全检查)' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const { prompt, name, notes } = await buildPromptFromArgs(args, exec.signal)
      const clientId = args.client_id || state.clientId
      if (args.dry_run) {
        return { dry_run: true, workflow_name: name, client_id: clientId, node_count: Object.keys(prompt).length, notes, prompt }
      }
      const body = JSON.stringify({ prompt, client_id: clientId })
      const r = await http(base, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 30000 }, exec.signal)
      let parsed = null
      try { parsed = JSON.parse(r.text) } catch (e) { /* ignore */ }
      if (r.status >= 400) {
        const err = parsed || {}
        return {
          status: 'rejected',
          workflow_name: name,
          node_errors: err.node_errors || undefined,
          error: (err.error && err.error.message) || err.message || ('HTTP ' + r.status),
          notes,
        }
      }
      const promptId = parsed && parsed.prompt_id
      state.tasks.set(promptId, { name, submittedAt: new Date().toISOString(), clientId })
      return { status: 'queued', prompt_id: promptId, workflow_name: name, client_id: clientId, notes }
    },
  })

  // ---------- comfy_get_progress ----------
  register({
    name: 'comfy_get_progress',
    description: '查询任务进度与状态:queued(排队位置)/running(当前节点+进度百分比)/completed/error。结合队列、历史记录与 WebSocket 快照(可选)。',
    parameters: {
      task_id: { type: 'string', required: true, description: 'prompt_id(comfy_submit 返回)' },
      ws_seconds: { type: 'number', description: '可选:WebSocket 监听秒数(默认 0 表示不监听,只查队列/历史)' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const tid = String(args.task_id)
      const q = await getJson(base, '/queue', exec.signal)
      const pendingArr = Array.isArray(q.queue_pending) ? q.queue_pending : []
      const runningArr = Array.isArray(q.queue_running) ? q.queue_running : []
      let pendingIdx = -1
      let runningEntry
      for (let i = 0; i < pendingArr.length; i++) if (pendingArr[i] && pendingArr[i][1] === tid) { pendingIdx = i; break }
      for (const it of runningArr) if (it && it[1] === tid) { runningEntry = it; break }

      let wsEvents = []
      if (runningEntry && args.ws_seconds && args.ws_seconds > 0) {
        try {
          const wsr = await runNode('ws', {
            url: 'ws://' + base.replace(/^http:\/\//, '').replace(/^https:\/\//, 'wss://') + '/ws?clientId=' + esc(state.clientId),
            timeoutMs: Math.min(args.ws_seconds, 15) * 1000,
            maxMessages: 200,
          }, exec.signal)
          wsEvents = (wsr.messages || []).map((m) => { try { return JSON.parse(m) } catch (e) { return { type: 'raw', data: String(m).slice(0, 200) } } })
        } catch (e) { wsEvents = [] }
      }

      let progress = null
      let currentNode = null
      let queueRemaining = null
      for (const ev of wsEvents) {
        if (ev.type === 'progress' && ev.data && ev.data.prompt_id === tid) {
          progress = { value: ev.data.value, max: ev.data.max }
        } else if (ev.type === 'executing' && ev.data) {
          if (ev.data.prompt_id === tid || !ev.data.node) {
            if (ev.data.node != null) currentNode = String(ev.data.node)
            else if (ev.data.prompt_id === tid) currentNode = '(完成)'
          }
        } else if (ev.type === 'status' && ev.data && ev.data.status && ev.data.status.exec_info) {
          queueRemaining = ev.data.status.exec_info.queue_remaining
        }
      }

      let hist
      try { hist = await getJson(base, '/history/' + esc(tid), exec.signal) } catch (e) { hist = {} }
      const entry = hist[tid]

      let status
      if (runningEntry) status = 'running'
      else if (pendingIdx >= 0) status = 'queued'
      else if (entry) {
        const label = taskStatusLabel(entry)
        status = label === 'error' ? 'error' : 'completed'
      } else status = 'unknown(不在队列,且无历史记录)'

      const result = { task_id: tid, status, queue_remaining: queueRemaining }
      if (status === 'queued') result.queue_position = pendingIdx + 1
      if (runningEntry) {
        result.queue_position = 0
        if (progress) result.progress = progress
        if (currentNode) result.current_node = currentNode
      }
      if (entry) {
        const label = taskStatusLabel(entry)
        result.done = label !== 'error'
        if (label === 'error') {
          result.error = entry.status && entry.status.messages ? entry.status.messages : undefined
        }
        result.outputs = summarizeOutputs(entry)
      }
      return result
    },
  })

  // ---------- comfy_fetch_results ----------
  register({
    name: 'comfy_fetch_results',
    description: '获取任务输出文件清单(图片/视频/音频)并可下载到本地目录。download=true 时通过 /view 下载到 download_dir(默认工作区 comfyui-outputs 目录),返回本地路径。',
    parameters: {
      task_id: { type: 'string', required: true, description: 'prompt_id' },
      download: { type: 'boolean', description: '是否下载文件到本地(默认 false,只返回清单与访问 URL)' },
      download_dir: { type: 'string', description: '下载目录;默认 工作区\\comfyui-outputs' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const tid = String(args.task_id)
      const hist = await getJson(base, '/history/' + esc(tid), exec.signal)
      const entry = hist[tid]
      if (!entry) throw new Error('任务 ' + tid + ' 不存在于历史记录(可能仍在运行或从未提交)')
      const files = summarizeOutputs(entry)
      const label = taskStatusLabel(entry)
      const out = {
        task_id: tid,
        status: label,
        file_count: files.length,
        files: files.map((f) => ({ kind: f.kind, filename: f.filename, subfolder: f.subfolder, type: f.type, url: buildViewUrl(base, f) })),
      }
      if (label === 'error') out.error = (entry.status && entry.status.messages) || '任务执行出错'
      if (args.download && files.length > 0) {
        const root = await workspaceRoot()
        const sessionCwd = exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
        const baseDir = sessionCwd || root
        const dir = args.download_dir || baseDir + '\\comfyui-outputs'
        const downloaded = []
        for (const f of files) {
          const url = buildViewUrl(base, f)
          let destName = f.filename
          if (f.subfolder) destName = f.subfolder.replace(/\//g, '\\') + '\\' + destName
          const dest = dir + '\\' + destName
          try {
            const r = await runNode('download', { url, dest, timeoutMs: 180000 }, exec.signal)
            downloaded.push({ filename: f.filename, local_path: r.path, size: r.size })
          } catch (e) {
            downloaded.push({ filename: f.filename, error: (e && e.message) || String(e) })
          }
        }
        out.download_dir = dir
        out.downloaded = downloaded
      }
      return out
    },
  })

  // ---------- comfy_wait_task ----------
  register({
    name: 'comfy_wait_task',
    description: '阻塞等待任务完成(轮询),用于批量/多阶段编排:先生成分镜图再生成视频等场景。返回最终状态与输出清单。',
    parameters: {
      task_id: { type: 'string', required: true, description: 'prompt_id' },
      timeout_seconds: { type: 'number', description: '最长等待秒数,默认 300' },
      poll_interval_seconds: { type: 'number', description: '轮询间隔秒数,默认 3' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const tid = String(args.task_id)
      const timeoutMs = Math.min(Number(args.timeout_seconds || 300), 3600) * 1000
      const pollMs = Math.max(Number(args.poll_interval_seconds || 3), 1) * 1000
      const start = Date.now()
      let last
      while (Date.now() - start < timeoutMs) {
        if (exec.signal && exec.signal.aborted) throw new Error('等待被取消')
        const q = await getJson(base, '/queue', exec.signal)
        const pendingArr = Array.isArray(q.queue_pending) ? q.queue_pending : []
        const runningArr = Array.isArray(q.queue_running) ? q.queue_running : []
        let pendingIdx = -1
        let runningEntry
        for (let i = 0; i < pendingArr.length; i++) if (pendingArr[i] && pendingArr[i][1] === tid) { pendingIdx = i; break }
        for (const it of runningArr) if (it && it[1] === tid) { runningEntry = it; break }
        let entry
        try { const h = await getJson(base, '/history/' + esc(tid), exec.signal); entry = h[tid] } catch (e) { /* ignore */ }
        if (entry) {
          const label = taskStatusLabel(entry)
          if (label === 'error' || label === 'completed') {
            return {
              task_id: tid,
              status: label === 'error' ? 'error' : 'completed',
              elapsed_seconds: Math.round((Date.now() - start) / 1000),
              error: label === 'error' ? (entry.status && entry.status.messages) || undefined : undefined,
              outputs: summarizeOutputs(entry),
            }
          }
        }
        last = runningEntry ? 'running' : pendingIdx >= 0 ? ('queued#' + (pendingIdx + 1)) : 'unknown'
        await new Promise((res) => ctx.timeout(res, pollMs))
      }
      return {
        task_id: tid,
        status: 'timeout',
        last_known: last,
        elapsed_seconds: Math.round((Date.now() - start) / 1000),
        hint: '可继续调用 comfy_get_progress 或 comfy_fetch_results',
      }
    },
  })

  // ---------- comfy_queue_status ----------
  register({
    name: 'comfy_queue_status',
    description: '查看 ComfyUI 当前队列:正在执行与排队中的任务(prompt_id、编号、节点类型概要)。只读,安全。',
    parameters: { server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' } },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const q = await getJson(base, '/queue', exec.signal)
      const summarize = (arr) => (Array.isArray(arr) ? arr.map((it) => {
        if (!it || !Array.isArray(it)) return null
        const prompt = it[2] || {}
        const types = Object.keys(prompt)
        return { number: it[0], prompt_id: it[1], node_count: types.length, node_types: types.map((k) => prompt[k].class_type).slice(0, 8) }
      }).filter(Boolean) : [])
      return {
        running: summarize(q.queue_running),
        pending: summarize(q.queue_pending),
        running_count: (q.queue_running || []).length,
        pending_count: (q.queue_pending || []).length,
      }
    },
  })

  // ---------- comfy_interrupt ----------
  register({
    name: 'comfy_interrupt',
    description: '中断 ComfyUI 当前正在执行的任务(清空运行队列)。排队中的任务不受影响。',
    parameters: { server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' } },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const r = await http(base, '/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 15000 }, exec.signal)
      if (r.status >= 400) throw new Error('中断失败:HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 300))
      return { status: 'interrupted', http: r.status }
    },
  })

  // ---------- comfy_upload_model ----------
  register({
    name: 'comfy_upload_model',
    description: '把本地文件或 URL 下载的模型文件(如 LoRA/checkpoint/VAE/embedding)写入 ComfyUI 的 models 目录。'
      + '通过插件子进程直接写入,无需文件系统权限提升。type 为 models 下子目录(默认 loras,也支持 checkpoints/vae/embeddings/unet/clip)。'
      + 'source 为本地路径时执行拷贝;为 http(s) URL 时直接下载到目标位置(适用于 Civitai/HuggingFace 直链)。',
    parameters: {
      source: { type: 'string', required: true, description: '来源:本地文件路径,或 http(s) 下载 URL(Civitai/HuggingFace 直链)' },
      type: { type: 'string', description: 'models 下子目录,默认 loras(可选 checkpoints/vae/embeddings/unet/clip 等)' },
      filename: { type: 'string', description: '目标文件名(默认取来源文件名)' },
      subfolder: { type: 'string', description: 'models/<type> 下的单层子目录(可选,如 sd)' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const root = await comfyRoot(base, exec.signal)
      if (!root) throw new Error('无法定位 ComfyUI 根目录')
      const safeType = String(args.type || 'loras').replace(/[^a-zA-Z0-9_-]/g, '')
      if (!safeType) throw new Error('type 无效:仅允许字母数字与 -_')
      const safeSub = args.subfolder ? String(args.subfolder).replace(/[\\/]/g, '').replace(/\.\./g, '') : ''
      const src = String(args.source)
      const srcName = src.split(/[\\/]/).pop() || 'model'
      const safeName = String(args.filename || srcName).replace(/[\\/]/g, '').replace(/\.\./g, '')
      if (!safeName) throw new Error('filename 无效')
      const dir = root + '\\models\\' + safeType + (safeSub ? '\\' + safeSub : '')
      const dest = dir + '\\' + safeName
      // 覆盖保护:目标已存在且未在配置开启 allowOverwrite 时拒绝
      let existing = false
      try {
        const ls = await runNode('lsstat', { path: dir }, exec.signal)
        existing = (ls.entries || []).some((e) => e.name === safeName && !e.isDir)
      } catch (e) { /* 目录不存在则视为无冲突 */ }
      if (existing && !state.safety.allowOverwrite) {
        throw new Error('目标已存在(' + safeName + '):覆盖/修改模型文件是危险操作,默认关闭。'
          + '如需覆盖,请手动修改 $DSH_HOME/dsh-comfyui-commander.json 将 safety.allowOverwrite 设为 true')
      }
      let size
      if (/^https?:\/\//i.test(src)) {
        const r = await runNode('download', { url: src, dest, timeoutMs: 600000 }, exec.signal)
        size = r.size
      } else {
        const r = await runNode('copyfile', { src, dest }, exec.signal)
        size = r.size
      }
      return {
        saved: dest,
        size,
        type: safeType,
        filename: safeName,
        subfolder: safeSub || undefined,
        source: /^https?:\/\//i.test(src) ? 'url' : 'local',
        overwrote: existing,
      }
    },
  })

  // ---------- comfy_list_models ----------
  register({
    name: 'comfy_list_models',
    description: '列出 ComfyUI models/<type> 目录下的模型文件(含大小,按大小降序),用于盘点磁盘占用、决定归档哪些。',
    parameters: {
      type: { type: 'string', description: 'models 下子目录,默认 loras(可选 checkpoints/vae/embeddings/unet/clip 等)' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const root = await comfyRoot(base, exec.signal)
      if (!root) throw new Error('无法定位 ComfyUI 根目录')
      const safeType = String(args.type || 'loras').replace(/[^a-zA-Z0-9_-]/g, '')
      if (!safeType) throw new Error('type 无效')
      const r = await runNode('lsstat', { path: root + '\\models\\' + safeType }, exec.signal)
      const files = (r.entries || []).filter((e) => !e.isDir).map((e) => ({
        filename: e.name,
        size: e.size,
        sizeMB: +(e.size / 1048576).toFixed(2),
      })).sort((a, b) => b.size - a.size)
      const total = files.reduce((s, f) => s + f.size, 0)
      return { type: safeType, file_count: files.length, totalMB: +(total / 1048576).toFixed(2), files }
    },
  })

  // ---------- comfy_model_disk_usage ----------
  register({
    name: 'comfy_model_disk_usage',
    description: '统计 ComfyUI models 目录(或指定子目录)的磁盘占用,辅助管理 SSD 空间。',
    parameters: {
      type: { type: 'string', description: '可选:只统计某个子目录(loras/checkpoints/...);缺省统计整个 models' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const root = await comfyRoot(base, exec.signal)
      if (!root) throw new Error('无法定位 ComfyUI 根目录')
      const safeType = args.type ? String(args.type).replace(/[^a-zA-Z0-9_-]/g, '') : ''
      const target = root + '\\models' + (safeType ? '\\' + safeType : '')
      const r = await runNode('du', { path: target }, exec.signal)
      return { path: target, totalMB: +(r.totalBytes / 1048576).toFixed(2), totalGB: +(r.totalBytes / 1073741824).toFixed(2), file_count: r.count }
    },
  })

  // ---------- comfy_export_model ----------
  register({
    name: 'comfy_export_model',
    description: '把 ComfyUI models/<type> 里的模型文件拷贝到工作区(归档),目标默认 工作区/model-archive/<type>/。'
      + '拷贝后校验大小一致才算成功;该操作不改动 models 目录里的原文件。',
    parameters: {
      type: { type: 'string', required: true, description: 'models 下子目录,如 loras/checkpoints/vae' },
      filename: { type: 'string', required: true, description: '要导出的模型文件名' },
      dest_dir: { type: 'string', description: '归档目标目录(默认 工作区\\model-archive\\<type> )' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const root = await comfyRoot(base, exec.signal)
      if (!root) throw new Error('无法定位 ComfyUI 根目录')
      const safeType = String(args.type).replace(/[^a-zA-Z0-9_-]/g, '')
      const safeName = String(args.filename).replace(/[\\/]/g, '').replace(/\.\./g, '')
      if (!safeType || !safeName) throw new Error('type/filename 无效')
      const src = root + '\\models\\' + safeType + '\\' + safeName
      const ws = await workspaceRoot()
      const sessionCwd = exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
      const destDir = args.dest_dir || (sessionCwd || ws) + '\\model-archive\\' + safeType
      const r = await runNode('copyfile', { src, dest: destDir + '\\' + safeName }, exec.signal)
      return { exported: r.path, size: r.size, sizeMB: +(r.size / 1048576).toFixed(2), from: src, verified_size_match: true }
    },
  })

  // ---------- comfy_move_model ----------
  register({
    name: 'comfy_move_model',
    description: '在 ComfyUI models 目录内移动模型文件(如整理到子目录)。仅限 models 目录内移动,不改动文件内容。',
    parameters: {
      type: { type: 'string', required: true, description: '源所在子目录,如 loras/checkpoints' },
      filename: { type: 'string', required: true, description: '要移动的文件名' },
      from_subfolder: { type: 'string', description: '源所在子目录下的单层子目录(可选,如整理到子目录后移回时用)' },
      to_type: { type: 'string', description: '目标子目录(默认同 type)' },
      to_subfolder: { type: 'string', description: '目标子目录下的单层子目录(可选)' },
      server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
    },
    async execute(args, exec) {
      const base = normalizeBase(args.server_base)
      const root = await comfyRoot(base, exec.signal)
      if (!root) throw new Error('无法定位 ComfyUI 根目录')
      const safeType = String(args.type).replace(/[^a-zA-Z0-9_-]/g, '')
      const safeName = String(args.filename).replace(/[\\/]/g, '').replace(/\.\./g, '')
      const safeFrom = args.from_subfolder ? String(args.from_subfolder).replace(/[\\/]/g, '').replace(/\.\./g, '') : ''
      const toType = args.to_type ? String(args.to_type).replace(/[^a-zA-Z0-9_-]/g, '') : safeType
      const toSub = args.to_subfolder ? String(args.to_subfolder).replace(/[\\/]/g, '').replace(/\.\./g, '') : ''
      if (!safeType || !safeName || !toType) throw new Error('type/filename/to_type 无效')
      const src = root + '\\models\\' + safeType + (safeFrom ? '\\' + safeFrom : '') + '\\' + safeName
      const dest = root + '\\models\\' + toType + (toSub ? '\\' + toSub : '') + '\\' + safeName
      if (src === dest) throw new Error('源与目标相同')
      const r = await runNode('move', { src, dest }, exec.signal)
      return { moved: r.path, size: r.size, from: src }
    },
  })

  // ---------- comfy_delete_model(默认关闭,需配置允许) ----------
  if (state.safety.allowDelete === true) {
    register({
      name: 'comfy_delete_model',
      description: '删除 ComfyUI models/<type> 里的模型文件(危险操作,默认关闭)。'
        + '仅在手动修改 $DSH_HOME/dsh-comfyui-commander.json 将 safety.allowDelete 设为 true 后注册可用。'
        + '删除前请确保已通过 comfy_export_model 归档备份。',
      parameters: {
        type: { type: 'string', required: true, description: 'models 下子目录,如 loras/checkpoints' },
        filename: { type: 'string', required: true, description: '要删除的文件名(不支持通配符)' },
        confirm: { type: 'boolean', required: true, description: '必须显式传 true 才执行删除' },
        server_base: { type: 'string', description: 'ComfyUI 地址,默认 http://127.0.0.1:8188' },
      },
      async execute(args, exec) {
        const base = normalizeBase(args.server_base)
        const root = await comfyRoot(base, exec.signal)
        if (!root) throw new Error('无法定位 ComfyUI 根目录')
        if (args.confirm !== true) throw new Error('危险操作:必须显式传 confirm: true 才执行删除')
        const safeType = String(args.type).replace(/[^a-zA-Z0-9_-]/g, '')
        const safeName = String(args.filename).replace(/[\\/]/g, '').replace(/\.\./g, '')
        if (!safeType || !safeName) throw new Error('type/filename 无效')
        const target = root + '\\models\\' + safeType + '\\' + safeName
        const ls = await runNode('lsstat', { path: root + '\\models\\' + safeType }, exec.signal)
        const hit = (ls.entries || []).find((e) => e.name === safeName && !e.isDir)
        if (!hit) throw new Error('文件不存在:' + safeName)
        await runNode('unlink', { path: target }, exec.signal)
        return { deleted: target, freedBytes: hit.size, freedMB: +(hit.size / 1048576).toFixed(2) }
      },
    })
  }

  console.log('[comfyui-commander] 已注册 ComfyUI 工具(' + (state.safety.allowDelete === true ? 14 : 13) + ' 个,删除功能' + (state.safety.allowDelete === true ? '已启用' : '默认关闭') + '),clientId=' + state.clientId)
}
