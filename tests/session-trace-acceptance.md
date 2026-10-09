# cmd space 新建会话：跨工作区采集验收

## 当前实现

插件所有新建会话入口共用 `createPaletteSession`，以公开可选 `sessions.observeCreation()` 获取 Host 能力。旧版本没有该方法时原样调用 `sessions.create()`；能力获取失败或 Host 未启用时回退普通创建。观察到业务失败不能重试创建。

选中采集时：同一既有 create RPC 关联 Host 随机 Peer 绑定令牌，Host 负责 OTel runtime。浏览器不安装 SDK，不发送外部 trace context。

导航前安装 `whenOpened(id, signal)` 被动等待，导航仍由原 `uiWorkspace.openSession(id)` 负责。诊断不额外 retain、不预打开会话、不新增历史 I/O。正常 palette 关闭不取消已经交接的观测。独立 30 秒 deadline 清理等待；超时不会取消创建、导航或主视图工作。

## 信号边界

- 扩展 owner：`dsh-enhanced-workspace`。
- Host owner：`@deepseek-ai/dsh-api-session-controller`，独立配置选择。
- Host 阶段：`session.create`、`session.create.ensureSession`、`session.create.agentInitialization`、`session.create.attachSession`。
- Client 阶段：`client.createRoundTrip`、`client.catalogProjection`、`client.retainBinding`、`client.initialOpen`，新增 `client.observationBegin`、`client.rpcWait`、`client.rpcResponse`、`client.historyOpen`、`client.followBaselineDecode`、`client.projectionApply`、`client.historyApply`。
- Gateway 阶段：`gateway.prepare`、`gateway.dispatch`、`gateway.resultEncode`，独立 owner `@deepseek-ai/dsh-api-gateway`。
- Carrier 阶段：`client.requestEncode`、`client.fetchHeaders`、`client.responseDecode`，独立 owner `@deepseek-ai/dsh-client-connection`；fetchHeaders 包含 Host/传输/调度，不能称纯网络耗时。
- 最新两个 owner 尚未获得扩大本地配置的批准，当前活动 profile 仍只选择最初两 owner。
- 命令阶段：`command.navigation`、`command.entryToReady`。
- 成功表示对象层 `openState === 'open'`，不是 DOM commit、paint、focus 或首个输入可用。
- V2 上报相对起止及独立 outcome，保留浏览器阶段顺序/间隔。Host begin issuance 锚点与浏览器 begin response origin 仍有传播调度误差，不是同步时钟；旧协议仍 duration-only。
- beginDurationMs 单独计为 client.observationBegin。command.entryToReady 以 -beginDurationMs 为起点，保留总耗时包含 begin 的口径；仅这两个阶段允许审核过的 pre-origin 偏移。
- 导航成功与后续打开失败独立记录。whenOpened 的结构化 outcome 保留 cancelled/timeout/error；30 秒 deadline 使用 TimeoutError，诊断终止不取消业务。
- Agent 初始化未单独拆分持久化/fsync。

## 授权边界

用户已批准真实 Desktop 本地采集及两次重启。desktop profile 临时仅选择两 owner，collector 为 127.0.0.1:24318，无上游转发。初版完整链路已有 3 条真实成功 trace；当前 V2 更新尚未重启加载，不将源码构建称作部署成功。未授权向实际 SigNoz 导出，不启动替代 GUI。

## 行为与隐私验收

- 旧 Host/关闭/能力获取失败：保持原创建及导航。
- 创建前取消：不创建；提交过程中取消：等待现有 create，不回滚、不导航。
- 成功导航后忽略 palette 正常关闭产生的 abort。
- 创建失败：不重试，不替换原错误。诊断 phase、wait、end 错误不得破坏业务导航。
- 绑定打开失败、30 秒超时、并发等待：独立结算，最多结束一次，等待有界。
- 导出仅稳定 owner/operation、kind/retry、outcome、计数/耗时；不含路径、正文、session/workspace ID、令牌、业务结果、异常消息及堆栈。
- DSH 工作区实际 loopback collector 已收到并解码 HTTP/protobuf trace 和 metrics 字节，成功/失败创建测试验证同 trace、父子关系、精确 owner/outcome 与隐私哨兵。
- 解码 fixture 使用已有 OTel transformer ProtobufReader，未新增依赖；fixed64 时间及 metric 数值未语义解码，不是完整 OTLP schema decoder。
- Host 创建装配是真实 controller，Agent 初始化/工作区挂接使用 fixture 替身，不代表实际持久化 I/O 验收。
- Wire 成功不等于 SigNoz 入库验收。

## 尚未验证

- 最新 V2 中间阶段是否在当前真实 GUI 加载；源码构建不代表已部署。
- 最新分段的真实浏览器耗时分布（初版已采样完整主链路）。
- 实际 SigNoz 入库（未授权启用）。

部署后需明确 collector HTTP/protobuf 地址、允许 owner/信号及保留期限，使用一个共享 Host runtime，确认当前 GUI 产物并在复现后查看 trace 树。隔离 fixture 耗时不能代表用户环境延迟。
