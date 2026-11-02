# qq-bot-wb

把 QQ 变成一个有长期人设的聊天机器人：**SnowLuma 负责接 QQ，qq-bridge 负责让它像一个真人说话，WorkBuddy CLI 负责思考。**

这套东西不是单一项目，而是三个项目的组合 + 一批本地改造。本仓库把它们放在一起，方便备份和整体迁移。

> 非官方项目。用 WorkBuddy 账号额度驱动第三方机器人可能违反其服务条款，存在账号风控风险；接的是你自己的 QQ 号，请自行评估。仅供个人学习使用。

---

## 架构

```
              QQ 客户端（登录机器人号）
                        │
                        ▼
   ┌────────────────────────────────────────┐
   │ SnowLuma 2.3.1          QQ 网关        │
   │  · 原生组件注入，接管 QQ 收发          │
   │  · OneBot v11：HTTP 3000 / WS 3001     │
   │  · WebUI 6099（登录/注入/日志）        │
   └────────────────┬───────────────────────┘
                    │ OneBot 事件
                    ▼
   ┌────────────────────────────────────────┐
   │ qq-bridge 0.2.1-r1      行为层          │
   │  · 唤醒判定：@ / 关键词 / 概率          │
   │  · 人设卡注入、拆条发送、打字节奏       │
   │  · 表情包 / 语音 / 黑话学习             │
   │  · 控制台 3100                          │
   └────────────────┬───────────────────────┘
                    │ headless CLI
                    ▼
   ┌────────────────────────────────────────┐
   │ WorkBuddy CLI（codebuddy -p）           │
   │  · stream-json 流式、dontAsk 权限       │
   │  · 每会话独立 workspace + 会话 id       │
   └────────────────┬───────────────────────┘
                    │ 可选
                    ▼
   GPT-SoVITS 9880（文本 → 塔菲音色语音）
```

## 目录

| 目录 | 是什么 | 运行时是否参与 |
| --- | --- | --- |
| `SnowLuma/` | QQ 网关。`packages/` 是源码（v2.3.0），`exe/` 是发布产物（v2.3.1） | ✅ 直接跑 `exe/` |
| `qq-bridge/` | OneBot 桥接，**所有本地改造都在这里** | ✅ |
| `qq-bridge-workbuddy/` | 上游的「WorkBuddy 后端」补丁包（原始形态） | ❌ 仅作参考 |

### 关于 `qq-bridge-workbuddy/`

它是个**安装器形态**的补丁包：`install.ps1` 把 `payload/` 里的文件覆盖进 qq-bridge 目录。

本机**没有按它的脚本安装**，原因是它适配 `qq-bridge v0.2.0-r4`，而实际用的是 `0.2.1-r1`，整份覆盖会降级并冲掉新版改动。实际做法是：

| 产物 | 状态 |
| --- | --- |
| `payload/src/wb-client.js` | ✅ 已原样并入 `qq-bridge/src/wb-client.js`（内容完全一致） |
| `payload/src/bridge.js` 的补丁 | ⚠️ 未使用该文件，改为在新版 `bridge.js` 上手工打 5 处补丁 |
| `payload/scripts/{wb-login,wb-selftest,stop-bridge}.mjs` | ✅ 已复制到 `qq-bridge/scripts/` |
| `payload/scripts/setup-apply.mjs`、`install.ps1` | ❌ 未使用 |
| `payload/docs/WORKBUDDY_BACKEND.md` | ✅ 已并入 `qq-bridge/docs/guides/` |

保留这个目录的价值：它是 WorkBuddy 后端改造的**原始出处**，也是干净的参考实现——想从零重做一遍时，照着它做比读打了补丁的代码容易。

## 端口

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 3000 | SnowLuma | OneBot HTTP |
| 3001 | SnowLuma | OneBot WebSocket（桥接连这个） |
| 6099 | SnowLuma | WebUI，浏览器登录用 |
| 3100 | qq-bridge | 控制台，请求头需 `x-console-token` |
| 9880 | GPT-SoVITS | 本地语音合成（可选） |

> 5099 是 Windows 保留端口段，会启动失败，本项目改用 6099。

## 快速开始

### 前置

- Windows 10/11
- Node.js：SnowLuma 要 **≥24.22**，qq-bridge 要 **≥22.13**（`SnowLuma/exe/node.exe` 自带 24，launcher 会优先用它）
- 一个已登录的 QQ 客户端（机器人号）
- WorkBuddy 账号（CLI 登录后才有额度）

### 启动顺序

**1. 网关**

```bat
SnowLuma\exe\launcher.bat
```

浏览器打开 `http://127.0.0.1:6099` 登录（密码见 `exe\config\WEBUI-PASSWORD.txt`），确认 OneBot 已连接、状态 `online`。

