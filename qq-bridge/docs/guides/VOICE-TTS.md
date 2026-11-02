# 语音合成（TTS）与定制音色

桥接的 `qq_speak` 支持三种 TTS 引擎，配置在 `config.json` → `socialV2.voice.tts`。
换引擎不需要改代码，改配置（或控制台「语音库与语音发送 → 语音合成」）即可。

| 引擎 | 用途 | 是否需要部署 |
|---|---|---|
| `edge` | 微软 edge-tts 的 14 个中文预置音色 | 否（本机已装 edge-tts） |
| `http` | GPT-SoVITS / CosyVoice / Fish-Speech / 任意 OpenAI 兼容 TTS | 是（本地服务或云端 API） |
| `command` | 任意命令行 TTS | 是 |

「定制音色」= 用 `http` 引擎接一个支持 **zero-shot 声音克隆** 的后端，把参考音频换成目标声线。
edge-tts 做不到这件事：它的音色是固定声线，只能调音调/语速。

---

## 一、先试零成本的：edge 参数微调

如果只是想「听起来更接近某个角色」，先调参数，改完在控制台点「试听」：

```
voice = zh-CN-XiaoyiNeural     # 少女音底子
rate  = +8%                    # 语速略快
pitch = +20Hz                  # 音调抬高（更幼）
```

| 目标感觉 | voice | rate | pitch |
|---|---|---|---|
| 软萌少女（塔菲向） | `zh-CN-XiaoyiNeural` | `+8%` | `+20Hz` |
| 温柔大姐姐 | `zh-CN-XiaoxiaoNeural` | `-2%` | `-10Hz` |
| 元气活泼 | `zh-CN-XiaoyiNeural` | `+15%` | `+10Hz` |
| 东北味儿 | `zh-CN-liaoning-XiaobeiNeural` | `+5%` | `+0Hz` |

`pitch` 超过 ±40Hz 会明显失真（像变声器），建议 0~30Hz。

这只是「接近」，不是同一个人。要真正克隆，往下看。

---

## 二、接 GPT-SoVITS（真正的音色克隆）

GPT-SoVITS 能用 5~10 秒参考音频 zero-shot 克隆一个声线，中文效果在开源方案里第一梯队。

### 2.1 硬件现实（本机：RTX 3050 Laptop 4GB / 16GB 内存）

| 项目 | 要求 | 本机 |
|---|---|---|
| 推理显存 | 约 3~4 GB（fp16） | 4 GB，勉强 |
| 推理内存 | 约 4~6 GB | 16 GB，但同时可用仅 2~3 GB |
| 磁盘 | 仓库 + 模型约 6~8 GB | 充足 |
| 训练/微调 | ≥ 8 GB 显存 | **不行**，只能 zero-shot |

结论：**能跑，但慢**（3050 laptop 大约 1 秒音频要 1~3 秒合成），且需要先关掉浏览器等占内存的程序。
想要稳定体验，建议在 Colab / AutoDL（租 4090 约 1~2 元/小时）跑服务，桥接通过 `http.url` 指过去。

### 2.2 部署步骤（本地）

```bash
# 1) 取仓库（约 7 MB）
git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git D:/Tools/GPT-SoVITS

# 2) 建独立环境（Python 3.10 最稳）
conda create -n gpt-sovits python=3.10 -y
conda activate gpt-sovits

# 3) 装 torch（CUDA 12.1，约 2.5 GB）
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121

# 4) 装依赖
cd D:/Tools/GPT-SoVITS
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

预训练模型（约 2~4 GB，按官方 README 下载后放到 `GPT_SoVITS/pretrained_models/`）：

- `s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt`（GPT 模型）
- `s2G488k.pth`（SoVITS 生成器）
- `chinese-hubert-base`、`chinese-roberta-wwm-ext-large`

模型源：

- 官方 Hugging Face `lj1995/GPT-SoVITS`（本机直连不通）
- ModelScope `AI-ModelScope/GPT-SoVITS`（可用，但速度不稳）
- 社区整合包（B 站/AutoDL 镜像，通常已含模型，最省事）

### 2.3 启动 API 服务

```bash
cd D:/Tools/GPT-SoVITS
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

看到 `Uvicorn running on http://127.0.0.1:9880` 即可。

### 2.4 准备参考音频（决定像不像的关键）

| 要求 | 说明 |
|---|---|
| 时长 | 5~10 秒（3 秒也能用，但音色不稳） |
| 内容 | **一句话**，语气自然、有起伏 |
| 干净 | 无 BGM、无回声、无其他人声、无音效 |
| 格式 | wav 最佳，采样率 ≥ 16 kHz，单声道 |
| 对应文字 | `prompt_text` 必须与音频**逐字一致**（含语气词） |

从视频里截一段：

```bash
# 截 00:12:30 起 8 秒，转 16k 单声道 wav
tools/ffmpeg.exe -ss 00:12:30 -t 8 -i input.mp4 -vn -ac 1 -ar 16000 refs/taffy.wav
```

