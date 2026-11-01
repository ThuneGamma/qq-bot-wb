/**
 * TTS（文本转语音）桥接 —— 可插拔引擎。
 *
 * 三种引擎：
 * - `edge`    ：本机 Python + edge-tts（默认，免费、免部署，音色是微软预置的 14 个中文声线）；
 * - `http`    ：POST 到任意本地/云端 TTS 服务，内置 `gpt-sovits` / `openai` / `raw` 三种请求格式，
 *               用来接 GPT-SoVITS、CosyVoice、Fish-Speech、IndexTTS、Xinference、火山/MiniMax 等；
 * - `command` ：直接跑一条命令（`{text}`/`{out}` 占位符），万能兜底。
 *
 * 「定制音色」的关键在 `http` 引擎：GPT-SoVITS 用 `http.refAudio` + `http.promptText`
 * 指向一段 5~10 秒的参考音频，就能用那个声线念任意文本（zero-shot 克隆）。
 *
 * 设计约束：
 * - 合成失败绝不影响桥接主进程（子进程/HTTP 都有超时与错误兜底）；
 * - 同文本 + 同参数命中缓存；
 * - 输出目录受 voice 库约束（必须在 audio/ 之内），沿用既有发送白名单；
 * - 不信任模型给的任何路径：文件名完全由这里生成。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIN_CHARS = 2;
const MAX_CHARS_HARD = 500;
const ENGINES = new Set(['edge', 'http', 'command']);
const HTTP_FORMATS = new Set(['gpt-sovits', 'openai', 'raw']);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** 归一化 socialV2.voice.tts 配置（容错：缺项、类型错都不炸）。 */
export function normalizeTtsConfig(raw = {}) {
  const src = plainObject(raw);
  const engine = ENGINES.has(String(src.engine)) ? String(src.engine) : 'edge';
  const httpRaw = plainObject(src.http);
  const cmdRaw = plainObject(src.command);
  return {
    enabled: src.enabled === true,
    engine,
    // Windows 下默认 python 可能是 WorkBuddy 托管的 3.13（没装 edge-tts），
    // 所以配置里最好显式写绝对路径；环境变量可临时覆盖。
    pythonPath: String(process.env.QQ_BRIDGE_TTS_PYTHON || src.pythonPath || 'python'),
    script: String(src.script || 'tools/tts.py'),
    voice: String(src.voice || 'zh-CN-XiaoyiNeural'),
    rate: String(src.rate || '+0%'),
    pitch: String(src.pitch || '+0Hz'),
    volume: String(src.volume || '+0%'),
    maxChars: clampNumber(src.maxChars, MIN_CHARS, MAX_CHARS_HARD, 120),
    timeoutMs: clampNumber(src.timeoutMs, 5000, 120000, 30000),
    cache: src.cache !== false,
    dir: String(src.dir || 'tts'),
    maxFiles: clampNumber(src.maxFiles, 10, 5000, 300),
    allowModelOverride: src.allowModelOverride !== false,
    http: {
      url: String(httpRaw.url || ''),
      format: HTTP_FORMATS.has(String(httpRaw.format)) ? String(httpRaw.format) : 'gpt-sovits',
      apiKey: String(httpRaw.apiKey || ''),
      headers: plainObject(httpRaw.headers),
      extraBody: plainObject(httpRaw.extraBody),
      // GPT-SoVITS：参考音频 + 它对应的文字（prompt_text 必须和音频内容一致，否则音色会飘）。
      refAudio: String(httpRaw.refAudio || ''),
      promptText: String(httpRaw.promptText || ''),
      promptLang: String(httpRaw.promptLang || 'zh'),
      textLang: String(httpRaw.textLang || 'zh'),
      mediaType: String(httpRaw.mediaType || 'mp3'),
      timeoutMs: clampNumber(httpRaw.timeoutMs, 5000, 300000, 60000),
      // GPT-SoVITS 的参考音频在服务端本机，桥接不校验它存在（可能不在同一台机器）。
      model: String(httpRaw.model || 'tts-1')
    },
    command: {
      bin: String(cmdRaw.bin || ''),
      args: Array.isArray(cmdRaw.args) ? cmdRaw.args.map(String) : [],
      cwd: String(cmdRaw.cwd || '')
    }
  };
}