**注意**：`hookAutoLoad=false`，每次启动都要在 WebUI 里**手动注入原生组件**，否则收发不了消息。

**2. 语音（可选，只影响语音条）**

```bat
qq-bridge\start-tts.bat
```

等到出现 `Uvicorn running on http://127.0.0.1:9880`。首次启动会加载模型并做一次 cuDNN 预热（约 2 分钟），之后 1–3 秒/句。

**3. 桥接**

```bat
qq-bridge\start.bat
```

控制台 `http://127.0.0.1:3100`，token 在 `qq-bridge/state/console-token`。

**4. 填白名单**

`qq-bridge/config.json` 里的 `ownerQQ` 和 `allow` 为空时，所有消息都会被忽略（日志显示 `忽略未授权会话`）。填上你的 QQ 号和要放行的群。

## 配置

`qq-bridge/config.json` **不在仓库里**（含访问令牌与 QQ 号）。关键字段：

| 字段 | 当前值 | 作用 |
| --- | --- | --- |
| `backend` | `workbuddy` | 后端类型；`dsh` 为原版，未启用 |
| `workbuddy.model` | `deepseek-v4.1-flash` | 驱动对话的模型 |
| `workbuddy.reasoningEffort` | `low` | 思考强度，越低越快越便宜 |
| `workbuddy.permissionMode` | `dontAsk` | 不弹权限询问，否则会卡住 |
| `workbuddy.nodePath` | `C:\nvm4w\nodejs\node.exe` | **不能用 WorkBuddy 托管的 node 22**，版本不够 |
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | OneBot 地址 |
| `consolePort` | `3100` | 控制台端口 |
| `socialV2.wake` | 潜水模式、睡前观察 5 分钟 | 唤醒节奏 |
| `socialV2.voice.tts` | `engine: http` → 9880 | 语音引擎 |

人设放在 `qq-bridge/roles/*.md`，**热加载**，改完不用重启，下轮唤醒就生效。

## 语音

两条路，改 `socialV2.voice.tts.engine` 切换：

| 引擎 | 说明 |
| --- | --- |
| `edge` | 微软在线合成，14 个中文音色，零成本、无需部署 |
| `http` | 指向任意 TTS 服务，内置 `gpt-sovits` / `openai` / `raw` 三种请求格式 |

本机目前用 `http` + 本地 GPT-SoVITS 零样本克隆（RTX 3050 4 GB 显存，峰值 1.5 GB，不需要量化）。

零样本克隆的关键是**参考音频的逐字文本必须准确**，`prompt_text` 猜错会让模型提前结束，输出被截断一半以上。

详见 `qq-bridge/docs/guides/VOICE-TTS.md`。

## 仓库里没有的东西

| 缺失 | 原因 | 怎么补 |
| --- | --- | --- |
| `qq-bridge/config.json` | 含令牌 | 从控制台重新配置，或复制旧文件 |
| `SnowLuma/exe/config/` | 含 WebUI 密码、OneBot token | 首次启动自动生成 |
| `qq-bridge/.gsv/`（8.4 G） | GPT-SoVITS 环境 + 权重 | 见 `VOICE-TTS.md` 的部署步骤 |
| `qq-bridge/refs/`（340 M） | 第三方语音素材，无明确授权 | 自备参考音频 |
| `SnowLuma/exe/node.exe`（90 M） | 运行时二进制 | 装 Node ≥24，或从发布包取回 |
| `qq-bridge/tools/ffmpeg.exe`（84 M） | 二进制 | 装 ffmpeg 并改 `voice.ffmpegPath` |

## 常见问题

**`COMPONENT_LOAD_FAILED`**
SnowLuma 2.3.0 的原生组件 bug（上游 issue #619），升级到 2.3.1 解决。本仓库 `exe/` 已是 2.3.1。

**桥接起不来，提示 node 版本不够**
`launcher.bat` 里已改成优先用自带 `node.exe`。如果手动跑 `node index.mjs`，确保 Node ≥24.22。

**发了消息没反应**
先看是不是白名单为空，再看 WorkBuddy CLI 是否已登录（`qq-bridge/scripts/wb-selftest.mjs` 可自检）。

**语音发不出去**
99% 是 `start-tts.bat` 没起，或 9880 端口没监听。把 `tts.engine` 改回 `edge` 可以临时兜底。

**日志里 `session/not-found`**
会话只活在 CLI 进程里，重启后旧 id 失效。主会话和黑话会话都已加自愈逻辑，会自己重建。

## 许可

三个子项目各有自己的许可证，分别见各自目录下的 `LICENSE`。本仓库只做整合与本地改造，不对上游代码主张额外权利。
