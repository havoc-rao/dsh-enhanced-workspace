# Git Worktree 模式：子工作区派生层与跳转交互设计

> 需求：强化 git worktree 工作流。——主工作区（"外部 space"）在仓库根或某外部
> 路径初始化，大部分业务实际发生在 `tmp/xxx/xxx` 风格的子工作区（仓库内子目录
> 或独立 worktree 路径）。要解决三件事：① 子工作区概念如何在现有树模型上落地；
> ② 能否用 `git worktree list` 检测此状态；③ 「把当前会话切到目标 tree」的交互
> 如何设计。
>
> 结论预览：检测用「`.git` 上行 walk + 元数据文件」（无 exec 主路径，`git
> worktree list --porcelain` 仅作枚举补充）；展示用**与用户树并列的只读派生层**
> （repo 分组视图），不自动改树；切换的诚实语义是**「落位到目标树」**（打开/
> 新建会话），因为 DSH 会话 cwd 创建后不可变、无跨树移动 API，见 §4。

## 1. 现状与约束（决定设计的事实）

### 1.1 DSH 侧约束（已核对 runtime / host-apiproxy 类型）

- `WorkspaceView = { workspaceId, path(规范化绝对路径), title, sessionIds, createdAt, updatedAt }`
  —— 工作区注册的是**路径**；会话落在工作区路径下。
- `session.create` 接受 `workspaceId` 或 `cwd`（二选一）；**cwd 创建后不可变**
  （session API 只有 create / search / rename / fork / prompt / attachment /
  queue 等，无 relocate / reparent）。
- `session.fork` 继承**源会话 cwd**，因此 fork 不能跨树。
- 结论：**不存在「把已有会话移动到另一棵 tree」的原子能力**。任何
  「切换会话到目标树」的 UI 都必须落为：*在目标树打开/新建会话*（可选携带
  标题等轻量信息），并把选中态高光跳到目标。这是本设计 §4 的地基。

### 1.2 插件侧现状（本仓库）

- 浏览器 = 最近使用模块 + 用户文件夹树（≤6 层，envelope 持久化，Host 权威
  RPC 通道 `/enhanced-workspace`，loopback 权威）+ flat 列表；树是**用户
  策展的显示权威**，git 状态与树无关。
- 现有可复用件：行组件 / 行菜单 / Hover 卡片 / 区头搜索 / `startSession` /
  `createWorkspace` / Host RPC 通道（`shared/persistence.ts` 字面量防漂移）。
- 门禁：client bundle 不得 value-import 平台表外 @deepseek-ai 包；不修改 DSH
  本体；Host 半不得反哺 client 数据面（storage.ts 自包含范式）。

## 2. 子工作区概念：树归属 = 会话级（v3 定稿，替代 v2 的 workspace 行直标）

> **v3 核心修正**：树信息（repo / role / branch / detached）**由每个会话的
> cwd 派生**，不是 workspace 属性。workspace 只是注册容器（`path` +
> sessions[]），workspace 行只显示**聚合结果**。对照依据（已核实
> DSH-better-sidebar `FileTree.tsx:1171` `const root = cwd`、:1402 根行
> 操作路径 = 会话 cwd）：DSH 生态里"打开/操作什么路径"本来就是 session cwd
> 决定的，侧栏树归属必须对齐同一个锚点。

两套关系全部**纯函数派生**（输入 = workspacePaths + sessionCwds）：

1. **会话 → 树绑定（session→tree）**：`session.cwd` 上行 `.git` walk →
   `{ repoKey, treePath, role, branch?, detached? }`；无 git → 无绑定。
2. **路径包含（path containment）**：`A.path` 是 `B.path` 路径前缀 → 决定
   subworkspace 的「本工作区」归属；`workspace.path` 在某树根内部 → 「子目录」
   标签。
3. **同仓库边（repo affinity）**：绑定到同一仓库身份键（main `.git` 规范化
   路径）的 trees / workspaces —— 用于「按仓库分组」与「同仓库工作区」跳转列表。

