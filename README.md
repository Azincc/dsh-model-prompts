# Gemini 与 Claude 提示词调优（@local/dsh-model-prompts）

给 Gemini 和 Claude 模型用一份**更短、不带 harness 身份**的系统提示词。

DSH 的系统提示词里有大量「用 X 工具做 Y」的祈使句。实测这会把 Gemini 4 带进
"文件系统模式"：让它画一张图，它调 `write` 写一个 200×200、7 个元素的占位 SVG
就收工——不是模型变笨，是提示词把"交付"换成了"写文件交差"。
同一模型、同一通道、同一句话，提示词 4434 字符时 7 元素，压到 3000 字符以内时
99~112 个元素。

这个插件在 `system-prompt/assemble` 瀑布里改装配结果，**只对匹配的模型生效**，
其他模型（DeepSeek、GPT、Grok……）完全不受影响。

## 安装

DSH 0.2.2 起可用。克隆到本地后，在 DSH 的 **插件** > **添加插件** 里选这个目录：

```bash
git clone https://github.com/Azincc/dsh-model-prompts.git
```

也可以让 DSH 里的 agent 用 `plugin_manager` 的 `install_bundle` 安装这个目录。
插件没有依赖，也没有构建脚本。

## 装好之后发生什么

对一个 `desktop` profile 实测（抓取 `go/deepseek-v4.1-flash` 真实装配出的提示词，
共 6273 字符，再按 Gemini 规则重放）：

| 段落 | 字符 | 处理 |
|---|---:|---|
| `ui:deliverable-file-references` | 1305 | 丢弃（展示规范，`present` 工具自述已覆盖） |
| `app:web-surface` | 1002 | 丢弃（部署信息，非能力护栏） |
| `tool:subagent` | 589 | 丢弃（工具自述已覆盖） |
| `tool:jobs` | 382 | 丢弃 |
| `tool:workflow` | 325 | 丢弃 |
| `harness:source` | 325 | 丢弃（同属部署信息） |
| `context:file-reference` | 407 → 140 | 压缩成一句「@ 是路径，读过才能说读过」 |
| `harness:identity` | 48 → 476 | 改写成 Antigravity 身份 + 执行纪律句 |
| `tool:goal` | 528 | 保留（目标管理语义，删了会退化；可用 `dropSections` 手动删） |
| `tool:pwsh` / `read` / `write` / `edit` / `glob` / `grep` | 259/160/92/83/71/129 | **保留**（编码护栏，删了就乱读乱写） |
| `tool:web_search` / `web_fetch` / `schedule` | 215/150/149 | 保留（安全与授权护栏） |

结果：**6273 → 2506 字符**，落在那份调优文档推荐的 2000~3000 区间。

同时：

- 把所有段落文本和运行时上下文里的 `DeepSeek Harness` 换成 `Coding Harness`。
  部分上游按连续词组字面匹配，出现这个词组会直接返回 429（伪装成配额耗尽）。
- `harness:identity` 换成对应家族的身份：
  - Gemini：Antigravity 身份（官方原文，去掉我们无法满足的 `<USER_REQUEST>` 契约）；
  - Claude：中性身份 + 同一句执行纪律。
- 只改**系统提示词与运行时上下文文本**；工具 schema、历史消息、工具执行都不动。

## 配置

行 id 是 `model-prompts`，包名 `@local/dsh-model-prompts`。配置文件是 profile 的
`cordis.patch.yml`（设置界面里改也行）。字段全部可选，缺省值见 `index.js`
的 `DEFAULT_CONFIG`；**行里的 config 会覆盖到默认值之上**（数组和 `scrub` 是整体替换，
对象映射按键合并），所以只写想改的字段即可。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `models` | `["gemini*","claude*"]` | 模型 id 通配（`*`、`?`，大小写无关）。 |
| `excludeModels` | `[]` | 命中这里的不处理（优先级高于 `models`）。 |
| `identities` | gemini / claude 两段 | 按 key 在模型 id 里出现来选家族。 |
| `identitySection` | `harness:identity` | 被改写的段落名。 |
| `replaceIdentity` | `true` | 关掉则只做裁剪和替换，保留原身份句。 |
| `knowledgeRule` | `""` | 追加到身份段后的知识截止规则（文档里那句压缩版）。 |
| `effortLine` | `""` | 追加到身份段后的思考档提示，如 `SPECIAL INSTRUCTION: think silently if needed. EFFORT LEVEL: 1.00.` |
| `dropSections` | 见上表 | 整段丢弃的段落名；`[]` 表示不丢。 |
| `keepSections` | `[]` | 即使出现在 `dropSections` 里也保留。 |
| `compressSections` | `context:file-reference` | 段落名 → 替换文本。 |
| `scrub` | `[["DeepSeek Harness","Coding Harness"]]` | 字面替换表。`[]` 关闭。 |
| `scrubContexts` | `true` | 是否同样处理运行时上下文文本。 |
| `dropContexts` | `[]` | 整段丢弃的运行时上下文名。 |
| `dryRun` | `false` | 只统计和落 dump，不改装配结果（排障用）。 |
| `dumpTo` | `""` | 非空时把每次命中的装配结果写成 JSON（绝对路径最稳）。 |
| `dumpText` | `false` | dump 里是否带完整提示词正文。 |

