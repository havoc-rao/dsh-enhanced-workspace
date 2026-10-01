# dsh-enhanced-workspace 插件仓库约束

> 面向本仓库的开发与发布约定。实现参照 `DSH-better-sidebar` 的仓库惯例。

## 0. 硬约束（所有本仓库插件必须遵守）

- **禁止修改 DeepSeek Harness (DSH) 源码**：对官方源码 checkout
  （`~/.dsh/source/current` 或本地 fork）零写入——不得改 harness 包、
  不得把 harness 改动提交到它的分支。需要 harness 没有的能力时，用 DSH
  现成的只读/公开 API（如 `ctx.workspaces` / `ctx.sessions` / slots 注入）
  或插件自有实现；确实做不到就先向用户说明取舍，而不是直接改 DSH。
- **代码改动不强制走 PR**：功能 / 修复 / 测试等改动直接提交 / 推送 main；
  仅当 user 明确要求 PR（或要求 review）时，才在分支上开发并用
  `gh pr create` 发起。文档类改动（README / AGENTS.md / docs/ 等）一直
  允许直接推送到 main。
- **挂载只走 `cordis.patch.yml` + profile 机制**（`~/.dsh/profiles/<profile>/`），
  插件永远作为独立包被 profile 引用，不反向侵入 DSH。
- **DSH 市场受管安装兼容约束**：发布清单的 `dependencies` /
  `peerDependencies` / `optionalDependencies` 三字段一律不得出现 `cordis`
  （市场预览按名硬拒，optional 无效），且 `scripts` 不得含 `preinstall` /
  `install` / `postinstall` / `prepare`。
- **客户端 bundle 纯度门**：client bundle 禁止 value-import 平台模块表
  （`CLIENT_EXTERNALS`）之外的 `@deepseek-ai/*` 包（tsdown 的
  `purityGatePlugin` 会挡）；`import type` 会被擦除不触发门禁——类型可自由
  共享，运行时符号不行，所有跨插件协作走 cordis 服务方法调用。

## 1. 仓库布局

```
docs/plan/    设计文档（当前：2026-09-04-plugin-mode-design.md）
src/index.ts        宿主 half（空壳，pure client 插件的挂载载体）
src/client/         客户端 half（遮蔽 sidebar.workspaces 的全部实现）
tests/              纯函数单测 + 组件 spec（*.client.spec.tsx）
scripts/            e2e-mount.sh 挂载冒烟
```

- client bundle 双通道：`lib/client.js`（官方 profile 通道，以包名注册）与
  `lib/client-registry.js`（插件注册表通道，以 manifest id 注册），同源码
  两次编译，唯一差异是注册 id 与输出文件名。
- 客户端消费的 DSH 包必须是平台模块表条目（react / ui-slots /
  ui-primitives / runtime/client）或 inline-safe wire 层，其余
  `@deepseek-ai/*` 值导入会被构建期拒绝。

## 2. 常用命令

```sh
pnpm install
pnpm test                # vitest（纯函数 + 组件 spec）
pnpm typecheck           # tsc --noEmit
pnpm build               # tsc 声明 + tsdown 双通道 bundle
pnpm pack                # 发布产物（与 CI 挂载冒烟一致）
pnpm test:mount          # 挂载冒烟：真实 DSH 无头渲染（需 PATH 上有 dsh）
```

- **开发模式的构建节奏**：本地开发联调时，每**完全完成一个功能点**后，就用
  `pnpm build:dev` 构建一次，再继续下一个功能点——不攒功能点、不跳过构建。
  dev 构建由 `DSH_ENHANCED_WORKSPACE_DEV=1` 显式开启（见 `tsdown.config.ts`
  的 `DEV_BUILD`），使 `src/client/index.tsx` 中 dev-only 的 code-finder
  定位块（Opt+Shift 悬停显示组件源码位置）随包生效，方便在真实 DSH 里对照
  源码核对当前功能点；**不要**用全局 `NODE_ENV=development` 环境变量代替
  （mise/dotfiles 常全局注入它，会让 `pnpm build` 无声变成 dev 构建——
  code-finder 的 `data-locatorjs` 会注入每个元素并改写 dev-only 定位块为
  无条件执行，导致 production 插件出现 React 警告风暴、对话框确认按钮失效；
  详见 2026-09 删除回归）。对外发布一律走 `pnpm build`（production，
  脚本内显式 `DSH_ENHANCED_WORKSPACE_DEV=0` 防环境泄漏）。