UI 呈现（§4，v3 概念稿定稿）：**整体骨架 1:1 复刻内置** —— 标题「工作区」+
收起/视图选项/添加三图标、搜索栏「搜索会话」、**「最近使用」区块**（独立
`recent:` 键空间）、**「全部」区块**。worktree 能力长在既有语言里：
① **workspace 行 = 聚合 pill**：全部会话同一棵树 → 该树 pill（main 绿 /
分支橙 / detached 紫）；跨树 → 「n 棵」灰标（精确归属见展开后的
subworkspace 组）；无树 → 无 pill（内置原样，零噪音）；② **subworkspace 组**
：workspace 展开后按会话 cwd 的树分组（组头 = chevron + 「本工作区」/分支名
pill + 树路径 chip + 计数），**单组自动平铺**（绝大多数 workspace 保持内置
形态）；③ **「按仓库分组」是视图选项菜单分组区第三项**（`groupBy:
'workspace' | 'repo' | 'flat'`）——repo 组行复用 FolderRow 形态，组内
workspace 按 主树/linked/子目录 排序；**无 git 的 workspace 平铺在全部区块
底部**（灰字说明，不消失在仓库分组里）；④ **未注册树独立成组**：全部区块
底部「未注册工作树」文件夹组（虚线 LeafRow + 行内「注册」按钮），两种分组
模式都渲染；⑤ 交互语义保持内置：点行=展开/收起（不跳转）、点会话行=打开、
＋=新建会话。**树本身零改动**，派生层只读，git 状态变动后刷新即校正，绝不
回写 envelope。可选采纳动作（§5，默认关）不变。

**远程项目（dsh-remote 镜像）——远端 git 状态由 dsh-remote 端点联动**
（已按 dsh-remote 源码核实 + 实装，2026-09-10 M3）：远程会话的 cwd 是本地
镜像路径（`~/.dsh/remote-workspaces/<host>-<user>-<port>/<base>`，会话目录
命名即镜像路径的 URL 编码），镜像同步默认忽略 `.git/`（`lib/ignore.js:81`）
→ 本地 `.git` walk 对镜像恒返回无树。客户端因此**叠加一个远程取数面**：
镜像工作区行 / hover 卡片直接 fetch dsh-remote 宿主半注册在同源 webServer 的
`GET /dsh-remote/git-workspace?local=<本地镜像路径>`（任意镜像内路径都解析到
其属主镜像），一次远端 `git status --porcelain -b`（+detached 短 sha），
5s 端点 TTL 缓存（`?refresh=1` 绕过）；返回的 marker
（`{isRepo, branch|detached, dirty, staged, ahead, behind, upstream, gone,
root, remotePath, machine, mirrorDir, at}`）经纯函数 overlay 合并进本地
probe：每个 marker 生成一棵**虚拟 remote 树**（`role: 'remote'`，root 按
属主机器命名空间隔离 `remote:<machine>:<remotePath>`）并把镜像根与镜内会话
cwd 绑定到它——既有派生（行聚合 / subworkspace 分组 / 按仓库分组 / 未注册
树 / 搜索）零改动即对远程工作区生效；行 pill 额外显示 `⎇ branch`
（与 dsh-remote 自身 chip 一致；脏/暂存计数不再展示——用户反馈「太占位置」
「不需要展示这个数值」，蓝色 accent 与本地 amber/green 区分），hover 卡片
显示远端 git 段（分支 / ↑↓ 同步 / 远端机器 / 远端路径）。失败姿势全家桶
（HTTP 500/501 无凭据/离线、marker:null 非镜像、isRepo:false 非仓库、畸形
响应、网络错误）一律静默降级为无标记，绝不阻塞浏览器；浏览器侧按路径
memo + 5s TTL。本地非镜像工作区行为完全不变。

## 3. 检测：`.git` 上行 walk（主）+ `git worktree list --porcelain`（辅）

### 3.1 已实证的 git 落盘形态（2026-09-10 实测，git 2.x）

- **main worktree**：根目录下 `.git/` 是**目录**。
- **linked worktree**：根目录下 `.git` 是**文件**，内容 `gitdir: <abs>`，
  `<abs>` 形如 `<main>.git/worktrees/<name>`（`<name>` = worktree 路径
  basename，含引号/花括号转义，非分支名）；该 admin 目录内有：
  - `commondir`：相对路径（如 `../..`），resolve 到 main `.git` 目录；
  - `HEAD`：`ref: refs/heads/<branch>`（在分支）或裸 sha（detached）；
  - `gitdir`：绝对反向引用 `<worktreeRoot>/.git`（对称可逆）。
- **submodule**：`.git` 文件指向 `../.git/modules/<name>` → 分类为**嵌套仓库**
  （独立身份键），不当作同仓库兄弟树。
- `git worktree list --porcelain`：逐树记录 `worktree <path>`（需要时
  C 风格转义）+ `HEAD <sha>` + `branch refs/heads/…` | `detached` | `bare`，
  空行分隔 —— 稳定机器格式，枚举全集、含 bare/detached 标志。

