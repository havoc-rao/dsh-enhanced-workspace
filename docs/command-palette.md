# commandPalette 可选对接

工作区插件客户端通过 `installWorkspacePalette(ctx)` 的可选
`ctx.inject(['commandPalette'], paletteCtx => …)` 安装贡献。服务缺席不影响侧栏；
所有字典、贡献和 locale 订阅由注入子上下文 effect 管理，服务失效/插件卸载时
注销自己的贡献，不 dispose 共享 palette 服务。运行时代码仅 type-import `/core` 契约。

## 唯一生产入口与兼容回退

支持 `registerPanel` 的 palette 上，安装只调用
[registerFileBrowser](../src/client/command-palette/install-file-browser.tsx)：

- 唯一 command ID：`workspaces.find`。
- target：`{ kind: 'picker', pickerId: 'workspaces.find' }`。标准 Picker 负责工作区列表、搜索、选中、滚动与 Actions。
- command 与 panel 标题：中文「浏览工作区」、英文「Browse Workspaces」。
- command `iconId: 'open'`，category 为「工作区 / Workspace」。
- 注册同 ID 的业务 Picker（复用原 provider 查询，但 accept 打开文件树而非新建会话）；不额外注册 `workspaces.browse-files` command，后者只作为 panel ID 与兼容别名。
- 工作区选择后进入目录树；在浏览器中使用 **⌘L / Ctrl+L** 创建当前工作区的
  新会话并交接导航。新建会话是浏览器动作，不是第二个生产命令入口。

不支持 `registerPanel` 的旧 palette 只调用
[registerWorkspaceProvider](../src/client/command-palette/provider.ts) 回退：
`workspaces.find` 指向 legacy workspace picker，选择工作区后直接创建新会话。
这一分支保留旧 provider 文案与生命周期，不注册缺失的 panel target。

历史上 legacy picker 的命令文案曾由切换工作区改为「选择工作区新建会话 / Create New Session」，
文件浏览器也曾使用单独的 `workspaces.browse-files` 命令入口；这些是兼容历史，
**不是支持 panel 的当前生产安装仍注册两个入口**。

## 两层双语描述与搜索

统一入口复用 [provider](../src/client/command-palette/provider.ts) 导出的稳定 tag：

```ts
const workspaceTag = {
  id: 'workspace',
  title: 'Workspace',
  localizedTitles: { zh: '工作区', en: 'Workspace' },
  iconId: 'workspace',
} as const;
// 唯一 command 的动态 describe：
return {
  pluginTag: workspaceTag,
  iconId: 'open',
  title: text().title, // zh: 浏览工作区；en: Browse Workspaces
  localizedTitles: { zh: '浏览工作区', en: 'Browse Workspaces' },
  category: /* 当前语言的工作区 / Workspace */,
  aliases: /* 统一入口兼容别名 */,
};
```

aliases 保留 `workspaces.find`、`workspaces.browse-files`，旧新建会话、浏览工作区文件、
切换/搜索/打开工作区中英文关键词，以及文件树、复制路径、文件引用等浏览器关键词。
因此旧 `create new session`、`Browse Workspace Files`、`切换工作区` 搜索仍只找到
同一个浏览工作区入口；别名不恢复旧执行语义。中文 title 不拼接英文后缀。

tag 与 child 的 zh/en 都是可选字段，纯英文、仅 title 的旧 provider 都合法。
主标题与 tag 按 locale 解析；仅中文 locale 显示不重复的独立英文翻译纯文本
（无 EN 标签），英文 locale 不显示中文次标题。

tag 的 ID/title/zh/en 和 child 的 ID/title/zh/en、aliases/category 全部由 palette
做 fuzzy 搜索（精确、前缀、子串、顺序非连续字符），所有 token 均需匹配，可跨层
命中；例如 `wsp swt`、`工区 switch` 通过兼容别名找到统一入口。
命令搜索不会改变 legacy picker 自身的资源查询逻辑。

## 图标与资源边界

真实契约公开 `PaletteIconId = 'workspace' | 'git' | 'search' | 'create' | 'open'`。
本仓库使用类型安全的纯数据字段，不导入 React 图标、不传 ReactNode/原始 SVG，
也不把组件名写入旧 `icon` 文本或用 emoji 假装 SVG。

| 贡献 | 字段与取值 | palette UI 映射的 DSH 共享组件 |
| --- | --- | --- |
| 总 tag `workspace`（工作区 / Workspace） | `pluginTag.iconId: 'workspace'` | `IconWorkspaceTreeOutlineRegular` |
| 唯一 command `workspaces.find`（浏览工作区 / Browse Workspaces，target 为 picker） | `CommandDescriptor.iconId: 'open'` | `IconFolderOpenOutlineRegular` |
| 生产与 legacy fallback picker 的工作区资源项 | `PickerItem.iconId: 'workspace'` | `IconWorkspaceTreeOutlineRegular` |

命令图标表示打开工作区浏览器，不改为放大镜。总 tag 不受子命令覆盖影响；legacy
资源项显式使用 workspace 图标，**不继承 tag**，包括直接打开 picker 的场景。
未知 icon ID 与旧文本兼容由 palette resolver 按其回退协议处理。