## 3. 测试姿势

- 纯函数（model/store）在 node 环境直接断言行为；组件 spec
  （`*.client.spec.tsx`）用 jsdom + `@testing-library/react`，真实 props +
  `vi.fn()` 动作 + fixture 数据 hook（`useStore` 用真实 store 引擎实例），
  断言用户可见行为——沿用 ui-workspace 组件 spec 的姿势（不渲染真实 DSH
  壳，不依赖 fixture runtime 之外的宿主）。

## 4. 已知限制（维护时同步更新）

- 遮蔽形态下内置条目的子槽位不可由插件声明或渲染（单声明者 + 声明 = 渲染
  授权 + 遮蔽 ≠ 卸载）：logo 三槽位（`sidebar.workspaces.workspaceIcon/Menu/
  HoverIcon`）与官方 `sidebar.workspaces.directoryFlow` 均不可用，冲突即抛
  错。添加工作区走插件自有 hole `enhanced-workspace.workspace.directoryFlow`
  （`src/client/contract.ts` 的 `DIRECTORY_FLOW_SLOT`，字符串协议与
  dsh-remote 等 picker 包共享；组合 profile 由 picker 包构建期 ENV
  `DSH_REMOTE_DIRECTORY_FLOW_SLOT` 指向它，默认官方 key），hole 未占用时
  回退 `ctx.workspaces.pickDirectory()`。见
  `docs/plan/2026-09-04-plugin-mode-design.md` §7。
- 目录树为插件本地权威，跨标签页并发编辑 last-writer-wins；Host 平铺顺序
  reconcile（`ctx.workspaces.insertBefore`）失败仅 console.warn。
- 多选（⌘/Ctrl+点击）+ 整组拖拽：选中态是瞬态视图状态（不持久化），
  目录收起时自动修剪不可见行；组解析在 `drag.ts` 纯函数层
  （`resolveGroupDrop` 逐源解析 + 自锚/环/深度预跳过，组内违规成员单独
  跳过不整组作废）。内置行（FolderRow/LeafRow 自绘选中态）与 fileTreeUi
  组合 profile 的框架行（走 provider 一等契约 `selected` +
  `onSelectToggle`，⌘/Ctrl+点击由框架路由、选中 wash/aria-selected 由
  框架渲染；契约自 dsh-file-tree-ui `9cace1e` 起，两者需同版本装载）
  双双支持；repo 组头行与未注册工作树分组行仍是单行拖拽。
- 每个目录层只有一个统一子条目账户 `FolderRecord.children: FolderChild[]`
  （`{kind:'folder'|'workspace', id}`）——目录与工作区同层自由穿插，不再有
  「子目录在前」的固定次序。信封仍是 legacy 双账户形（`workspaceIds` +
  `folderIds`）时**可读不可写**：两侧校验器都接受任一形状（逐记录二选一、
  目录反查按父记录形状解析），`restoredState` 在边界迁移为 `children`
  （子目录在前、工作区在后，等价旧渲染序）；应用层写盘永远是统一形状。
  锚点（拖拽/移动到）一律是 `FolderChild`，指向任意 kind 的兄弟。
- 持久化不走 localStorage（桌面端 webserver 每次启动端口随机，Chromium 按
  origin 含端口分桶，重启即丢）：信封经宿主半 `/enhanced-workspace` RPC
  通道（loopback 权威）原子写入 `~/.dsh/storages/dsh-enhanced-workspace.json`，
  localStorage 仅作同源兜底。宿主与客户端共用 `src/shared/persistence.ts`
  的通道字面量防漂移；改信封结构需同步 `src/host/storage.ts` 的
  `validateEnvelope` 与 `src/client/model.ts` 的 `isPersistedViewState`。
- 恢复时序：Host load 成功且 `baselinesReady` 后才用最新工作区基线恢复；
  此前禁止 adopt / prune、Host 顺序同步和 save。load 失败（含损坏信封）
  禁止本次挂载写盘；只有明确无文件才视为空存储。localStorage 仅在 Host
  确认无信封时参与迁移，不能用来掩盖 Host 读取失败。