### 3.2 算法（Host 半 `src/host/git.ts`，纯文件读 + 可选 exec）

**输入 = workspace paths + session cwds 的并集**（v3：树归属是会话级的，
probe 必须覆盖会话 cwd；同一树根的多个路径共享一次 walk）。

1. **定位**（每个路径一次）：从 `path` 上行至多 64 层找首个含 `.git`
   （文件或目录）的目录 → 得到 `(worktreeRoot, role)`。
   - `.git/` 目录 → `role = main`，仓库身份键 = 该 `.git` 路径；
   - `.git` 文件 → 解析 `gitdir:`，后缀含 `/worktrees/` → linked 树，身份键 =
     `commondir` resolve 出的 main `.git`；后缀含 `/modules/` → submodule，
     身份键 = 自身 gitdir；
   - 找不到 → `role = none`（普通目录，仅参与路径包含边）。
2. **枚举**（按仓库身份键去重，一次/仓库）：默认扫 `<mainGitDir>/worktrees/*`
   （每项读 `gitdir` 反向引用得树根、`HEAD` 得分支）——零 exec、零 PATH
   依赖；**可选** exec `git worktree list --porcelain` 兜底（worktrees 目录
   与 walk 冲突/被移动时）并补充 `bare` 标志。
3. **缓存与失效**：probe 结果驻 Host 内存，按 (`.git` / admin 目录 / 相关
   worktree 根) 的 stat mtime 集合做失效键；TTL 下限 5s；浏览器 focus 时
   客户端主动 `refresh`；区头提供手动刷新。probe 失败一律**软失败**——
   `gitIndex = {}`，浏览器继续无派生层，绝不影响树与持久化。
4. **安全**：只读元数据；所有路径经绝对化 + 归一化校验；exec 只允许
   `git worktree list --porcelain` 且 `-C` 目录必须是 walk 命中的树根
   （无 shell 插值、超时 2s、stderr 丢弃）。

### 3.3 RPC 与共享字面量

- 扩展既有 `/enhanced-workspace` 通道：新增 endpoint `git/probe`
  （入参：workspace 路径数组；出参：`GitRepoIndex`，见 §6 类型）。
- 字面量进 `src/shared/persistence.ts`（改名面或新增 `src/shared/git.ts`
  共享端点常量，保持"两端共享拼写防漂移"范式）。
- Host 实现完全自包含（不 import client 数据面），沿用 storage.ts 范式。

## 4. 切换交互设计（核心，v2 概念稿定稿）

原则：**交互给"目标感"，语义给"诚实感"**——用户要的是"我现在在 A 树干活，
换到 B 树继续"，UI 提供的是一键落位，而不是假装搬动会话。**全部落在既有
交互面**（内置无 ⌘K 弹层，v1 的 Quick Switcher 弹层废弃）：

### 4.1 跳转（Jump）——hover 卡片内的「同仓库树」列表

- 工作区行 hover 卡片（复用内置 HoverCard 形态）在标题/路径/创建时间之上
  增加：分支、角色（主树/ linked / 子目录）、**同仓库树列表**（含未注册树，
  行内 pill）。
- 点击列表项 = **落位**：展开目标行 + 打开其最近会话（无会话则新建）——
  目标树成为"当前"高光（`containsCurrent` / 折叠链逐层保留）。
- 搜索（复用「搜索会话」输入框，零新入口）：分支名 / 仓库名 / 路径段 /
  会话标题均可命中；命中时组内只保留匹配行、最近使用区块隐藏——跨树定位
  的主文本通道。展开态不自动改变（与内置 filter 行为一致）。

### 4.2 「在目标树继续」——会话级语义（行菜单子菜单）

- 来源：工作区行 ⋯ 菜单新增「在目标树继续…」（子菜单 = 同 repo 其它树）。
- 动作 = 目标树 `create` 新会话（可复用其 blank）+ 可选沿用源会话标题
  （`rename`）+ `open`。**不携带对话上下文**，菜单文案明示
  （"新开会话（不携带上下文）"）。
- 明确的非目标：不提供"移动会话"；fork 跨树不可能（继承 cwd），不做
  假选项。若未来 DSH 提供 reloc api，此入口原地升级为真移动。

### 4.3 未注册树行（两种分组模式下都渲染在「全部」底部独立组）

- 「未注册工作树」文件夹组：检测到树但无 workspace → 组内虚线 LeafRow：
  `⊕ <分支|@短sha> <路径>` + 行内「注册」按钮；⋯ 菜单 = 注册为工作区 /
  在文件管理器中显示。