## 生命周期与创建边界

- browser panel 的 `render` 承载组件及当前调用捕获的输入框引用；关闭/卸载释放调用，
  过期输入框不允许插入引用。目录树/预览通过插件 RPC，不读取侧栏 DOM。
- 浏览器新建会话动作调用公开 adapter `createNewSession`；实际键盘交互、工作区阶段
  切换和创建/导航取消边界由组件测试验证。
- legacy fallback picker 使用完整宿主目录，queryMode 为 local；匹配名称、显示名、
  路径和 basename，排序、截断并返回 hasMore，不读取侧栏折叠/过滤后的 DOM。
- adapter 调用 `sessions.create({ workspaceId })` 创建新身份（不传现有 sessionId、
  不复用空会话），await 后检查 signal/连接/目录与成员，再 `uiWorkspace.openSession(sessionId)`。
  取消不会回滚已提交的创建，但阻止尚未交接的导航；创建失败不打开旧会话。
  completed 表示创建完成并已交接导航，不承诺视图加载完成。
- workspace/session/connection 订阅随实际激活的 browser 组件或 fallback picker 管理；
  locale 改变动态刷新描述。贡献注册失败回滚，卸载释放对应的 command/panel 或 picker。

## 验证

[command-palette.spec.ts](../tests/command-palette.spec.ts) 保留旧 provider 独立测试，
使用真实 `createPaletteController` 验证支持 panel 时唯一 command + panel、两层双语
描述与图标、旧新 aliases 搜索、动态 locale、panel render 的 adapter 与 dispose；
不支持 panel 时独立验证 fallback 安装、adapter 创建新会话、导航取消保护与订阅清理。
实际 browser `createNewSession` 交互由下述组件测试验证。

这不是宿主浏览器端验证；不据此宣称当前 GUI 已挂载、SVG 或快捷键已部署。
契约依据：[palette 对接协议](../../dsh-command-palette/docs/cmd-integration.md)。

## 文件引用选择器

`workspaces.find` 先打开 CMD 标准 Picker，确认工作区后调用 `openPanel` 打开 `workspaces.browse-files` panel，以「选择目标 → 插入引用」为主路径：

- 导航只分工作区选择与目录树两层；选中文件不会进入新的预览层，Panel 的 back 返回 false，由 CMD 返回原 Picker 并恢复其搜索、选中与滚动；不再业务自画列表或管理 hover/activeWorkspace。
- 文件树无预览时占满宽度；显示预览时宽屏按 65% / 35% 分配。内容预览可以关闭，选择在本次挂载内保留；窄屏默认关闭，手动开启后以下方较小辅助区显示。
- CMD Actions 展示当前目标；未选中文件时以工作区根路径为目标。实际插入使用绝对路径，不额外渲染业务引用底栏。
- 单击/方向键选择文件，Enter 直接插入并关闭；目录的 Enter 只展开/收起，目录引用通过 Actions 或行内插入按钮完成。复制路径保留为次级操作。
- 预览请求延迟 150ms，并在切换目标或关闭预览时取消。预览错误只显示在辅助区域，不影响引用插入及输入框捕获/过期保护。
- 嵌入 palette 时，隐藏文件只通过 Actions 的「显示隐藏文件」切换，不再额外渲染 checkbox。action 使用 `status: { kind: 'toggle', checked: state.hidden, label }` 提供右侧只读状态标记；标题保持稳定，label 描述当前状态（隐藏文件：已显示 / 已隐藏），用于 tooltip 与辅助阅读。执行返回 `stay`，重新打开 Actions 时读取最新状态。无 palette shell 的独立浏览器保留 checkbox 回退。

回归覆盖见 [组件测试](../tests/file-browser.client.spec.tsx) 与 [面板集成测试](../tests/file-browser-command.client.spec.tsx)。

## 标准 Picker / 文件树 Panel 的职责与捕获时点

- 工作区列表只贡献纯数据 query/accept/getActions，不渲染列表。查询复用名称、路径匹配、当前工作区优先、limit/hasMore 与订阅失效逻辑。
- Picker Actions 保留三项：新建会话、复制绝对根路径、插入整个工作区引用；隐藏文件与预览开关仅在 Panel。
- Picker Actions 在 getActions 调用时捕获当前 inputActions、binding key 和 insertion span；执行重新检查 signal、工作区身份/路径、连接与 binding。此捕获不发生在 query/describe，也不修改共享 context。
- 文件树 Panel 在 onOpen 捕获 composer。这比旧版“打开含工作区列表的 Panel 时捕获”更晚：现在实际进入文件树才捕获，Back 后重新进入会重新捕获。关闭/退出令 adapter 失效，预览请求取消，过期绑定不得插入。
- Picker accept 先校验并设置一次性 workspaceId，再调用 openPanel；该调用中止原 accept signal 属于正常导航，成功后返回 stay，不误报取消。
- 直接打开 Panel 没有一次性工作区选择时仅显示“选择工作区”提示，不默认选择首项、不触发目录 RPC、不捕获 composer。
- CMD 负责 Picker Actions 捕获选中项、查询、编号、执行与返回；stay 恢复原 Picker。需要同时装载支持 Picker.getActions 的 CMD 版本。