例子：给 Gemini 加思考档提示、并把 `tool:goal` 也砍掉：

```yaml
- id: model-prompts
  name: '@local/dsh-model-prompts'
  config:
    models: ['gemini*', 'claude*']
    effortLine: 'SPECIAL INSTRUCTION: think silently if needed. EFFORT LEVEL: 1.00.'
    dropSections:
      - ui:deliverable-file-references
      - app:web-surface
      - harness:source
      - tool:jobs
      - tool:workflow
      - tool:subagent
      - tool:subagent_fork
      - tool:goal
```

## 怎么确认它真的生效了

段落名猜错会**静默不生效**，所以别只看日志。两种确认方式：

1. 配 `dumpTo: 'D:/tmp/model-prompts.json'`，切到 Gemini 或 Claude 发一句话，
   打开这个文件：`before.chars` / `after.chars`、`droppedSections`、`after.sections`
   都是那一次真实请求的结果。
2. 终端里跑 `node verify.mjs`（或 `node verify.mjs <dump.json>` 用真实装配结果做回归）：
   它会跑一遍匹配、丢弃、压缩、改写、替换的断言，并打印字符数变化。
   没有 Node 的话，用 DSH 自带的运行时也行：
   `$env:ELECTRON_RUN_AS_NODE=1; & "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" verify.mjs`。

验证效果请用**真实 DSH 会话**：把提示词单独塞进 `instructions` 的脱壳测试会给出
相反的结论（同一份提示词，隔离脚本里调了 `glob`，真实会话里直接出代码）。

## 前置条件（插件管不到的部分）

那个调优文档里最容易漏的一条：**provider 配置里必须显式写 `reasoningEffort`**。

```yaml
- id: agent-default-model
  config:
    provider: my-gateway
    model: gemini-4-argon-high
    reasoningEffort: high   # 不写就 effort=None，2 秒出简笔画
```

这属于模型/provider 配置，不是提示词，插件改不了。Gemini 4 的 provider 还要注意
`streamIdleTimeoutMs`（上游思考阶段可能长时间不吐字节，默认 300s 空闲超时会被误杀）。

## 限制（重要）

- **不能过滤工具。** 这个版本的 `system-prompt/assemble` 只交付段落和上下文，
  工具 schema 由各自的 provider 决定，瀑布返回值动不了它。想减少工具数量，
  只能禁用对应工具插件（如 `tool-workflow`、`tool-subagent`），或接受工具存在。
  提示词变短本身已经能解决绝大部分"占位文件"问题。
- **`complete` 段落会盖掉改写结果。** 某个 preset 用 `complete: true` 独占系统
  提示词时，DSH 在瀑布之后会把该段恢复成唯一段落，本插件的裁剪就不生效。
  本机 `desktop` profile 的默认 preset 不是完整段落，正常生效。
- **不改用户消息**（时间戳、运行时上下文快照的包装、`@` 引用解析）。如果 429 在
  系统提示词已经很干净时仍然出现，问题在这些上游注入的消息里，插件管不到。
- **Claude 只做同样的裁剪与中性身份**，没有 Gemini 那种"官方 Antigravity 身份"
  可对齐；Claude 侧的效果取决于上游是否也在做特征匹配。

## 回滚

在插件页把本 bundle 停用即可（`model-prompts` 一行），或删掉 profile 里的
`- id: model-prompts` 行；提示词立刻回到 DSH 原版。插件不写任何文件，
`dumpTo` 之外没有副作用。