- 已注册 workspace 被删除（仅删注册，目录仍在）→ 下次 probe 自动恢复
  「未注册」行，自愈。
- worktree 被 `git worktree remove` → 行消失；若其 workspace 仍存在，
  降级为普通目录 workspace（无分支 pill），树不受影响。
- 行内分支 pill 出现在每一类工作区行（最近使用区同样有），是 worktree 状态
  的行级视觉锚点。

### 4.4 一致性

- 树（envelope）永远权威；派生层永远只读缓存。两者冲突时（例如用户手动
  把 worktree 行移进文件夹），不做对抗：按仓库分组视图按"位"显示，树按
  "用户策展"显示 —— 两组视图并存，各司其职。
- 展开状态：仓库组行 key 用 `repo:` 前缀、最近使用行用 `recent:` 前缀
  （RECENT_GROUP_KEY_PREFIX 同款），存 envelope，随清账。
- 检测刷新入口：仓库组行 ⋯ 菜单「重新检测 git」+ focus 自动刷新（无头部
  新按钮，保持三图标不变）。

## 5. 可选采纳（默认关，独立里程碑）

- **Pin**：单棵树「固定为文件夹」= 在用户树上创建/复用同名文件夹并把该
  workspace 移入（`createFolderIn` + `moveWorkspaceIn`，幂等）。git 状态
  流动（树被 remove）时 pin 的文件夹保留但行退化为普通 workspace ——
  pin 是"把当前结构存个快照"，不是"追踪 git"。
- **全量整理**（`组织成仓库文件夹`）：一 repo 一键建文件夹 + 迁移全部行。
  提供 `undo`（记录迁移 delta，还原 = 逆向 move）。风险：与用户手动布局
  冲突；故默认不提供入口，Pin 优先。
- 采纳动作都走现有 model 纯函数，可单测；不改变派生层逻辑。

## 6. 数据面落点（本仓库文件级）

### 6.1 宿主半

- `src/host/git.ts`（新）：`probeGit(workspacePaths, opts) → GitRepoIndex`；
  walk / 枚举 / 缓存 / 失效键 / exec 兜底；纯函数部分（gitdir 解析、
  路径归一、porcelain 解析）独立导出供单测（node 环境直接断言）。
- `src/index.ts`：channel 注册扩展 `git/probe` endpoint。

### 6.2 共享层

- `src/shared/git.ts`（新）：channel 相对端点字面量 `GIT_PROBE_ENDPOINT`；
  `GitRepoIndex` / `GitTreeInfo` / `WorkspaceGitBinding` 的 JSON 形状与
  Host 侧校验（结构安全边界，仿 validateEnvelope 严格性）。

### 6.3 客户端数据面

- `src/client/model.ts`（纯函数，node 单测）：
  - `bindSessionTrees(sessions, gitIndex)` → SessionId → TreeRef（会话级
    绑定，v3 核心）；
  - `deriveSubworkspaces(ws, sessions, bindings)` → 组列表（own / 每树一组，
    单组平铺判定）；
  - `deriveGitForest(gitIndex, workspaces, folders, view)` → repo 分组森林
    （复用 `WorkspaceLeaf` 行形态；组行 = `RepoNode{ repoKey, members:
    WorkspaceLeaf[], nogit: WorkspaceLeaf[], unregistered: GitTreeInfo[] }`）；
  - `wsTreeSet` 聚合（行 pill：单树 / 「n 棵」/ 无）与 `pathContainment`；
  - `registerTree` 采纳（= `createWorkspace` + adopt 到根级头部）。
- `src/client/store.ts`：`gitProbe: GitRepoIndex | null`（只读缓存态）+
  `refreshGitProbe()` action（focus 轮询 / 仓库组菜单刷新）；
  envelope 扩展：`groupBy` 枚举加 `'repo'`（`'workspace' | 'repo' | 'flat'`，
  默认 `'workspace'`，用户手动选择后持久化；拍板 8.5 的概念稿默认演示
  `'repo'` 仅为原型态）+ `repo:` / `recent:` 前缀展开键；
  `retainLiveKeys` 同步扩展前缀。
- `src/client/contract.ts`：注入面新增 `probeGit`（经 persistence 同款
  connection handle）与 `registerTree(path)`（=`createWorkspace` 别名）。
- `src/host/storage.ts`：`PersistedEnvelope` / `ENVELOPE_KEYS` /
  `validateEnvelope` 同步 `groupBy: 'repo'` 枚举与新展开键（无形状破坏，
  旧信封缺省兼容，恢复时补默认值）。