/** edge 引擎的语音参数校验（其它引擎允许任意音色标识）。 */
export function sanitizeVoiceParams(opts = {}, base = {}) {
  const voice = String(opts.voice || base.voice || '').trim();
  const rate = String(opts.rate || base.rate || '+0%').trim();
  const pitch = String(opts.pitch || base.pitch || '+0Hz').trim();
  const volume = String(opts.volume || base.volume || '+0%').trim();
  if (!/^[a-z]{2,3}-[A-Za-z]{2,4}(-[A-Za-z]+)?Neural$/.test(voice)) {
    throw new Error(`音色名不合法：${voice}（形如 zh-CN-XiaoyiNeural，可用 edge-tts --list-voices 查看）`);
  }
  for (const [name, value, re] of [
    ['rate', rate, /^[+-]\d{1,3}%$/],
    ['pitch', pitch, /^[+-]\d{1,3}Hz$/],
    ['volume', volume, /^[+-]\d{1,3}%$/]
  ]) {
    if (!re.test(value)) throw new Error(`${name} 格式不合法：${value}（应形如 +0% / +10Hz）`);
  }
  return { voice, rate, pitch, volume };
}

/** 非 edge 引擎：只做长度与字符白名单，允许 `taffy`、`zh-CN`、路径等任意标识。 */
function sanitizeLooseParams(opts = {}, base = {}) {
  const pick = (v, fallback, max) => String(v || fallback || '').trim().slice(0, max);
  return {
    voice: pick(opts.voice, base.voice, 120),
    rate: pick(opts.rate, base.rate, 20) || '+0%',
    pitch: pick(opts.pitch, base.pitch, 20) || '+0Hz',
    volume: pick(opts.volume, base.volume, 20) || '+0%'
  };
}

function ttsCacheKey({ engine, text, params, conf }) {
  const extra = conf.engine === 'http'
    ? [conf.http.url, conf.http.format, conf.http.refAudio, conf.http.promptText, JSON.stringify(conf.http.extraBody)]
    : conf.engine === 'command'
      ? [conf.command.bin, conf.command.args.join(' ')]
      : [];
  return createHash('sha1')
    .update([engine, params.voice, params.rate, params.pitch, params.volume, text, ...extra].join('|'))
    .digest('hex')
    .slice(0, 16);
}

function pruneDir(dir, maxFiles) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(mp3|wav|ogg|m4a|opus|flac)$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* 忽略 */ }
        return { p, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const extra of files.slice(maxFiles)) {
      try { fs.unlinkSync(extra.p); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在等，无需处理 */ }
}

/** 递归替换模板里的占位符（`{text}` / `{voice}` / `{rate}` / `{pitch}` / `{volume}`）。 */
function fillTemplate(node, vars) {
  if (typeof node === 'string') {
    return node.replace(/\{(text|voice|rate|pitch|volume)\}/g, (_, k) => String(vars[k] ?? ''));
  }
  if (Array.isArray(node)) return node.map((v) => fillTemplate(v, vars));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = fillTemplate(v, vars);
    return out;
  }
  return node;
}

async function runEdge({ text, conf, file, params, root }) {
  const script = path.isAbsolute(conf.script) ? conf.script : path.join(root, conf.script);
  if (!fs.existsSync(script)) throw new Error(`TTS 脚本不存在：${path.relative(root, script)}`);
  const payload = JSON.stringify({ text, output: file, ...params });
  const result = await new Promise((resolve) => {
    const child = spawn(conf.pythonPath, ['-X', 'utf8', script], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      finish({ ok: false, error: `TTS 超时（${conf.timeoutMs}ms）` });
    }, conf.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-4000); });
    child.on('error', (e) => finish({ ok: false, error: `无法启动 TTS 进程：${e.message}` }));
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      let parsed = null;
      try { parsed = line ? JSON.parse(line) : null; } catch { /* 解析失败走下面 */ }
      if (parsed && parsed.ok === true) return finish({ ok: true });
      const detail = parsed?.error || err.trim().split('\n').filter(Boolean).pop() || `退出码 ${code}`;
      finish({ ok: false, error: detail });
    });
    try { child.stdin.end(payload); } catch { /* 子进程可能已退出 */ }
  });
  if (!result.ok) throw new Error(result.error);
}

