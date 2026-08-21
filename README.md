# dsh-comfyui-commander

让 DeepSeek Harness (DSH) 的 Agent 通过自然语言**全自动控制 ComfyUI**:
加载工作流、改造参数与节点结构、提交生成(图像/视频)、实时监控进度、下载结果、批量/多阶段编排。

> Let DSH agents fully control ComfyUI through natural language — list/load workflows,
> modify parameters or recombine nodes, submit image/video generations, watch progress
> in real time, download results, and orchestrate batch pipelines.

为 DSH 提供完整的 ComfyUI 控制面:生成任务管理、工作流转换与重组、进度监控、结果获取,以及模型文件的盘点/归档/上传/移动(危险操作默认走安全门控)。

## ✨ 功能 / Features

| 工具 Tool | 作用 What it does |
| :--- | :--- |
| `comfy_status` | 服务器状态:版本、GPU/显存、队列 |
| `comfy_list_workflows` | 列出全部已保存工作流 |
| `comfy_load_workflow` | 加载工作流并转换为 API 格式(UI→API 转换器) |
| `comfy_submit` | 提交生成任务;`overrides` 改任意节点参数、`"__random__"` 随机种子、`dry_run` 安全预览 |
| `comfy_get_progress` | 进度/状态:排队位置、当前节点、采样百分比(队列+历史+WebSocket) |
| `comfy_fetch_results` | 输出清单 + 下载到本地(图片/视频/音频) |
| `comfy_wait_task` | 阻塞等待完成(批量/多阶段编排) |
| `comfy_queue_status` | 队列详情(只读) |
| `comfy_interrupt` | 中断当前任务 |
| `comfy_upload_model` | 上传/下载模型到 models(本地拷贝或 URL 直链,type=loras/checkpoints/vae/embeddings/unet/clip) |
| `comfy_list_models` | 列出 models/<type> 文件(含大小,降序) |
| `comfy_model_disk_usage` | 统计 models 磁盘占用 |
| `comfy_export_model` | 归档:拷贝模型到 工作区\model-archive\<type>\ 并校验大小 |
| `comfy_move_model` | models 目录内移动(支持子目录移回) |
| `comfy_delete_model` | ⚠️ 仅安全配置 `allowDelete: true` 时注册,且需 `confirm: true` |

## 🔑 核心特性 / Highlights

- **零外部运行时依赖**:通过 `ctx.subprocess` 派生 `node -e` 辅助进程,用 Node 全局 `fetch`/`WebSocket` 与 ComfyUI(默认 `http://127.0.0.1:8188`)通信;仅需本机 Node ≥ 22。
- **不保存只提交**:对现有工作流的任何改造只作用于本次提交,绝不改动已保存的工作流文件;也支持通过官方 `/userdata` API 把新工作流写入库。
- **真实 UI→API 转换**:依据 ComfyUI 前端 `graphToPrompt` 算法(节点定义有序 widget + `control_after_generate` 标志 + 序列化 inputs 链接对齐),标准节点 100% 一致。
- **工作流重组**:Agent 可基于现有工作流增删节点、改连线、跨工作流拼接,通过 `workflow_json` 直接提交。
- **自动定位**:从 `system_stats.argv[0]` 推导 ComfyUI 安装目录,无需手配路径。

## 📦 安装 / Install

### 方式一:npm(推荐)

1. 在你的 DSH profile(`$DSH_HOME/profiles/<name>/`)添加依赖与 bundle:

   ```bash
   cd $DSH_HOME/profiles/<name>
   pnpm add dsh-comfyui-commander
   ```

2. 在 profile 的 `cordis.patch.yml` 添加插件行:

   ```yaml
   - insert:
       - id: comfyui-commander
         name: 'dsh-comfyui-commander'
   ```

3. 重启 dsh。

### 方式二:插件市场

提交市场后,可用 `find_plugin` 搜索「ComfyUI」并一键安装。

## 🚀 使用示例 / Usage

> 「列出工作流 → 加载 `SDXL.json` → 改成文生图 → 提示词换成 'a cat, masterpiece' → 生成 → 下载到本地」

Agent 自动编排:`comfy_list_workflows` → `comfy_load_workflow` → `comfy_submit(overrides)` → `comfy_get_progress` → `comfy_fetch_results(download)`。

批量编排:「先生成 5 张分镜,全部完成后用合并工作流合成视频」——用 `comfy_wait_task` 串行编排。

## 🔒 安全配置 / Safety config

模型文件操作遵循**默认安全、危险操作需手动开启**的原则。配置文件:`$DSH_HOME/dsh-comfyui-commander.json`:

```json
{
  "safety": {
    "allowDelete": false,    // 删除模型文件:默认关闭
    "allowOverwrite": false, // 覆盖已有模型文件:默认关闭
    "allowModify": false     // 修改:默认关闭
  }
}
```

- **默认允许**:新增(`comfy_upload_model` 写入新文件)、移动(`comfy_move_model`)、导出归档(`comfy_export_model`)、盘点(`comfy_list_models` / `comfy_model_disk_usage`)。
- **默认关闭**:`comfy_delete_model` **不注册**(删除只能走 DSH 审批式权限提升);覆盖已有文件会拒绝。
- **开启**:手动把对应值改为 `true` 并重启 DSH;`comfy_delete_model` 才会注册,且每次删除仍要求显式 `confirm: true`。

## 🗂️ 模型管理闭环(SSD 空间)

低频模型归档到机械盘工作区,需要时再传回:

```
comfy_model_disk_usage → comfy_list_models   (盘点占用)
comfy_export_model                            (归档到 工作区\model-archive\<type>\ ,校验大小)
[删除原文件:默认走 DSH 权限提升;或在配置开启 allowDelete 后用 comfy_delete_model]
comfy_upload_model                            (需要时从 model-archive 传回)
```

## 🏗️ 架构 / Architecture

```
DSH Host (标准 Cordis 插件)
 ├─ ctx.subprocess ──node -e──► fetch/WebSocket ──► ComfyUI (127.0.0.1:8188)
 │     ├─ http : /system_stats /queue /history /prompt /view /userdata /interrupt /object_info
 │     └─ ws   : /ws?clientId= (progress / executing / status 实时消息)
 ├─ uiToApi()  : UI 格式工作流 → API prompt(内置转换器)
 └─ 状态       : 工作流缓存 / 任务表 / object_info 缓存 / clientId
```

## 🛠️ 开发 / Development

```bash
# 本地验证模块可加载(在 profile 目录)
node --input-type=module -e "import('dsh-comfyui-commander').then(m => console.log(m.name, m.inject))"

# 打包验证
npm pack --dry-run
```

## 📤 发布 / Publishing

1. 推送为 **GitHub 公开仓库**(含 `package.json` 的 `dsh.bundle.patch`、`cordis.patch.yml`、`lib/`);
2. **发布到 npm**:`npm login && npm publish`;
3. 市场收录:DSH 插件市场(zat market)索引 GitHub 仓库,公开仓库 + 清晰 README 即可被搜索到。

## ⚠️ 已知边界 / Known limits

- 打开的工作流标签页是浏览器 localStorage 状态,服务端不可枚举(可间接推断最近执行的工作流)。
- 动态 Cordis 插件(本 GUI 的 `cordis_define`/`cordis_run`)注册的工具在部分部署中不可见;标准 npm 插件形态无此问题。

## 📄 许可 / License

[MIT](LICENSE)