把文件放到 **GPT-SoVITS 服务端**能读到的路径（同机就是任意绝对路径），例如
`D:/Tools/GPT-SoVITS/refs/taffy.wav`。

### 2.5 接到桥接

控制台 → 二代仿真页 → 「语音库与语音发送（调试）」→ 语音合成：

- 引擎：`HTTP 服务`
- 服务地址：`http://127.0.0.1:9880/tts`
- 格式：`gpt-sovits`
- 参考音频：`D:/Tools/GPT-SoVITS/refs/taffy.wav`
- 参考文字：那段音频里说的原文
- 语言：`zh`

点「试听」→ 满意后「存为默认」。

等价的手改配置：

```json
{
  "socialV2": {
    "voice": {
      "tts": {
        "enabled": true,
        "engine": "http",
        "maxChars": 80,
        "http": {
          "url": "http://127.0.0.1:9880/tts",
          "format": "gpt-sovits",
          "refAudio": "D:/Tools/GPT-SoVITS/refs/taffy.wav",
          "promptText": "参考音频里说的那句话",
          "textLang": "zh",
          "promptLang": "zh",
          "mediaType": "mp3",
          "timeoutMs": 120000,
          "extraBody": { "speed_factor": 1.0 }
        }
      }
    }
  }
}
```

`extraBody` 会合并进请求体，可以传 `speed_factor`（0.5~2.0）、`text_split_method` 等。

> 本地模型首次合成要加载模型（10~30 秒），之后每句 1~3 秒；`timeoutMs` 建议给到 120000。

---

## 三、接其它后端

### 3.1 CosyVoice2 / Fish-Speech / IndexTTS

只要服务端接受 JSON、返回音频二进制或 `{audio: base64}`，用 `format: "raw"` + `extraBody` 描述请求体：

```json
{
  "engine": "http",
  "http": {
    "url": "http://127.0.0.1:50000/inference_zero_shot",
    "format": "raw",
    "extraBody": {
      "tts_text": "{text}",
      "prompt_text": "参考音频对应的文字",
      "prompt_wav": "D:/refs/taffy.wav"
    }
  }
}
```

`extraBody` 里的字符串支持 `{text}` `{voice}` `{rate}` `{pitch}` `{volume}` 占位符（递归替换，数组/对象里的也会替换）。

### 3.2 OpenAI 兼容接口（Fish Audio、Xinference、one-api 等）

```json
{
  "engine": "http",
  "http": {
    "url": "https://api.example.com/v1/audio/speech",
    "format": "openai",
    "apiKey": "sk-xxx",
    "model": "tts-1",
    "mediaType": "mp3",
    "extraBody": { "voice": "alloy" }
  }
}
```

> 注意：`voice` 会优先取请求体里的 `voice` 字段；想让 AI 不能改音色，把 `allowModelOverride` 设为 `false`。

### 3.3 命令行

```json
{
  "engine": "command",
  "command": {
    "bin": "D:/Tools/tts/venv/Scripts/python.exe",
    "args": ["D:/Tools/tts/infer.py", "--text", "{text}", "--ref", "D:/refs/taffy.wav", "--out", "{out}"]
  }
}
```

`{out}` 是桥接生成的输出文件路径（已保证在 `audio/tts/` 内）。如果参数里没出现 `{out}`，会自动作为最后一个参数追加。

---

## 四、行为与限制

| 项目 | 说明 |
|---|---|
| 字数上限 | `tts.maxChars`（默认 120），超了直接拒绝 |
| 缓存 | 同文本 + 同参数 + 同参考音频命中缓存，不重复请求 |
| 缓存清理 | `tts.maxFiles`（默认 300），按修改时间保留最新 |
| 发送额度 | 与文字/表情共用语音额度：每会话 2 条/分钟、10 条/小时 |
| 敏感信息 | 文本命中密钥/令牌特征会被拒绝合成 |
| 失败降级 | TTS 挂了只影响语音，不影响文字消息 |

---

## 五、排查

| 现象 | 原因 |
|---|---|
| `TTS 服务 HTTP 500` | 参考音频路径服务端读不到，或 `prompt_text` 与音频不匹配 |
| 合成出来音色不像 | 参考音频有 BGM/混响，或时长太短（< 3 秒），或 `prompt_text` 不逐字一致 |
| 首次合成超时 | 模型加载慢，把 `http.timeoutMs` 调到 120000+ |
| `GPT-SoVITS 需要 http.refAudio` | 没填参考音频路径 |
| 试听正常但 QQ 里没声 | 看 `verified` 字段；`false` 说明网关没回读到 record 段 |
| 音色忽高忽低 | `prompt_text` 与音频内容不一致，模型在"猜" |

日志关键词：`[tts] 合成`、`[voice] 已发送语音`。