### 6.4 UI

- `src/client/Browser.tsx`：`ViewOptionsMenu` 分组区加「按仓库分组」项；
  GroupedView 按 `groupBy` 渲染 repo 森林（组行复用 FolderRow 形态）或用户
  树；全部区块底部渲染「未注册工作树」组。行组件复用 + 行内分支 pill +
  hover 卡片扩展（git 信息 + 同仓库树列表）+ 行菜单「在目标树继续…」/
  「重新检测 git」。
- 组件 spec：repo 分组渲染 / 未注册组 / 卡片跳转 / 键空间独立（recent: vs
  ws:）/ 搜索组内过滤断言（jsdom + 真实 store 引擎 + fixture gitIndex 快照）。

## 7. 里程碑

- **M1 检测面**：`src/host/git.ts` walk+porcelain、RPC `git/probe`、
  model 派生/绑定纯函数（含单测：main/linked/detached/submodule/无 git/
  含空格路径、porcelain 解析、缓存失效键）；未注册树行 + 注册动作。
- **M2 派生视图与交互**：`groupBy: 'repo'`（视图选项菜单分组区第三项）与
  repo 分组渲染（trees 在前 / 纯子目录在后）、未注册工作树独立组、行内
  分支 pill、hover 卡片扩展（git 信息 + 同仓库树跳转）、行菜单「在目标树
  继续…」与「重新检测 git」、搜索组内过滤；focus 刷新。
- **M3 收尾**：最近使用区与树区键空间独立（`recent:` 前缀清账）、折叠链
  跟随、溢出复位与收起所有的一致性；组件 spec 补全。
- **M4 可选采纳**：Pin 单树（幂等 + undo delta）；e2e 挂载冒烟补 repo 视图
  断言；README/design doc/status.md 同步。

## 8. 拍板记录（2026-09-10）

1. **子目录与 worktree 都展示**：repo 视图行序 = worktree 树行在前、
   仓库内纯子目录行在后（路径包含边合并进视图，见 §2 呈现与 §6.3 类型）。
2. **分组入口 = 视图选项菜单（v2 概念稿定稿，取代 treeView 开关）**：
   分组区三选一「按工作区分组 / 按仓库分组 / 在一个列表中」；envelope 存
   `groupBy` 枚举；不设 auto 解析（用户显式选择，默认 workspace）。
3. **「在目标树继续」v1 = 位置 + 标题沿用**（不携带上下文，明示）；
   附件/草稿搬运等 DSH 提供消息复制能力后再升级。
4. **exec git 允许作兜底**：walk 为主；walk 与 `worktrees/` 目录冲突或需
   `bare` 标志时，每仓库每次刷新至多一次 `git worktree list --porcelain`
   （超时 2s、失败静默降级）。
5. **v2 概念稿定稿**（2026-09-10，`docs/git-worktree-ui-concept.html`）：
   骨架 1:1 复刻内置（工作区/最近使用/全部 + 行形态 + hover 卡片 + 行菜单 +
   搜索），Quick Switcher 弹层废弃（搜索承担文本定位）；未注册树 = 全部区块
   底部独立文件夹组；点行=展开、点会话=打开、＋=新建（内置语义不改变）。
6. **v3 定稿：树归属 = 会话级**（2026-09-10）：workspace 行不再直接标树，
   树信息由 session.cwd 派生（对齐 DSH-better-sidebar FileTree `root = cwd`
   的既有锚点）；workspace 行只出聚合（单树 pill / 跨树「n 棵」/ 无树无）；
   workspace 展开按 cwd 树分 subworkspace 组（单组平铺）；无 git workspace
   全形态回退内置（行无 pill、卡片「未检测到 git 仓库」、「在目标树继续…」
   灰置、按仓库分组时平铺底部）；probe 输入扩展为 workspace paths +
   session cwds。

## 9. 已知限制（维护时同步）

- 会话 cwd 不可变：无真"跨树移动"；'继续'是新建语义（§1.1、§4.2）。
- worktree admin 目录名与路径 basename 的转义规则（引号/花括号）不做
  还原，按 basename 展示即可（实测 `wt-feat` / `spaced` 均等于 basename）。
- 网络盘/不可读目录：probe 软失败降级，不阻塞其余功能。
- 派生层不落盘（除展开键与 groupBy 选择）；git 状态变化以刷新为准（focus /
  仓库组菜单「重新检测 git」）。