/** 把服务端返回的音频落盘（兼容裸二进制 / JSON base64 / JSON url 三种）。 */
async function saveHttpAudio(res, file) {
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    const j = await res.json().catch(() => null);
    const b64 = j?.audio || j?.base64 || j?.data || j?.audio_base64;
    if (typeof b64 === 'string' && b64.length > 0) {
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      return;
    }
    const url = j?.url || j?.audio_url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      const audioRes = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!audioRes.ok) throw new Error(`下载合成音频失败：HTTP ${audioRes.status}`);
      fs.writeFileSync(file, Buffer.from(await audioRes.arrayBuffer()));
      return;
    }
    throw new Error(`TTS 服务返回了 JSON 但没有音频字段：${JSON.stringify(j).slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('TTS 服务返回空音频');
  fs.writeFileSync(file, buf);
}

async function runHttp({ text, conf, file, params }) {
  const h = conf.http;
  if (!h.url) throw new Error('http 引擎缺少 http.url（TTS 服务地址）');
  let body;
  if (h.format === 'gpt-sovits') {
    if (!h.refAudio) throw new Error('GPT-SoVITS 需要 http.refAudio（参考音频路径，服务端可读的绝对路径）');
    body = {
      text,
      text_lang: h.textLang,
      ref_audio_path: h.refAudio,
      prompt_text: h.promptText,
      prompt_lang: h.promptLang,
      text_split_method: 'cut5',
      batch_size: 1,
      media_type: h.mediaType,
      streaming_mode: false,
      ...h.extraBody
    };
  } else if (h.format === 'openai') {
    body = {
      model: h.model,
      input: text,
      voice: params.voice,
      response_format: h.mediaType,
      ...h.extraBody
    };
  } else {
    body = Object.keys(h.extraBody).length ? fillTemplate(h.extraBody, { text, ...params }) : { text, voice: params.voice };
  }

  const headers = { 'content-type': 'application/json', ...h.headers };
  if (h.apiKey) headers.authorization = `Bearer ${h.apiKey}`;
  const res = await fetch(h.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(h.timeoutMs)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`TTS 服务 HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }
  await saveHttpAudio(res, file);
}

async function runCommand({ text, conf, file, params }) {
  const cmd = conf.command;
  if (!cmd.bin) throw new Error('command 引擎缺少 command.bin');
  const vars = { text, out: file, ...params };
  const args = cmd.args.map((a) => fillTemplate(a, vars));
  if (!args.some((a) => a.includes(file))) args.push(file);
  const stderr = await new Promise((resolve) => {
    const child = spawn(cmd.bin, args, {
      cwd: cmd.cwd || undefined,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-4000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }, conf.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve(`无法启动：${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? '' : (err.trim().split('\n').filter(Boolean).pop() || `退出码 ${code}`));
    });
  });
  if (stderr) throw new Error(`TTS 命令失败：${stderr}`);
}

/**
 * 合成一段语音，返回 { ok, file, bytes, ms, cached, engine, voice, chars }。
 * 失败抛错（带可读原因），调用方负责转成 HTTP 错误。
 */
export async function synthesizeSpeech({ text, root, cfg, outDir, overrides = {}, log = () => {} }) {
  const conf = normalizeTtsConfig(cfg);
  const raw = String(text ?? '').replace(/\r/g, '').trim();
  if (!raw) throw new Error('text 不能为空');
  if (raw.length < MIN_CHARS) throw new Error('text 太短，至少要 2 个字');
  const body = raw.length > conf.maxChars ? raw.slice(0, conf.maxChars) : raw;
  const allowOverride = conf.allowModelOverride;
  const params = conf.engine === 'edge'
    ? sanitizeVoiceParams(allowOverride ? overrides : {}, conf)
    : sanitizeLooseParams(allowOverride ? overrides : {}, conf);

  const dir = outDir || path.join(root, 'audio', conf.dir);
  fs.mkdirSync(dir, { recursive: true });

  const ext = conf.engine === 'edge' ? 'mp3' : (conf.http.mediaType || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
  const key = ttsCacheKey({ engine: conf.engine, text: body, params, conf });
  const file = path.join(dir, `tts-${key}.${ext}`);
  if (conf.cache && fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > 0) {
      return { ok: true, file, bytes: st.size, ms: 0, cached: true, engine: conf.engine, ...params, chars: body.length };
    }
  }

  const started = Date.now();
  if (conf.engine === 'edge') await runEdge({ text: body, conf, file, params, root });
  else if (conf.engine === 'http') await runHttp({ text: body, conf, file, params });
  else await runCommand({ text: body, conf, file, params });

  const st = fs.statSync(file);
  if (!st.size) throw new Error('合成结果为空文件');
  pruneDir(dir, conf.maxFiles);
  log(`[tts] ${conf.engine} 引擎合成 ${params.voice} ${body.length} 字 → ${path.basename(file)}（${st.size} 字节，${Date.now() - started}ms）`);
  return { ok: true, file, bytes: st.size, ms: Date.now() - started, cached: false, engine: conf.engine, ...params, chars: body.length };
}

/** 列出可用音色（仅 edge 引擎有意义）。失败返回空数组，不抛。 */
export async function listTtsVoices({ root, cfg }) {
  const conf = normalizeTtsConfig(cfg);
  if (conf.engine !== 'edge') return [];
  const script = path.isAbsolute(conf.script) ? conf.script : path.join(root, conf.script);
  return await new Promise((resolve) => {
    const child = spawn(conf.pythonPath, ['-X', 'utf8', script, '--list-voices'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } resolve([]); }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim());
        resolve(Array.isArray(parsed?.voices) ? parsed.voices : []);
      } catch { resolve([]); }
    });
  });
}
