// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken, probeDshProtocol, detectLocalDshVersion, classifyDshFailure } from './dsh-client.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { createApiAdapter } from './api-adapt.js';
import { createVideoStoryboard } from './video-storyboard.js';
import { createTts, concatWav } from './tts.js';
import { toSpeakable, hasSpeakableContent } from './tts-text.js';
import { decide, recordSpoken, createVoiceMemory, emotionScore } from './voice-policy.js';
import { resolveTone, sanitizeTone, DEFAULT_TONE } from './voice-tone.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  normalizeStickerEntry,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
// 语音引擎要到 main() 中段才建（要读 config、起 worker 线程），但控制台的调音台接口
// 在 HTTP 处理器里就要用 → 用这个晚绑定引用，没就绪时接口老实返回 503，不炸。
let voiceEngine = null;
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
// 自我画像：AI 自己写的"我观察到的自己"。只增不删，注入时排在角色卡之后。
// 与角色卡的分工：角色卡是"我出厂是什么样"（管理员定），这里是"我发现自己是什么样"（AI 自己写）。
const SELF_PROFILE_FILE = path.join(STATE_DIR, 'self-profile.md');

// ── 角色维度的状态文件（每个角色一套独立的会话 + 记忆）─────────────────────
// 设计：切角色 = 换脑子。会话映射和社交状态各存一份 <base>.<角色>.json，
// 切过去之后新角色从零开始，不记得另一个人格跟谁聊过什么。
// 无角色时退回旧路径（sessions.json / social-v2.json），保证老数据还能用。
let activeRole = '';       // 当前生效角色（缓存，避免每次 saveState 都读盘）
let roleSwitchHook = null; // main() 里注册：保存旧状态 → 清定时器 → 加载新状态
function roleStateFile(role) {
  const name = sanitizeRoleName(role || '');
  return name ? path.join(STATE_DIR, `sessions.${name}.json`) : STATE_FILE;
}
function roleSocialFile(role) {
  const name = sanitizeRoleName(role || '');
  return name ? path.join(STATE_DIR, `social-v2.${name}.json`) : SOCIAL_V2_FILE;
}
// 自我画像也按角色分：每个角色写自己的"我观察到什么"，互不串味。
// 无角色时退回 self-profile.md（兼容旧数据）。
function roleSelfProfileFile(role) {
  const name = sanitizeRoleName(role || '');
  return name ? path.join(STATE_DIR, `self-profile.${name}.md`) : SELF_PROFILE_FILE;
}
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 把用户配置的字符串（如 QQ 指令前缀）安全地拼进正则。
// 前缀是配置项，可能带 / # . 之类，直接拼会变成元字符（2026-10-30）。
function escapeRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
function appendActivity(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(ACTIVITY_LOG, `[${ts}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
    // 只保留最近 500 行
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 500) fs.writeFileSync(ACTIVITY_LOG, lines.slice(-500).join('\n'));
  } catch {}
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 发图片：路径安全解析（2026-10-03 新建）──────────────────────────────────
// 只允许发送 assets/ 目录（含子目录）里的图片文件：
//   * 必须是真实存在的**普通文件**（realpath 校验，符号链接跳出目录一律拒绝）；
//   * 扩展名白名单：png/jpg/jpeg/gif/webp/bmp（避免把 .yaml/.txt 等当图片发出去）；
//   * 大小上限（默认 8MB），空文件拒绝。
// 这是"机器人能发图片"的安全边界：它拿到的只是一个受限的目录，不是任意路径读取。
const IMAGE_EXT_WHITELIST = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
function resolveImageFileUnderRoot(rootDir, relPath, opts = {}) {
  const exts = opts.exts ?? IMAGE_EXT_WHITELIST;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 8 * 1024 * 1024;
  const raw = String(relPath ?? '').trim();
  if (!raw) throw new Error('图片路径不能为空');
  if (raw.includes('\0')) throw new Error('图片路径不合法');
  let absRoot;
  try {
    absRoot = fs.realpathSync(path.resolve(rootDir));
  } catch {
    throw new Error(`图片根目录不存在：${rootDir}`);
  }
  const abs = path.resolve(absRoot, raw);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new Error(`只允许发送 assets 目录里的图片（收到：${raw}）`);
  }
  const ext = path.extname(abs).toLowerCase();
  if (!exts.has(ext)) {
    throw new Error(`只允许发送图片文件（png/jpg/jpeg/gif/webp/bmp），收到：${ext || '(无扩展名)'}`);
  }
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Error(`找不到图片文件：${raw}`);
  }
  if (real !== absRoot && !real.startsWith(absRoot + path.sep)) {
    throw new Error('图片路径解析后跳出了 assets 目录，已拒绝');
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`不是普通文件：${raw}`);
  if (stat.size <= 0) throw new Error(`图片是空文件：${raw}`);
  if (stat.size > maxBytes) {
    throw new Error(`图片太大（${Math.round(stat.size / 1024)} KB，上限 ${Math.round(maxBytes / 1024)} KB）`);
  }
  return { absPath: real, relPath: path.relative(absRoot, real) || path.basename(real), size: stat.size, ext };
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    // 语音回复：默认关。开了以后，短句/情绪浓的回复偶尔会补一条语音（策略见 voice-policy.js）。
    voice: (() => {
      const v = file.voice ?? {};
      return {
        enabled: false,
        replaceText: true,          // true = 发语音的那条就不再发同样的文字（去重）
        engine: 'local',            // local = 本地 sherpa-onnx；http = 外部 TTS 服务
        scope: 'private',           // off / owner / private / all
        maxChars: 60,               // 超过这个字数只发文字
        minChars: 2,
        probability: 0.35,          // 基础概率，情绪分越高越容易发
        emotionBoost: 0.35,
        cooldownMs: 120000,         // 同一会话两条语音至少隔这么久
        hourlyCapPerConv: 4,
        dailyCap: 40,
        quietHours: null,           // 例如 [23, 8]：这段时间不发语音
        timeoutMs: 25000,
        ...v,
        local: {
          modelDir: 'models/vits-piper-zh_CN-xiao_ya-medium-int8',
          modelFile: '',
          sid: 0,
          speed: 1,
          numThreads: 2,
          provider: 'cpu',
          ...(v.local ?? {})
        },
        http: {
          url: '',
          method: 'POST',
          queryTemplate: 'text={text}',
          headers: {},
          extraBody: {},
          ...(v.http ?? {})
        }
      };
    })(),
    // 视频分镜：收到 QQ 视频时跑 dsh-video-storyboard，产出宫格图 + 时间码清单。
    // ⚠ 2026-10-30 补：这一段以前**根本没进 loadConfig**，config.json 里的 video 段
    //   一直被忽略（transcript=auto 等于没设），createVideoStoryboard 只能吃它自己的默认值。
    video: {
      enabled: true,
      cells: 9,                        // 0 = 让插件按画面密度自己决定
      maxBytes: 40 * 1024 * 1024,
      timeoutMs: 150000,
      transcript: 'off',               // off | auto（auto 需要本机 ASR 就绪）
      keepDays: 2,
      maxTextChars: 4000,
      ...(file.video ?? {})
    },
    // QQ 指令：owner 私聊发「指令 …」→ 独立 standard 会话在本机干活。
    // 同样是 2026-10-30 补进来的：以前 cfg.pcJobs 恒为 undefined，
    // 前缀/总开关/工作目录全走硬编码默认值。
    pcJobs: {
      enabled: true,
      prefix: '指令',
      ownerPrivateOnly: true,
      preset: 'standard',
      cwd: '',
      workspaceTitle: '',
      ...(file.pcJobs ?? {})
    },
    // 允许 iframe 嵌入控制台的来源（启动器面板 3120）。空 = 用代码里的默认值。
    consoleEmbedOrigins: Array.isArray(file.consoleEmbedOrigins)
      ? file.consoleEmbedOrigins.map(String)
      : undefined,
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        // 2026-10-25 新增：上下文压缩（滚动换届）
        // 桥接读不到 DSH 侧的上下文长度，所以自己按「累计字符数」估算：
        // 超过阈值 → 让 AI 把关键信息写进记忆本 → 换一个干净的 DSH 会话 → 注入前情提要。
        compactEnabled: true,
        compactThresholdChars: 80000,   // 累计字符阈值（中文约 4~5 万 token）
        compactMinTurns: 20,            // 至少这么多条消息才允许压缩，避免新会话就压
        compactKeepRecent: 6,           // 前情提要里保留最近几条原话
        compactCooldownMs: 1800000,     // 两次压缩最小间隔（30 分钟）
        compactMaxPerDay: 8             // 单会话每天最多压缩次数，防抖动
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // 新版 DSH 的 launch token 每次启动会变；配置里没填时自动从 DSH 启动日志发现（按 baseUrl 端口过滤）。
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken(cfg.dsh.baseUrl);

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
function loadState() {
  const loaded = readJsonSafe(STATE_FILE, null);
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
// 单实例锁只记 PID 是不够的：Windows 会把死进程的 PID 号**复用**给新进程
// （2026-10-01 实测事故：锁里的 10792 被复用给 D:\QQNT\QQ.exe，桥接每次启动都判「已有实例在运行」→ exit 2
//  → start.bat 遇 exit 2 会 pause 停住 → 桥接永远起不来 = 机器人「进不去」）。
// 所以按「PID 存在」之外，再确认这个 PID **真的是一个在跑的桥接**，两条独立证据：
//   ① 映像名必须是 node(.exe)（PID 被 QQ.exe 之类的程序复用 → 直接判过期锁）；
//   ② 它必须占着控制台端口（真正的桥接一定会监听它；别的 node 进程不会）——
//      仅当锁文件已存在 >15 秒时才用这条，避开「刚拿到锁还没来得及绑定端口」的启动竞态。
// 查不出来（缺 tasklist/netstat、被沙箱拦住等）一律**保守当作活着**：宁可让人工清锁，也不冒双实例风险。
const LOCK_IDENTITY_MIN_AGE_MS = 15_000;
function lockPidImage(pid) {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    if (r.error || r.status !== 0) return { ok: false, image: '' };
    const m = String(r.stdout || '').trim().match(/^"([^"]*)"/);
    return { ok: true, image: m ? m[1] : '' };   // image 为空串 = 系统里已经没有这个 PID
  } catch {
    return { ok: false, image: '' };
  }
}
function lockPidHoldsPort(port, pid) {
  try {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.error || r.status !== 0) return null;
    const localRe = new RegExp(`[:.]${port}$`);
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      if (!line.includes(`:${port}`)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      if (!localRe.test(cols[1])) continue;                 // 只认「本地地址」正好是这个端口
      if (cols[cols.length - 1] === String(pid)) return true; // 且末列 PID 就是这个进程
    }
    return false;
  } catch {
    return null;
  }
}
function acquireLock(consolePort = 3100) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  let staleReason = '';
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // PID 活着 ≠ 还是那个桥接：PID 会被系统复用，所以再复核一次身份（见 LOCK_FILE 上方的说明）。
          const who = lockPidImage(pid);
          if (!who.ok) {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）；未能确认该 PID 的映像名，保守不接管。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          } else if (!who.image) {
            stale = true;                                       // tasklist 里已经没有这个 PID
          } else if (!/^node(\.exe)?$/i.test(who.image)) {
            staleReason = `锁文件里的 PID ${pid} 已被系统复用给 ${who.image}（不是 node.exe），判为过期锁`;
            stale = true;
          } else {
            let age = Number.POSITIVE_INFINITY;
            try { age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs; } catch {}
            const holdsPort = age > LOCK_IDENTITY_MIN_AGE_MS ? lockPidHoldsPort(consolePort, pid) : null;
            if (holdsPort === false) {
              staleReason = `锁文件里的 PID ${pid} 是 node 进程，但它没有占着控制台端口 ${consolePort}（锁已存在约 ${Math.round(age / 1000)} 秒），判为过期锁`;
              stale = true;
            } else {
              console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
              process.exit(2);
            }
          }
        } catch (error) {
          if (error.code === 'ESRCH') stale = true;
          else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] ${staleReason || '检测到过期锁文件（PID 不存在或为空）'}，删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）
function log(...args) {
  const line = `${new Date().toISOString().slice(11, 19)} [bridge] ${args.map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.replace(/[\r\n]+/g, ' ');
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(BRIDGE_LOG, line + '\n');
    const raw = fs.readFileSync(BRIDGE_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 2000) fs.writeFileSync(BRIDGE_LOG, lines.slice(-2000).join('\n'));
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': {
        // 视频被报成 image 段时（见 extractMediaFromSegments 的注释），文本也要标成 [视频]，
        // 否则模型以为收到的是图片，压根不会去调分镜。
        const f = String(d.file ?? '');
        const u = String(d.url ?? '');
        const isVid = /\.(mp4|mov|avi|mkv|webm|flv|m4v|3gp)(\?|#|$)/i.test(f) || /orgfmt=t264|videotype=/i.test(u);
        out.push(isVid ? '[视频]' : '[图片]');
        break;
      }
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image' || seg.type === 'video') {
      const file = String(d.file ?? '');
      const url = String(d.url ?? '');
      // 不能只看 seg.type：有些 OneBot 实现（含 SnowLuma 的部分版本）把视频报成 image 段，
      // file 是 .mp4、url 带 orgfmt=t264。以前只认 type==='video'，于是这类消息被当成图片，
      // 视频分镜永远不触发，模型只能看到一张首帧图（2026-10-31 实测：kind=image + file=xxx.mp4）。
      const looksVideo = seg.type === 'video'
        || /\.(mp4|mov|avi|mkv|webm|flv|m4v|3gp)(\?|#|$)/i.test(file)
        || /orgfmt=t264|videotype=|\.mp4(\?|#|$)/i.test(url);
      if (looksVideo) {
        // 诊断用：确认到底从哪条路径识别成视频（排查"看不了视频"时直接看这行）
        log(`[media] 识别为视频：segType=${seg.type} file=${file} url=${url.slice(0, 60)}`);
        // 视频只记定位信息，字节等到真要"看"的时候才下（见 resolveMediaList）。
        media.push({
          kind: 'video',
          file,
          url,
          duration: Number(d.duration ?? 0) || 0,
          size: Number(d.file_size ?? d.fileSize ?? 0) || 0
        });
      } else {
        media.push({
          kind: 'image',
          file,
          url,
          subType: d.subType != null ? String(d.subType) : '',
          summary: String(d.summary ?? '')
        });
      }
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  acquireLock(cfg.consolePort ?? 3100);
  // 先把当前角色读进来，后面 loadState / loadSocialV2State 才知道该读哪份文件。
  activeRole = sanitizeRoleName(readRoleState().role ?? '');
  // 首次按角色分文件：把老的无后缀状态复制一份给当前角色。
  // 用复制而不是移动，原文件留着当备份，万一新逻辑有问题还能退回去。
  (function migrateRoleScopedState() {
    const name = activeRole;
    if (!name) return;
    for (const [src, dst] of [
      [STATE_FILE, roleStateFile(name)],
      [SOCIAL_V2_FILE, roleSocialFile(name)],
      [SELF_PROFILE_FILE, roleSelfProfileFile(name)]
    ]) {
      try {
        if (!fs.existsSync(dst) && fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          console.error(`[role] 已把 ${path.basename(src)} 复制给角色「${name}」`);
        }
      } catch (error) {
        console.error(`[role] 迁移 ${path.basename(src)} 失败：${error?.message ?? error}`);
      }
    }
  })();
  loadState();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = loadSlang(SLANG_FILE);
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  let stickerEntries = loadStickerStore(STICKER_FILE);
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // ── QQ 自带表情（系统/魔法表情）────────────────────────────────────────────
  // 这类表情（face:358 骰子、face:359 包剪锤…）**不是** QQ 收藏表情：没有图片和 url，
  // 走 `add_custom_face` 收藏必然失败（历史上就是那句"无法获取该表情的图片源"）。
  // 它们唯一的用法是 OneBot 的 face 段直发，所以本地库把它们记成 kind='face' 的条目。
  async function faceDisplayName(faceId) {
    try {
      const face = await bot.fetchFaceEntity(Number(faceId));
      const name = String(face?.q_des || (Array.isArray(face?.emoji_name_alias) ? face.emoji_name_alias[0] : '') || '')
        .replace(/^\//, '').trim();
      if (name) return name;
    } catch (error) {
      log(`[sticker] 查 QQ 自带表情名失败 face:${faceId}: ${error?.message ?? error}`);
    }
    return '';
  }

  /** 幂等地把 QQ 自带表情记进本地库（同 faceId 只更新备注/名字）。 */
  function upsertFaceSticker({ faceId, desc, tags, source = 'manual' } = {}) {
    const digits = String(faceId ?? '').replace(/[^\d]/g, '');
    if (!digits) return null;
    const id = `face:${digits}`;
    const idx = stickerEntries.findIndex((e) => e && e.kind === 'face' && String(e.faceId) === digits);
    const old = idx >= 0 ? stickerEntries[idx] : null;
    const next = normalizeStickerEntry({
      ...(old || {}),
      kind: 'face',
      faceId: digits,
      id,
      resId: id,
      desc: String(desc || old?.desc || '').trim(),
      tags: Array.isArray(tags) && tags.length ? tags : (old?.tags?.length ? old.tags : ['QQ自带', '表情']),
      source: old?.source || source,
      createdAt: old?.createdAt,
      updatedAt: new Date().toISOString()
    });
    if (!next) return null;
    if (idx >= 0) stickerEntries[idx] = next; else stickerEntries.push(next);
    saveStickerStoreSafe();
    return next;
  }

  // ⚠️ 2026-10-01 实测回退：**不预置、也不允许发** QQ 的"随机结果"表情（骰子 358 / 包剪锤 359）。
  // 网关（SnowLuma 1.14.19）把它们发成 commonElem{serviceType:37, pbElem:QFaceExtra(packId, stickerId, qsid,
  // sourceType=1, stickerType, randomType=1)} —— 但**不带 resultId**（协议里 QFaceExtra.resultId 是字符串字段，
  // 官方客户端的骰子元素里带着结果），于是接收端 QQ 永远停在"正在掷骰子"。
  // 机制保留：非随机的系统表情仍可发；等网关补上 resultId 再把这两个放回来。
  const FACE_SEND_BLOCKED = new Map([
    ['358', '骰子（随机结果表情：网关发出去的元素不带结果字段，对方会一直显示"正在掷骰子"）'],
    ['359', '包剪锤（同上）']
  ]);
  {
    const before = stickerEntries.length;
    stickerEntries = stickerEntries.filter((e) => !(e && e.kind === 'face' && FACE_SEND_BLOCKED.has(String(e.faceId))));
    if (stickerEntries.length !== before) {
      saveStickerStoreSafe();
      log(`[sticker] 已移除 ${before - stickerEntries.length} 个不可用的随机结果表情（骰子/包剪锤）`);
    }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return checkFaceNoImage(entry2);
    }
    return checkFaceNoImage(entry);
  }

  // QQ 自带表情（face:358 骰子…）没有图片也没有 url：看图这条路走不通，但发是能发的。
  // 这里给一句人话，而不是让它去下载一个空 URL 然后报"图片地址不合法"。
  function checkFaceNoImage(entry) {
    if (entry?.kind === 'face') {
      throw new Error(`「${entry.desc || entry.id}」是 QQ 自带表情（id=${entry.id}），没有图片可看；想发它就直接 qq_send_sticker stickerId="${entry.id}"`);
    }
    return entry;
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    // QQ 自带表情（系统/魔法表情，如 face:358 骰子）：走 OneBot 的 face 段，没有图片可下载。
    const isFace = entry.kind === 'face' && /^\d+$/.test(String(entry.faceId || ''));
    if (isFace && FACE_SEND_BLOCKED.has(String(entry.faceId))) {
      throw new Error(`暂时不能发「${entry.desc || entry.id}」：${FACE_SEND_BLOCKED.get(String(entry.faceId))}。想玩骰子就直接发文字（例如"🎲 5"，数字你自己随机一个）`);
    }
    const url = entry.url;
    if (!isFace && !url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    if (isFace) {
      // QQ 自带表情：OneBot 直接收 face 段（QQ 客户端会自己渲染成动画/随机结果），不需要图片字节。
      segments.push({ type: 'face', data: { id: String(entry.faceId) } });
    } else {
      // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
      let image;
      try {
        image = await safeFetchBuffer(url);
      } catch (error) {
        throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
      }
      segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    }
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 发送一张真实图片（image 段）。只接受已通过 resolveImageFileUnderRoot 校验的文件。
  // 与表情发送共用 sendChain：保证"先文字后图"的真人顺序不被并发工具调用打乱。
  async function sendImageV2(key, resolved, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const buf = fs.readFileSync(resolved.absPath);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发图前也会有一小段停顿（选图/截图），别让文字和图贴得太紧。
        await sleep(randInt(600, 1600));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    return { file: resolved.relPath, size: resolved.size, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    // QQ 自带表情（骰子/包剪锤这类）：没有图片源，**不能**去调 add_custom_face
    // （那正是以前那句"无法获取该表情的图片源"的来源）。改为直接记进本地表情库，
    // id = face:<数字>，之后 qq_send_sticker 就能把它发出去。
    if (media?.kind === 'face') {
      const faceId = String(media.faceId ?? '').replace(/[^\d]/g, '');
      if (!faceId) throw new Error('这条消息里的表情没有可用的 faceId，收藏不了');
      assertSendAllowed();
      const maxLen = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
      const cleanRemark = String(remark ?? '').trim().slice(0, maxLen);
      const name = cleanRemark || await faceDisplayName(faceId);
      const entry = upsertFaceSticker({ faceId, desc: name || `QQ表情${faceId}`, source: 'ai' });
      return { emojiId: `face:${faceId}`, entry, remark: name || '', face: true };
    }
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      // 理论上到不了这里（face 分支已在上面提前返回）；留一句话说明，避免以后误改成"再试一次图片"。
      throw new Error('QQ 自带表情不能收藏成自定义表情（没有图片源）；请走 face 分支');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    try { saveSlang(SLANG_FILE, slangEntries); } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        // 只有明确确认（confirmed: true）的结果才写入解释字段；
        // 不确定/未确认的结果保留原状，允许后续再次研究。
        if (r.confirmed !== true) {
          log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: text.slice(0, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI/控制台的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      evidence: Array.isArray(e?.evidence) ? e.evidence.slice(-5) : [],
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix
  });
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // 2026-10-25 修复「同一批消息被反复回答」：记录本回合开始时的未读最大 seq。
  // 回合内只要通过工具成功发过消息，就把 unread 中 seq <= 快照值的条目消费掉（等价于隐式 mark_read）。
  // 以前只有 AI 主动 qq_mark_read 才清 unread，而补发判定是 `unread 里存在 seq >= 触发点`，
  // 未读没清 → 判定永远成立 → 积压唤醒被一条条补发 → 每个补发回合 AI 又把同一批消息答一遍。
  const v2TurnUnreadMaxSeq = new Map(); // sessionId -> 本回合开始时的未读最大 seq
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> { deadline }：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 用 Map 而不是 Set，是为了记住"这把锁最晚什么时候必须放掉"：handler 有可能走不到释放那一步
  // （客户端自己超时放弃、HTTP 连接却没关，req 'close' 不触发；或者中途抛异常），
  // 那样这个会话就永远无法再等待，AI 也永远完不成沉睡前观察。进程重启时会自然清空（锁只在内存里）。
  const activeWaits = new Map();
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const pendingWakeArmedAt = new Map(); // key -> 该"待收尾唤醒"是什么时候挂上的（孤儿检测用）
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 强制解除 busy 标记，避免该会话永久无法被唤醒。
  // 从 30 分钟收紧到 6 分钟：正常的长回合由"投递队列 running"与"回合标记"继续兜着，
  // 所以这里到期只解除"待收尾唤醒"这一个理由，不会造成并发投递；但能让故障恢复快得多。
  const PENDING_WAKE_LEASE_MS = 6 * 60_000;
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
      pendingWakeArmedAt.delete(key);
    }, PENDING_WAKE_LEASE_MS);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
    pendingWakeArmedAt.set(key, Date.now());
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
    pendingWakeArmedAt.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // ── 回合租约：防"永久变聋"（2026-09-26 17:0x 真实事故）──────────────────────
  // 只要有一轮 DSH turn 在 turn/end 之前消失（429 余额不足、网络抖动、DSH 重启、
  // deliverPromptNow 永不 settle），`v2TurnStartAt` / `collectors` / `promptQueues.running`
  // 里就会永远挂着标记 → isConversationBusyV2 永远为真 → 该会话此后**每条新消息
  // 都只入库、不唤醒**，表现就是机器人彻底不回话。
  // 这里给每个 key 记一条"最晚必须收尾"的死线，超时即判定为幽灵状态并就地清理。
  // 死线取 12 分钟：正常回合最长是 qq_wait_for_messages 的 10 分钟（wait.maxMs=600000）
  // 加上 quiet 窗口与收尾，12 分钟足够宽裕，不会误杀正常的长轮询。
  const turnLeaseDeadline = new Map(); // key -> 最晚必须收尾的时间戳
  const turnLeaseMs = () => {
    const n = Number(cfg.socialV2?.wake?.turnLeaseMs);
    return Number.isFinite(n) && n > 0 ? n : 12 * 60_000;
  };
  function armTurnLease(key) {
    if (key) turnLeaseDeadline.set(key, Date.now() + turnLeaseMs());
  }
  function disarmTurnLease(key) {
    if (key) turnLeaseDeadline.delete(key);
  }

  /**
   * 就地解除某个 key 的全部忙标记；返回被清理项的名称列表。
   * 只动"忙"相关的内存态，不碰会话映射、不碰聊天记录，因此可安全自愈。
   */
  function releaseConversationBusy(key, why) {
    const cleared = [];
    let st = null;
    try { st = getSocialV2State(key); } catch { st = null; }
    if (st?.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
      cleared.push('待发唤醒定时器');
    }
    if (pendingWakeKeys.has(key)) { pendingWakeKeys.delete(key); cleared.push('待收尾唤醒'); }
    if (pendingWakeArmedAt.has(key)) pendingWakeArmedAt.delete(key);
    if (pendingWakeLeaseTimers.has(key)) {
      const t = pendingWakeLeaseTimers.get(key);
      if (t) clearTimeout(t);
      pendingWakeLeaseTimers.delete(key);
      cleared.push('唤醒租约');
    }
    const q = promptQueues.get(key);
    if (q?.running) { q.running = false; cleared.push('投递队列 running'); }
    const sid = state.sessions[key];
    if (sid) {
      if (v2TurnStartAt.has(sid)) { v2TurnStartAt.delete(sid); cleared.push('回合开始标记'); }
      if (collectors.has(sid)) { collectors.delete(sid); cleared.push('回合收集器'); }
      sendToolSucceededSessions.delete(sid);
      pendingSendToolCalls.delete(sid);
    }
    turnLeaseDeadline.delete(key);
    if (cleared.length) {
      log(`[reserved2] ⚠️ 检测到卡死的回合状态，已就地解除 ${key}（${why}）：${cleared.join('、')}`);
    }
    // 队列里还有排队的 prompt：解除后立刻继续投递，别让它们跟着一起饿死。
    if (q && q.queue.length && !q.running) {
      setTimeout(() => { void processPromptQueue(key).catch(() => {}); }, 0);
    }
    // 2026-09-30 修复：解除忙状态**不等于**会补唤醒。
    // 旧写法只重投 promptQueues，完全不管 pendingWakeReasons，于是会出现
    // “不忙、也没待唤醒”的干等状态：消息都躺在 unread 里，却没有任何东西去叫醒它
    // （2026-09-30 21:22 实测：unstick 解除了忙状态，但那两条暂存唤醒没人消费，机器人继续沉默）。
    // 这里把暂存的唤醒原因取一条出来补一次计划唤醒；剩下的会在后续回合结束时继续消费。
    if (st && Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length) {
      const item = st.pendingWakeReasons.shift();
      log(`[reserved2] 忙状态已解除，补投暂存的唤醒 ${key}（${item?.reason ?? 'private'}@seq${item?.seq ?? '?'}）`);
      setTimeout(() => {
        try {
          scheduleWakeV2(key, item?.reason ?? 'private');
        } catch (error) {
          log(`[reserved2] 补投唤醒失败 ${key}:`, error?.message ?? error);
        }
      }, 0);
    }
    return cleared;
  }

  // 兜底巡检：即使没人再发新消息，也要把幽灵状态清掉，否则会话会一直"聋"下去。
  const turnLeaseSweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, deadline] of [...turnLeaseDeadline]) {
      if (now > deadline) releaseConversationBusy(key, `回合超过租约 ${Math.round(turnLeaseMs() / 60000)} 分钟未收尾`);
    }
    // 孤儿唤醒标记：pendingWakeKeys 还挂着，但它对应的回合与投递队列都已不存在。
    // 实测成因：唤醒投递的同一瞬间事件流重连，turn/end 事件丢失（2026-09-26 17:17 复现）。
    // 这种状态会让该会话此后"只入库、不唤醒"，所以一旦确认孤儿就立刻解除。
    // 60 秒宽限：arm 之后到 turn/start 之间本来就有极短的窗口，别误杀。
    for (const key of [...pendingWakeKeys]) {
      const armedAt = pendingWakeArmedAt.get(key) ?? 0;
      if (!armedAt || now - armedAt < 60_000) continue;
      const q = promptQueues.get(key);
      const sid = state.sessions[key];
      const turnAlive = (q && (q.running || q.queue.length > 0)) || (sid && (v2TurnStartAt.has(sid) || collectors.has(sid)));
      if (!turnAlive) releaseConversationBusy(key, '唤醒标记还在、回合已消失（turn/end 丢失）');
    }
    // 2026-09-30 新增：僵尸收集器。
    // 正常回合在 turn/start 时会**同时**写入 v2TurnStartAt 和租约，所以
    // “有收集器、却既没有回合开始标记、也没有租约”只可能是残留（暂停/DSH 重启打断的回合）。
    // ⚠️ 上面的孤儿检测抓不到它：那里把 `collectors.has(sid)` 当成“回合还活着”的证据，
    //    僵尸收集器正好能自我证明，于是永远不自愈（2026-09-30 21:18 实测踩到）。
    for (const [sid] of [...collectors]) {
      if (v2TurnStartAt.has(sid)) continue;
      const key = reverse.get(sid);
      // ⚠️⚠️ 非 QQ 会话（PC 指令的干活会话 / 黑话学习 / 空间评论）**不在 reverse 里**，
      // 也**永远不会有** v2TurnStartAt 或回合租约 —— 它们靠各自的 turn 收集器收尾。
      // 以前这里对这类会话无条件 `collectors.delete(sid)`：于是任何比下一次巡检（最长 60 秒）
      // 跑得久的任务都会被删掉收集器 → 随后的 turn/end 落在空收集器上 → **活干完了、报告永远不回**。
      // 2026-10-01 实测两次踩到（14:47 的智谱指令 103 秒、15:21 的查 bug 指令 16 秒都丢了报告）。
      // 所以这里必须先按"是不是 QQ 会话"分流，非 QQ 会话直接跳过。
      if (!key) continue;
      if (turnLeaseDeadline.has(key)) continue;
      releaseConversationBusy(key, '回合收集器没有回合开始标记、也没有租约（回合作废）');
    }
  }, 60_000);
  turnLeaseSweeper.unref?.();

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  const VALID_MODES = ['chat', 'closed-agent', 'reserved', 'reserved2'];
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        dshDefaultPreset = presetNs.value.default;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      if (ns?.value && typeof ns.value.mode === 'string' && VALID_MODES.includes(ns.value.mode)) {
        currentMode = ns.value.mode;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    if (local?.mode && VALID_MODES.includes(local.mode)) currentMode = local.mode;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      KNOWN_AGENT_TOKENS.add(st.agentToken);
      st.bootstrapSent = false;
    }
    saveState();
    saveSocialV2State();
    void (async () => {
      try { await api.stopSessionWork(sessionId); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  // ── 上下文压缩（2026-10-25）──────────────────────────────────────────────
  // 为什么这么做：桥接拿不到 DSH 侧会话的上下文长度，DSH 也没有"改写上下文"的接口，
  // 所以只能做「滚动换届」——累计字符超阈值 → 让 AI 把关键信息写进记忆本 →
  // retireSession() 换一个干净的 DSH 会话 → 把前情提要注入新会话的第一轮。
  // 前提：记忆本（activeTopics / pendingThoughts / memberImpressions）存在 social-v2.json，
  // 与 DSH 会话解耦，换届后不会丢。
  function buildRecapV2(st) {
    if (!st) return '';
    const parts = [];
    const topics = (Array.isArray(st.activeTopics) ? st.activeTopics : []).filter((t) => t && t.text).slice(-6);
    if (topics.length) parts.push('之前聊到的：' + topics.map((t) => String(t.text).slice(0, 60)).join('；'));
    const thoughts = (Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []).filter((t) => t && t.text).slice(-3);
    if (thoughts.length) parts.push('你还想说的：' + thoughts.map((t) => String(t.text).slice(0, 60)).join('；'));
    const impObj = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const imps = Object.entries(impObj).slice(-5);
    if (imps.length) {
      parts.push('你记得的人：' + imps.map(([k, v]) => {
        const nick = String(v?.nick ?? '').trim() || k;
        const traits = Array.isArray(v?.traits) ? v.traits.slice(0, 3).join('、') : '';
        return traits ? `${nick}（${traits}）` : nick;
      }).join('；'));
    }
    const keep = Math.max(0, Number(cfg.socialV2?.context?.compactKeepRecent) || 4);
    // 过滤垃圾消息：纯链接/纯数字/纯表情/太短的（如「888:/火影忍者#...」「唉」「@某人」）留在摘要里没价值。
    const junkRe = /^[0-9a-zA-Z:\/#=\[\]{}<>+*,._\-~!?@%&|;'"()\s]+$/;
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && m.plain)
      .filter((m) => {
        const t = String(m.plain).trim();
        if (t.length < 4) return false;
        if (/https?:\/\//i.test(t)) return false;
        if (/复制链接|点击.{0,4}(打开|查看)|戳一戳|分享给你/.test(t)) return false;
        if (/[A-Z0-9]{6,}/.test(t) && !/[\u4e00-\u9fa5]{4,}/.test(t)) return false;
        if (junkRe.test(t)) return false;
        if (/^@\S+$/.test(t)) return false;
        return true;
      })
      .slice(-keep);
    if (recent.length) {
      parts.push('最后几句原话：\n' + recent.map((m) => `${m.isSelf ? '你' : (m.sender || '对方')}：${String(m.plain).slice(0, 80)}`).join('\n'));
    }
    return parts.join('\n');
  }

  function maybeScheduleCompactV2(key) {
    const cc = cfg.socialV2?.context ?? {};
    if (cc.compactEnabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.compactPendingAt) return; // 已经在交接流程里
    const threshold = Math.max(5000, Number(cc.compactThresholdChars) || 80000);
    if ((Number(st.contextChars) || 0) < threshold) return;
    const minTurns = Math.max(0, Number(cc.compactMinTurns) || 20);
    if ((Number(st.contextMsgCount) || 0) < minTurns) return;
    const cooldown = Math.max(0, Number(cc.compactCooldownMs) || 1800000);
    if (st.compactLastAt && Date.now() - Number(st.compactLastAt) < cooldown) return;
    const maxPerDay = Math.max(1, Number(cc.compactMaxPerDay) || 8);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    st.compactTimes = (Array.isArray(st.compactTimes) ? st.compactTimes : []).filter((t) => Number(t) > dayAgo);
    if (st.compactTimes.length >= maxPerDay) {
      log(`[reserved2] ${key} 今日已压缩 ${st.compactTimes.length} 次（上限 ${maxPerDay}），跳过`);
      return;
    }
    if (isConversationBusyV2(key, st)) return; // 忙的时候别插队，下个回合再说
    st.compactPendingAt = Date.now();
    saveSocialV2State();
    log(`[reserved2] ${key} 上下文累计约 ${st.contextChars} 字（${st.contextMsgCount} 条），安排交接`);
    scheduleWakeV2(key, 'compactHandoff');
  }

  function compactContextV2(key) {
    const st = getSocialV2State(key);
    if (!st || !st.compactPendingAt) return;
    // 保险丝：交接回合里 AI 一条记忆都没写，说明交接失败（它可能直接跳过了），
    // 那就取消这次压缩 —— 否则会白白丢掉上下文，前情提要还只剩几句垃圾原话。
    const pendingAt = Number(st.compactPendingAt) || 0;
    if ((Number(st.memoryWriteAt) || 0) <= pendingAt) {
      st.compactPendingAt = 0;
      saveSocialV2State();
      log(`[reserved2] ${key} 交接回合没有写入任何记忆，取消本次上下文压缩（下个周期再试）`);
      return;
    }
    const recap = buildRecapV2(st);
    const before = Number(st.contextChars) || 0;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    st.contextRecap = recap;
    st.contextChars = 0;
    st.contextMsgCount = 0;
    st.compactPendingAt = 0;
    st.compactLastAt = Date.now();
    st.compactCount = (Number(st.compactCount) || 0) + 1;
    st.compactTimes = [...(Array.isArray(st.compactTimes) ? st.compactTimes : []).filter((t) => Number(t) > dayAgo), Date.now()];
    saveSocialV2State();
    retireSession(key);
    try { appendActivity(`${key} [reserved2] 上下文已压缩：第 ${st.compactCount} 次（原约 ${before} 字）`); } catch {}
    log(`[reserved2] ${key} 上下文已压缩：第 ${st.compactCount} 次，原约 ${before} 字，前情提要 ${recap.length} 字；旧 DSH 会话已归档`);
  }

  let flushingQueue = false;
  const flushQueue = async () => {
    if (flushingQueue) return;
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [] });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
    }
  };
  // DSH 连接诊断：只在结论变化时出声（避免每 5 秒刷屏），但绝不静默。
  // 这是「版本解耦」的运行时那一半：连不上 = 等它起来；协议不通 = 出声报警，光重启没用。
  let dshDiagKind = 'init';
  let dshHostInfo = null;
  const reportDshDiag = (diag) => {
    if (diag.kind === dshDiagKind) return;
    dshDiagKind = diag.kind;
    const brief = String(diag.detail ?? '').slice(0, 160);
    if (diag.kind === 'unreachable') {
      log(`DSH 暂不可用（${brief}），QQ 消息入队等待`);
    } else if (diag.kind === 'auth') {
      log(`⚠️ DSH 鉴权失败：${brief}。检查 config.json 的 dsh.authToken；留空时由启动日志自动发现，DSH 重启换 token 后会自动重连`);
    } else if (diag.kind === 'protocol') {
      log(`⚠️ DSH 协议不兼容：${brief}。settings/describe 打不通说明 API 协议已变更（桥接适配的是斜杠 endpoint + {args} 包装），需要更新 src/dsh-client.js，重启没用`);
    } else {
      log(`⚠️ DSH 探测异常：${brief}`);
    }
  };

  // 记一次握手结果，排障时能确认「桥接连的到底是哪个 DSH、哪些端点通」。
  const recordDshHandshake = (info) => {
    try {
      fs.writeFileSync(path.join(STATE_DIR, 'dsh-protocol.json'), JSON.stringify({
        baseUrl: cfg.dsh.baseUrl,
        version: info.version || '',
        versionSource: info.versionSource || '',
        endpoints: info.endpoints ?? {},
        missing: info.missing ?? [],
        handshakeAt: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      log('写入 state/dsh-protocol.json 失败:', error?.message ?? error);
    }
  };

  const checkDsh = async () => {
    let ok = false;
    let probeError = null;
    try {
      await api.settings.describe({});
      ok = true;
    } catch (error) {
      probeError = error;
    }
    if (ok) {
      dshDiagKind = 'ready';
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        // 就绪转换时握手一次：探测关键端点是否都在，并尽力读出磁盘上的 DSH 版本。
        // 部分端点缺失不致命（降级继续跑），但要如实说出来。
        try {
          dshHostInfo = await probeDshProtocol(api);
          const local = detectLocalDshVersion();
          dshHostInfo.version = local.version;
          dshHostInfo.versionSource = local.source;
          const missingNote = dshHostInfo.missing.length ? `，缺端点 ${dshHostInfo.missing.join('/')}` : '';
          log(`DSH 握手：协议端点 ${dshHostInfo.ok}/${dshHostInfo.total}${missingNote}${local.version ? `，磁盘版本 v${local.version}` : '，版本未知'}`);
          recordDshHandshake(dshHostInfo);
        } catch (error) {
          const diag = classifyDshFailure(error);
          log(`⚠️ DSH 协议探测失败（${diag.kind}）：${String(diag.detail).slice(0, 160)}。关键端点全部不可用，桥接无法工作`);
        }
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else {
      const wasReady = dshReady;
      dshReady = false;
      const diag = classifyDshFailure(probeError);
      // 从就绪掉线单独强调一次；其余交给分类器（它只在结论变化时出声）。
      if (wasReady && diag.kind === 'unreachable') {
        dshDiagKind = 'unreachable';
        log('⚠️ DSH 断开（重启中？），QQ 消息将入队等待');
      } else {
        reportDshDiag(diag);
      }
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;

    // ── 控制台实时推送（SSE）──────────────────────────────────────────────
    // 前端以前每 3 秒打 5 个接口（status / sessions / pending / social / slang）。
    // 现在改成：服务端每 2 秒比对一次快照，**只有真变了**才推一条极小的
    // 「谁变了」消息，前端收到再按需调对应接口。请求数从 5 个/3 秒降到接近 0，
    // 而且页面闲置时完全不产生流量。
    const sseClients = new Set();
    let lastSseHashes = null;

    /** 五类资源各自的指纹。只取影响界面显示的字段，避免把大对象整个 stringify。 */
    function sseHashes() {
      const rs = readRoleState();
      return {
        status: JSON.stringify([
          currentMode, closedAgentPreset, rs.role ?? null, rs.mode ?? 'active', !!dshReady,
          dshHostInfo?.version ?? '', dshHostInfo?.missing?.join(',') ?? '',
          String(cfg.ownerQQ ?? ''), cfg.allow ?? null, cfg.deny ?? null,
          pendingWakeKeys.size, [...pendingWakeKeys].sort().join(',')
        ]),
        sessions: JSON.stringify(Object.entries(state.sessions ?? {}).map(([k, v]) => [k, v?.sessionId ?? ''])),
        pending: String(pending.size),
        social: JSON.stringify([!!socialV2.paused, [...socialV2.conversations.keys()].sort()]),
        slang: JSON.stringify((slangEntries ?? []).map((e) => [e.id, e.status, e.count, e.meaning, e.usage, e.example, e.risk]))
      };
    }

    function sseWrite(res, chunk) {
      try { res.write(chunk); return true; } catch { sseClients.delete(res); return false; }
    }

    function sseBroadcast(resources) {
      if (!sseClients.size || !resources.length) return;
      const payload = `event: change\ndata: ${JSON.stringify({ resources })}\n\n`;
      for (const res of sseClients) sseWrite(res, payload);
    }

    /** 比对快照，把变化的资源名推给所有客户端。 */
    function sseTick() {
      if (!sseClients.size) { lastSseHashes = null; return; } // 没人在看就不算
      const now = sseHashes();
      if (!lastSseHashes) { lastSseHashes = now; return; }
      const changed = Object.keys(now).filter((k) => now[k] !== lastSseHashes[k]);
      lastSseHashes = now;
      if (changed.length) sseBroadcast(changed);
    }

    // ── 联系人名录（让白名单/黑名单按"名字"操作，而不是先背下 10 位 QQ 号）──────
    // 数据来自 SnowLuma 的 get_friend_list / get_group_list。这两个要等 QQ 侧回包，
    // 单次几百毫秒到数秒，所以缓存 5 分钟；控制台点"刷新"时带 ?refresh=1 强制重查。
    const CONTACTS_TTL_MS = 5 * 60 * 1000;
    const contactsCache = { at: 0, data: null, inflight: null };
    // 昵称/备注里可能混着零宽与填充字符（实测好友备注是「陈炳旭」+ 三个 U+FFF4），
    // 不清掉的话列表里会出现一串莫名其妙的空白格，比直接显示 QQ 号还难认。
    const INVISIBLE_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\ufffc]/g;
    const cleanName = (s) => String(s ?? '').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();

    async function fetchContacts() {
      const out = { friends: [], groups: [], recent: [], errors: {} };
      // unwrapOneBot 只在 data 是"对象"时下钻，数组会原样留着（get_friend_list 返回的
      // 正是 {status,retcode,data:[...]}），所以这里要自己把数组取出来。
      const pickList = (v) => {
        if (Array.isArray(v)) return v;
        if (v && Array.isArray(v.data)) return v.data;
        return null;
      };
      // 并发查，任一失败不影响另一个（SnowLuma 挂了时至少还有"最近会话"可用）
      const [friendRes, groupRes] = await Promise.allSettled([
        callSnowLuma('get_friend_list', {}, 15000),
        callSnowLuma('get_group_list', {}, 15000)
      ]);
      const friendList = friendRes.status === 'fulfilled' ? pickList(friendRes.value) : null;
      const groupList = groupRes.status === 'fulfilled' ? pickList(groupRes.value) : null;
      if (friendList) {
        out.friends = friendList.map((f) => {
          const qq = String(f?.user_id ?? '');
          const remark = cleanName(f?.remark);
          const nick = cleanName(f?.nickname);
          // 备注优先：很多人给好友起了备注，那才是他认得的名字
          return { id: qq, name: remark || nick || qq, nickname: nick, remark };
        }).filter((f) => f.id);
      } else {
        out.errors.friends = friendRes.status === 'rejected'
          ? String(friendRes.reason?.message ?? friendRes.reason).slice(0, 200)
          : 'SnowLuma 返回了非列表数据';
      }
      if (groupList) {
        out.groups = groupList.map((g) => {
          const gid = String(g?.group_id ?? '');
          const remark = cleanName(g?.group_remark);
          const gname = cleanName(g?.group_name);
          return { id: gid, name: remark || gname || gid, groupName: gname, remark, memberCount: Number(g?.member_count) || 0 };
        }).filter((g) => g.id);
      } else {
        out.errors.groups = groupRes.status === 'rejected'
          ? String(groupRes.reason?.message ?? groupRes.reason).slice(0, 200)
          : 'SnowLuma 返回了非列表数据';
      }
      // 最近聊过的会话：通常正是想加白名单的那批人，比翻好友列表快。
      const seen = new Set();
      const pushRecent = (key, lastAt) => {
        const m = /^(private|group):(\d+)$/.exec(String(key ?? ''));
        if (!m) return;
        const k = `${m[1]}:${m[2]}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.recent.push({ id: m[2], kind: m[1], name: '', lastAt: Number(lastAt) || 0 });
      };
      for (const [key, conv] of socialV2.conversations) {
        // 真实字段是 lastIncomingAt（最后收到消息的毫秒时间戳）；
        // lastMessageAt/updatedAt 在这份状态里并不存在，写错了会让"最近聊过"排序失效。
        pushRecent(key, conv?.lastIncomingAt ?? conv?.lastActionAt ?? conv?.lastAiReplyAt ?? 0);
      }
      for (const key of Object.keys(state.sessions ?? {})) pushRecent(key, 0);
      // 用好友/群名补全 recent 的显示名
      const nameOf = new Map();
      for (const f of out.friends) nameOf.set(`private:${f.id}`, f.name);
      for (const g of out.groups) nameOf.set(`group:${g.id}`, g.name);
      for (const r of out.recent) r.name = nameOf.get(`${r.kind}:${r.id}`) || r.id;
      out.recent.sort((a, b) => b.lastAt - a.lastAt);
      return out;
    }

    async function getContacts(force = false) {
      const now = Date.now();
      if (!force && contactsCache.data && now - contactsCache.at < CONTACTS_TTL_MS) {
        return { ok: true, ...contactsCache.data, cached: true, fetchedAt: contactsCache.at };
      }
      // 并发请求合并：连点几次刷新也只真正查一次 SnowLuma
      if (contactsCache.inflight) return contactsCache.inflight;
      contactsCache.inflight = (async () => {
        try {
          const data = await fetchContacts();
          contactsCache.data = data;
          contactsCache.at = Date.now();
          return { ok: true, ...data, cached: false, fetchedAt: contactsCache.at };
        } catch (error) {
          return {
            ok: false,
            error: String(error?.message ?? error).slice(0, 200),
            friends: [], groups: [], recent: [], errors: {}
          };
        } finally {
          contactsCache.inflight = null;
        }
      })();
      return contactsCache.inflight;
    }

    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    // 令牌字符集：字母、数字、下划线、短横线、斜杠。
    // 允许斜杠是因为用户想要的密码是 `deepseekHzm2006/9/25` 这种带日期的写法：
    // 斜杠出现在 query 值里完全安全（MCP 走 x-console-token 请求头，不经过 URL），
    // 而 + # & ? % 和空格会破坏 URL/请求头，依然禁止。
    // ⚠️ 启动时（这里）和 POST /api/console/token 必须用同一条规则。两处不一致的
    // 后果是：手动设置的令牌能生效，但下一次重启时被静默判为非法、回退成随机令牌，
    // 用户只会发现"我的密码昨天还能用"。所以这里抽成共享常量。
    const CONSOLE_TOKEN_RE = /^[A-Za-z0-9_\/-]+$/;
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && CONSOLE_TOKEN_RE.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && token === st.agentToken;
    };
    // 诊断辅助：令牌本身有效、只是 key 传错时，直接告诉调用方正确的 key。
    // 二代 AI 的唤醒提示过去只给令牌不给 key，它只能瞎猜（实测猜 group:0），
    // 而报错只说"agent token 无效"，非常误导（2026-09-26 18:4x 真实事故）。
    const tokenOwnerKey = (token) => {
      if (!token) return null;
      for (const [k, c] of socialV2.conversations) {
        if (c?.agentToken && c.agentToken === token) return k;
      }
      return null;
    };
    const agentTokenError = (key, token) => {
      const owner = tokenOwnerKey(token);
      if (owner) {
        log(`[reserved2] ⚠️ key 与令牌不匹配：该令牌属于 ${owner}，调用方传的是 ${key}（已把正确 key 回给 AI）`);
        return {
          ok: false,
          error: `key 与令牌不匹配：该令牌属于 ${owner}，请改用 key=${owner} 重新调用（key 与会话令牌必须成对使用，不要猜 key）`,
          correctKey: owner
        };
      }
      return { ok: false, error: 'agent token 无效（该令牌不属于任何会话，可能是旧的/已被重置；请用当前唤醒提示里的 key 与令牌）' };
    };
    // ⛔ owner 硬闸门：只有"管理员私聊"的会话令牌能触发本机操作/空间写操作。
    // 这条在桥接代码里——不靠提示词、不靠模型自觉：群友即使说服 AI 去调用，
    // 也会在这里被 403 挡掉（v2 工具的 key+token 必须成对，且 key 必须是 owner 私聊）。
    const ownerOnlyAgentGate = (body, req) => {
      const token = req.headers['x-agent-token'];
      if (!token) return null; // 控制台请求：上游已用 consoleToken 校验过
      const key = String(body?.key ?? '').trim();
      if (!agentTokenOk(key, token)) return agentTokenError(key, String(token));
      const ownerKey = `private:${String(cfg.ownerQQ ?? '')}`;
      if (key !== ownerKey) {
        log(`⛔ 拒绝非 owner 私聊的调用（key=${key}，path=${req.url}）：该动作只能由管理员私聊触发`);
        return { ok: false, error: '这个动作只有管理员私聊能触发（桥接层已拒绝）。请不要替群友操作电脑或空间。' };
      }
      return null;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const v2ToolEnabled = (flag) => cfg.socialV2?.tools?.[flag] !== false;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      // 控制台允许被谁用 iframe 嵌：默认只放行本机启动器面板（3120）。
      // 原来是 X-Frame-Options: DENY，连自己的启动器都嵌不了；换成 CSP 的
      // frame-ancestors 精确点名，仍然挡住外部站点（2026-10-30）。
      const EMBED_ORIGINS = (Array.isArray(cfg.consoleEmbedOrigins)
        ? cfg.consoleEmbedOrigins
        : ['http://127.0.0.1:3120', 'http://localhost:3120'])
        .map((o) => String(o).trim())
        .filter(Boolean);
      const SECURITY_HEADERS = {
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
          + `frame-ancestors 'self' ${EMBED_ORIGINS.join(' ')}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
      if (consoleToken && suppliedToken !== consoleToken) {
        if (req.method === 'GET' && url.pathname === '/') {
          // 页面里必须有可见文字。原来只有一个 prompt()：用户一取消输入，
          // 页面上什么都没有，看起来就是"网页卡住了/白屏"。现在把令牌在哪、
          // 地址栏怎么用直接写在页面上，取消输入也能看到下一步该做什么。
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end([
            '<!doctype html><meta charset="utf-8"><title>需要令牌</title>',
            '<body style="font-family:system-ui,Segoe UI,sans-serif;font-size:14px;line-height:1.9;padding:2rem;max-width:46rem;color:#222">',
            '<h2 style="margin:0 0 1rem">需要控制台访问令牌</h2>',
            '<p>令牌保存在 <code>' + path.join(ROOT, 'config.json') + '</code> 的 <code>consoleToken</code> 字段，',
            '或 <code>' + path.join(STATE_DIR, 'console-token') + '</code> 文件里。</p>',
            '<p>也可以直接在地址栏写：<code>/?token=你的令牌</code></p>',
            '<p id="s" style="color:#a00">正在弹出输入框…</p>',
            '<script>',
            'const t=prompt("请输入控制台访问令牌");',
            'if(t){location.href="/?token="+encodeURIComponent(t)}',
            'else{document.getElementById("s").textContent="已取消输入。请在地址栏末尾加上 ?token=你的令牌 再回车。"}',
            '</script>',
          ].join(''));
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          // 嵌入到启动器面板（iframe）后，Origin 是启动器的端口而不是 3100，
          // 这里要一并放行，否则副页面里的按钮全部 403。
          const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
          for (const o of EMBED_ORIGINS) {
            try { allowedHosts.push(new URL(o).host); } catch { /* 配置写歪了就跳过 */ }
          }
          if (!allowedHosts.includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/unstick', '/api/qzone/auto'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            // 握手结果（连上后才有值）。排障第一眼看这里：连的是网页端还是桌面端、端点齐不齐。
            dshVersion: dshHostInfo?.version || null,
            dshProtocol: dshHostInfo ? `${dshHostInfo.ok}/${dshHostInfo.total}` : null,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 正在回合中的会话（唤醒已投递、还没收到 turn/end）。
            // stop-bot.mjs 用它判断"现在关掉会不会让 AI 白烧一轮"。
            busyKeys: [...pendingWakeKeys],
            // 每个已知会话"为什么被判忙"（'' = 空闲）。下次再出现"机器人不回话"，
            // 看这里就知道是谁占着：待发定时器 / 待收尾唤醒 / 等 DSH 回合 / 回合进行中…
            busyReasons: Object.fromEntries(
              [...new Set([...Object.keys(state.sessions), ...socialV2.conversations.keys()])]
                .map((k) => [k, busyReasonV2(k, socialV2.conversations.get(k))])
                .filter(([, why]) => why)
            ),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          if (!['chat', 'closed-agent', 'reserved', 'reserved2'].includes(body.mode)) {
            sendJson({ ok: false, error: 'mode 必须是 chat / closed-agent / reserved / reserved2' }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: body.mode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: body.mode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            const syncError = String(error?.message ?? error);
            if (/No configurable plugin entry|no longer configurable/i.test(syncError)) {
              // 0.2.x 起，settings 命名空间只认「可配置插件条目」（插件必须导出 schemastery 的 Config），
              // 而自研的 qq-mode-console 还是 0.1.x 的 `ctx.settings.register('qq-mode', …)` 写法
              //（0.2.x 的 dsh-settings 里已经没有 register 了）→ qq-mode 命名空间根本不存在。
              // 关键：这种情况下 refreshMode() 走的是「命名空间没找到 → 以本地 state/mode.json 为准」的兜底，
              // **不会**把模式改回去。所以这不是故障，也不该弹「会被改回去」的告警吓用户。
              log(`控制台：DSH 未注册 qq-mode 命名空间（0.2.x 下自研 qq-mode-console 的旧注册接口已失效），模式以本地 state/mode.json 为准，不会回滚`);
              dshSynced = true;
            } else {
              log(`控制台：模式写穿 DSH 设置失败（${syncError}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
            }
          }
          if (currentMode === 'reserved' && body.mode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开一代仿真模式，清理社交状态');
          }
          if (currentMode === 'reserved2' && body.mode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = body.mode;
          lastMode = body.mode;
          reconcileSessionPolicies();
          if (body.mode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          sendJson({ roles: listRoles(), current: rs.role ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          const name = sanitizeRoleName(body.name);
          const content = String(body.content ?? '').trim();
          if (!name) { sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return; }
          if (!content) { sendJson({ ok: false, error: '角色内容不能为空' }, 400); return; }
          if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return; }
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return; }
          fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
          atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
          log(`控制台：创建人格「${name}」`);
          sendJson({ ok: true, role: name });
          return;
        }
        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          queueSlangTask(() => runSlangResearch(candidates));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        // ── 控制台实时推送（SSE）──────────────────────────────────────────
        // EventSource 不能自定义请求头，所以令牌走 query（服务端本来就支持 ?token=）。
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no'
          });
          res.write('retry: 3000\n\n'); // 断线后 3 秒重连
          sseClients.add(res);
          // 连上先全量推一次：前端不必等第一个变更就能拿到最新状态
          sseWrite(res, `event: change\ndata: ${JSON.stringify({ resources: ['status', 'sessions', 'pending', 'social', 'slang'] })}\n\n`);
          // 心跳：防止代理/浏览器掐掉空闲连接（注释行不会触发前端的 change 回调）
          const heartbeat = setInterval(() => sseWrite(res, ': ping\n\n'), 25000);
          req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
          return;
        }

        // ── 联系人名录（白名单按名字操作）────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/contacts') {
          sendJson(await getContacts(url.searchParams.get('refresh') === '1'));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readJsonSafe(configFile, null, true);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({ security: cfg.security ?? { interceptNotify: true } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 语音 / 视频分镜 / QQ 指令：控制台读写（2026-10-30） ────────────────
        // 字段名和单位与启动器面板（launcher/config-ops.mjs）保持一致，
        // 两边读写的是同一份 config.json。
        //
        // ⚠ 生效时机不一样，别混：
        //   voice / video  桥接启动时快照进 tts / storyboard 实例 → 改完要重启
        //   pcJobs         每次判定现读 cfg → 立刻生效
        // 所以下面一律老实返回 needRestart，不假装热更新。
        const clampNum = (v, min, max) => Math.min(max, Math.max(min, v));
        const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
        const MB = 1024 * 1024;

        if (req.method === 'GET' && url.pathname === '/api/voice') {
          // 读磁盘而不是内存 cfg：手动改过 config.json 之后，面板要显示文件里的真值，
          // 否则「文件改了、面板还显示旧值」会误导人（2026-10-30）。
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const v = { ...(onDisk.voice ?? {}) };
          const local = v.local ?? {};
          sendJson({
            ok: true,
            needRestart: true,
            voice: {
              enabled: !!v.enabled,
              replaceText: v.replaceText !== false,
              scope: ['owner', 'private', 'off'].includes(v.scope) ? v.scope : 'private',
              maxChars: numOr(v.maxChars, 60),
              minChars: numOr(v.minChars, 2),
              probability: numOr(v.probability, 0.35),
              emotionBoost: numOr(v.emotionBoost, 0.35),
              cooldownSec: Math.round(numOr(v.cooldownMs, 120000) / 1000),
              hourlyCapPerConv: numOr(v.hourlyCapPerConv, 4),
              dailyCap: numOr(v.dailyCap, 40),
              quietHours: Array.isArray(v.quietHours) && v.quietHours.length === 2
                ? [numOr(v.quietHours[0], 23), numOr(v.quietHours[1], 8)]
                : null,
              speed: numOr(local.speed, 1),
              sid: numOr(local.sid, 0),
              modelDir: String(local.modelDir ?? ''),
            },
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/voice') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const v = { ...(file.voice ?? {}) };
          const local = { ...(v.local ?? {}) };
          const changed = [];

          if (typeof body.enabled === 'boolean' && !!v.enabled !== body.enabled) {
            v.enabled = body.enabled; changed.push(`enabled=${body.enabled}`);
          }
          if (typeof body.replaceText === 'boolean' && (v.replaceText !== false) !== body.replaceText) {
            v.replaceText = body.replaceText; changed.push(`replaceText=${body.replaceText}`);
          }
          if (['owner', 'private', 'off'].includes(body.scope) && v.scope !== body.scope) {
            v.scope = body.scope; changed.push(`scope=${body.scope}`);
          }

          const setNum = (key, min, max, toStore = (n) => n, cur = v[key]) => {
            if (body[key] === undefined || body[key] === null || body[key] === '') return;
            const n = Number(body[key]);
            if (!Number.isFinite(n)) return;
            const next = toStore(clampNum(n, min, max));
            if (Number(cur) !== next) { v[key] = next; changed.push(`${key}=${next}`); }
          };
          setNum('maxChars', 10, 300);
          setNum('minChars', 1, 20);
          setNum('probability', 0, 1);
          setNum('emotionBoost', 0, 1);
          setNum('hourlyCapPerConv', 1, 50);
          setNum('dailyCap', 1, 500);
          setNum('cooldownSec', 10, 3600, (n) => Math.round(n) * 1000, numOr(v.cooldownMs, 120000) / 1000);

          if (body.quietHours === null || body.quietHours === false) {
            if (v.quietHours !== null) { v.quietHours = null; changed.push('quietHours=关闭'); }
          } else if (Array.isArray(body.quietHours) && body.quietHours.length === 2) {
            const s = clampNum(Math.round(numOr(body.quietHours[0], 23)), 0, 23);
            const e = clampNum(Math.round(numOr(body.quietHours[1], 8)), 0, 23);
            if (s === e) {
              if (v.quietHours !== null) { v.quietHours = null; changed.push('quietHours=关闭'); }
            } else if (!v.quietHours || v.quietHours[0] !== s || v.quietHours[1] !== e) {
              v.quietHours = [s, e]; changed.push(`quietHours=${s}-${e}`);
            }
          }

          if (body.speed !== undefined && body.speed !== null && body.speed !== '') {
            const sp = clampNum(numOr(body.speed, 1), 0.5, 2);
            if (numOr(local.speed, 1) !== sp) { local.speed = sp; changed.push(`speed=${sp}`); }
          }
          if (body.sid !== undefined && body.sid !== null && body.sid !== '') {
            const sid = clampNum(Math.round(numOr(body.sid, 0)), 0, 99);
            if (numOr(local.sid, 0) !== sid) { local.sid = sid; changed.push(`sid=${sid}`); }
          }

          if (!changed.length) {
            sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
            return;
          }

          v.local = local;
          file.voice = v;
          atomicWriteJson(configFile, file);
          cfg.voice = v;
          log(`控制台：语音设置已更新（${changed.join('，')}）—— 重启桥接后生效`);
          sendJson({ ok: true, needRestart: true, changed });
          return;
        }

        // ── 语音调音台（2026-10-31） ──────────────────────────────────────────
        // 和 /api/voice 的分工：
        //   /api/voice      发不发、频率、上限 —— 桥接启动时快照，改完要重启
        //   /api/voice/lab  音调、音量、情绪映射、语气词 —— 每句现读 cfg，改完立即生效
        // 所以这里返回 needRestart:false 是老实话，不是假装热更新。
        const readTone = (raw) => {
          const t = raw ?? {};
          const d = DEFAULT_TONE;
          return sanitizeTone({
            enabled: t.enabled !== false,
            pitch: numOr(t.pitch, d.pitch),
            gain: numOr(t.gain, d.gain),
            emotion: {
              on: t.emotion?.on !== false,
              calm: t.emotion?.calm ?? d.emotion.calm,
              normal: t.emotion?.normal ?? d.emotion.normal,
              soft: t.emotion?.soft ?? d.emotion.soft
            },
            clips: t.clips ?? d.clips
          });
        };

        if (req.method === 'GET' && url.pathname === '/api/voice/lab') {
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const v = onDisk.voice ?? {};
          const local = v.local ?? {};
          sendJson({
            ok: true,
            needRestart: false,
            engine: String(v.engine || 'local'),
            modelDir: String(local.modelDir ?? ''),
            speed: numOr(local.speed, 1),
            sid: numOr(local.sid, 0),
            sampleRate: voiceEngine?.info?.sampleRate || 0,
            numSpeakers: voiceEngine?.info?.numSpeakers || 1,
            tone: readTone(v.tone),
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/voice/lab') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const v = { ...(file.voice ?? {}) };
          const local = { ...(v.local ?? {}) };
          const changed = [];

          if (body.speed !== undefined && body.speed !== null && body.speed !== '') {
            const sp = clampNum(numOr(body.speed, 1), 0.5, 2);
            if (numOr(local.speed, 1) !== sp) { local.speed = sp; changed.push(`语速=${sp}`); }
          }
          if (body.sid !== undefined && body.sid !== null && body.sid !== '') {
            const sid = clampNum(Math.round(numOr(body.sid, 0)), 0, 99);
            if (numOr(local.sid, 0) !== sid) { local.sid = sid; changed.push(`音色=${sid}`); }
          }

          const nextTone = readTone({ ...(v.tone ?? {}), ...(body.tone ?? {}) });
          const before = JSON.stringify(readTone(v.tone));
          if (JSON.stringify(nextTone) !== before) changed.push('调音参数');

          if (!changed.length) {
            sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
            return;
          }

          v.local = local;
          v.tone = nextTone;
          file.voice = v;
          atomicWriteJson(configFile, file);
          // 运行中的桥接也立刻拿到新值（合成时每句现读 cfg.voice）
          cfg.voice = { ...(cfg.voice ?? {}), local, tone: nextTone };
          log(`控制台：调音台已更新（${changed.join('，')}）—— 立即生效`);
          sendJson({ ok: true, needRestart: false, changed, tone: nextTone, speed: numOr(local.speed, 1), sid: numOr(local.sid, 0) });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/voice/lab/preview') {
          const body = await readBody();
          const engine = voiceEngine;
          if (!engine) {
            sendJson({ ok: false, error: '语音引擎还没初始化（桥接刚启动？稍等几秒再试）' }, 503);
            return;
          }
          let text;
          try {
            text = toSpeakable(String(body.text ?? ''), { maxChars: 200 });
          } catch (error) {
            sendJson({ ok: false, error: `文本清洗失败：${error?.message ?? error}` }, 400);
            return;
          }
          if (!text || !hasSpeakableContent(text)) {
            sendJson({ ok: false, error: '这段文字没有可念的内容' }, 400);
            return;
          }
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const local = (onDisk.voice ?? {}).local ?? {};
          const tone = resolveTone({
            tone: readTone(body.tone),
            emotion: emotionScore(text),
            baseSpeed: numOr(body.speed, numOr(local.speed, 1)),
            baseSid: numOr(body.sid, numOr(local.sid, 0)),
          });
          try {
            const audio = await engine.synthesize(text, {
              timeoutMs: 30000,
              speed: tone.speed,
              sid: tone.sid,
              pitch: tone.pitch,
              gain: tone.gain,
            });
            const dur = audio.format === 'wav' ? (audio.wav.length - 44) / 2 / (audio.sampleRate || 22050) : 0;
            res.writeHead(200, {
              'content-type': 'audio/wav',
              'content-length': audio.wav.length,
              'cache-control': 'no-store',
              'x-tone-band': tone.band,
              'x-tone-pitch': String(tone.pitch),
              'x-tone-speed': tone.speed.toFixed(3),
              'x-tone-gain': tone.gain.toFixed(3),
              'x-audio-sec': dur.toFixed(2),
              'x-audio-ms': String(audio.ms || 0),
              ...SECURITY_HEADERS,
            });
            res.end(audio.wav);
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/voice-lab') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'voice-lab.html'), 'utf8'));
          } catch {
            res.end('调音台页面缺失：qq-bridge/public/voice-lab.html');
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/video') {
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const v = { ...(onDisk.video ?? {}) };
          sendJson({
            ok: true,
            needRestart: true,
            video: {
              enabled: v.enabled !== false,
              cells: numOr(v.cells, 9),
              maxMB: Math.round((numOr(v.maxBytes, 40 * MB) / MB) * 10) / 10,
              timeoutSec: Math.round(numOr(v.timeoutMs, 150000) / 1000),
              transcript: v.transcript === 'auto' ? 'auto' : 'off',
              keepDays: numOr(v.keepDays, 2),
              maxTextChars: numOr(v.maxTextChars, 4000),
            },
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/video') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const v = { ...(file.video ?? {}) };
          const changed = [];

          if (typeof body.enabled === 'boolean' && (v.enabled !== false) !== body.enabled) {
            v.enabled = body.enabled; changed.push(`enabled=${body.enabled}`);
          }
          if ((body.transcript === 'auto' || body.transcript === 'off')
            && (v.transcript === 'auto' ? 'auto' : 'off') !== body.transcript) {
            v.transcript = body.transcript; changed.push(`transcript=${body.transcript}`);
          }
          // 插件只吃 0/4/6/9 这几种宫格
          if (body.cells !== undefined && body.cells !== null && body.cells !== '') {
            const raw = Math.round(Number(body.cells));
            const cells = [0, 4, 6, 9].includes(raw) ? raw : 9;
            if (numOr(v.cells, 0) !== cells) { v.cells = cells; changed.push(`cells=${cells}`); }
          }

          const setVid = (key, min, max, toStore, label = key) => {
            if (body[key] === undefined || body[key] === null || body[key] === '') return;
            const n = Number(body[key]);
            if (!Number.isFinite(n)) return;
            const next = toStore(clampNum(n, min, max));
            if (Number(v[key]) !== next) { v[key] = next; changed.push(`${label}=${next}`); }
          };
          setVid('maxMB', 1, 200, (n) => Math.round(n * MB));
          setVid('timeoutSec', 20, 600, (n) => Math.round(n) * 1000);
          setVid('keepDays', 1, 30, (n) => Math.round(n));
          setVid('maxTextChars', 500, 20000, (n) => Math.round(n));

          if (!changed.length) {
            sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
            return;
          }

          file.video = v;
          atomicWriteJson(configFile, file);
          cfg.video = v;
          log(`控制台：视频分镜设置已更新（${changed.join('，')}）—— 重启桥接后生效`);
          sendJson({ ok: true, needRestart: true, changed });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/pcjobs') {
          const onDisk = readJsonSafe(path.join(ROOT, 'config.json'), {}, true);
          const p = onDisk.pcJobs ?? {};
          sendJson({
            ok: true,
            needRestart: false,
            pcJobs: {
              enabled: p.enabled !== false,
              prefix: String(p.prefix ?? '指令'),
              ownerPrivateOnly: p.ownerPrivateOnly !== false,
              cwd: String(p.cwd ?? ''),
              preset: String(p.preset ?? 'standard'),
              ownerQQ: cfg.ownerQQ ? String(cfg.ownerQQ) : null,
            },
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/pcjobs') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const p = { ...(file.pcJobs ?? {}) };
          const changed = [];

          if (typeof body.enabled === 'boolean' && (p.enabled !== false) !== body.enabled) {
            p.enabled = body.enabled; changed.push(`enabled=${body.enabled}`);
          }
          if (typeof body.prefix === 'string') {
            // 前缀不能为空、不能带空白：它是正则的一部分，带空格会切错词
            const next = body.prefix.trim().replace(/\s+/g, '').slice(0, 12);
            if (next && next !== String(p.prefix ?? '指令')) {
              p.prefix = next; changed.push(`prefix=${next}`);
            }
          }

          if (!changed.length) {
            sendJson({ ok: true, needRestart: false, changed: [], note: '没有改动' });
            return;
          }

          file.pcJobs = p;
          atomicWriteJson(configFile, file);
          cfg.pcJobs = p;
          // pcJobs 是每次判定现读 cfg 的，改完立刻生效，不用重启
          log(`控制台：QQ 指令设置已更新（${changed.join('，')}）—— 立即生效`);
          sendJson({ ok: true, needRestart: false, changed });
          return;
        }

        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!CONSOLE_TOKEN_RE.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线、短横线或斜杠' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          atomicWriteJson(configFile, file);
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readJsonSafe(configFile, null, true);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = getSocialV2State(key);
            tokenLine = `【会话 key】${key}\n【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时，key 与令牌必须成对传这一组；**不要猜测 key**，就用这里给的值）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readJsonSafe(configFile, null, true);
          const current = file.socialV2 ?? {};
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
            }
            const removedV2 = socialV2.conversations.get(key);
            if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendImage: 'qq_send_image'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            knowledge: Array.isArray(cfg.socialV2?.knowledge) ? cfg.socialV2.knowledge.map((s) => String(s ?? '')).filter(Boolean) : [],
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-limit) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          sendJson({ ok: true, key, messages: st.recentMessages.slice(start, end) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = st.unread.length;
          st.unread = [];
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSocialV2State(key);
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              ...current.triggers,
              ...inputTriggers,
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          // 沉睡前强制观察只约束 AI 自己的调用（带 x-agent-token）。
          // 控制台/管理端不带该头 = 管理员明确决策，立即生效 —— 否则一个正在聊天的群
          // 永远没法调自己的唤醒条件（得等它安静满 5 分钟，群里热闹时基本等不到）。
          const isAgentCall = !!req.headers['x-agent-token'];
          if (isAgentCall && isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          if (!st.bootstrapSent) st.bootstrapSent = true;
          saveSocialV2State();
          sendWakePromptV2(key, reason);
          log(`控制台：手动唤醒 ${key}（${reason}）`);
          sendJson({ ok: true, key, reason });
          return;
        }
        // 手动解除某个会话的"卡死"状态：清掉全部忙标记（不动会话映射与聊天记录）。
        // 典型场景：某轮回合在 turn/end 前消失，该会话此后只入库不唤醒（机器人"聋了"）。
        // 一般不需要手动调——回合租约 12 分钟会自愈；这是应急的一键恢复。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/unstick') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const before = busyReasonV2(key, getSocialV2State(key));
          const cleared = releaseConversationBusy(key, '控制台手动解除');
          sendJson({ ok: true, key, before: before || '（本来就不忙）', cleared });
          return;
        }
        // PC 指令：从控制台/脚本发起一条本机操作指令，等价于 owner 私聊发「指令 …」。
        // 结果仍然回到 owner 私聊，并写 state/pc-jobs.jsonl 审计。
        if (req.method === 'POST' && url.pathname === '/api/pc/job') {
          const body = await readBody();
          const gate = ownerOnlyAgentGate(body, req);
          if (gate) { sendJson(gate, 403); return; }
          const request = String(body.request ?? '').trim();
          if (!request) { sendJson({ ok: false, error: 'request 不能为空' }, 400); return; }
          const reportKey = `private:${String(cfg.ownerQQ ?? '')}`;
          const busy = pcJobs.running;
          sendJson({ ok: true, accepted: true, busy, running: String(pcJobs.current?.req ?? ''), queued: pcJobs.queue.length });
          handlePcJob(reportKey, request).catch((error) => log('PC 指令（控制台）异常: ' + (error?.message ?? error)));
          return;
        }
        // 空间自动化自检：默认 dry-run（只读动态 + 最多出 1 条草稿，不点赞不评论不发 QQ）。
        // ── 空间快捷调整（控制台 16 节专用）：状态读取 ───────────────────────
        if (req.method === 'GET' && url.pathname === '/api/qzone/status') {
          const autoMode = qzoneAutoMode();
          const drafts = loadQzonePostDrafts();
          const todayKey = new Date().toISOString().slice(0, 10);
          sendJson({
            ok: true,
            auto: {
              mode: autoMode,
              limits: qzoneAutoLimits(autoMode),
              reviewMode: qzoneCommentMode(),
              running: qzoneAuto.running === true,
              today: { likes: qzoneAuto.todayLikes, comments: qzoneAuto.todayComments },
              cooldownUntil: qzoneAuto.cooldownUntil || null,
              lastError: qzoneAuto.lastError || null,
            },
            post: {
              ...readQzonePostAuto(),
              postedToday: drafts.filter((d) => d?.action === 'posted' && String(d.day ?? '') === todayKey).length,
              recentDrafts: drafts.slice(0, 5).map((d) => ({
                at: d.at, day: d.day, action: d.action,
                draft: d.draft ? String(d.draft).slice(0, 40) : '',
                why: d.why ? String(d.why).slice(0, 40) : '',
                ugcRight: d.ugcRight, image: !!d.imageMd5,
              })),
            },
          });
          return;
        }
        // ── 空间快捷调整：写配置（控制台专用；上游 consoleToken 中间件已鉴权，
        //    与 /api/socialV2/unstick 同一信任级别，不另设 agent gate）──────────
        if (req.method === 'POST' && url.pathname === '/api/qzone/config') {
          const body = await readBody();
          const changed = [];
          if (body.autoMode !== undefined) {
            const m = String(body.autoMode);
            if (!QZONE_AUTO_MODES.includes(m)) { sendJson({ ok: false, error: `autoMode 只能是 ${QZONE_AUTO_MODES.join(' / ')}` }, 400); return; }
            atomicWriteJson(QZONE_AUTO_FILE, { mode: m, updatedAt: new Date().toISOString() });
            changed.push(`评论自动化 → ${m}`);
          }
          if (body.reviewMode !== undefined) {
            const m = String(body.reviewMode) === 'direct' ? 'direct' : 'review';
            atomicWriteJson(QZONE_MODE_FILE, { mode: m, updatedAt: new Date().toISOString() });
            changed.push(`评论确认模式 → ${m}`);
          }
          if (body.post !== undefined) {
            const p = body.post && typeof body.post === 'object' ? body.post : {};
            const patch = {};
            if (p.enabled !== undefined) patch.enabled = p.enabled === true;
            if (p.publish !== undefined) patch.publish = p.publish === true;
            if (p.ugcRight !== undefined) patch.ugcRight = QZONE_UGC_RIGHTS.has(Number(p.ugcRight)) ? Number(p.ugcRight) : 1;
            if (p.maxPerDay !== undefined) patch.maxPerDay = Math.max(1, Math.min(10, Math.round(Number(p.maxPerDay) || 1)));
            if (p.minGapHours !== undefined) patch.minGapHours = Math.max(1, Math.min(168, Math.round(Number(p.minGapHours) || 8)));
            if (p.postChance !== undefined) patch.postChance = Math.min(1, Math.max(0, Number(p.postChance) || 0));
            if (!Object.keys(patch).length) { sendJson({ ok: false, error: 'post 里没有可改的字段' }, 400); return; }
            writeQzonePostAuto(patch);
            changed.push('说说自动配置');
          }
          if (!changed.length) { sendJson({ ok: false, error: '没有要改的项（autoMode / reviewMode / post 至少给一个）' }, 400); return; }
          log(`控制台：空间快捷调整（${changed.join('；')}）`);
          sseBroadcast(['qzone']);
          sendJson({ ok: true, changed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/qzone/auto') {
          const body = await readBody();
          const dryRun = body.dryRun !== false;
          if (qzoneAuto.running) { sendJson({ ok: false, error: '已经有一轮在跑了' }, 409); return; }
          const round = await qzoneAutoRound(dryRun);
          sendJson({
            ok: true,
            dryRun,
            mode: round.mode,
            limits: qzoneAutoLimits(round.mode),
            today: { likes: qzoneAuto.todayLikes, comments: qzoneAuto.todayComments },
            cooldownUntil: qzoneAuto.cooldownUntil || null,
            lastError: qzoneAuto.lastError || null,
            lines: round.lines,
          });
          return;
        }
        // 空间自检：把「指令 空间 …」的解释结果原样返回，**不发 QQ**、不执行写操作。
        // 用来在不动账号的前提下验证子命令与 OneBot 空间接口。
        if (req.method === 'POST' && url.pathname === '/api/qzone') {
          const body = await readBody();
          const gate = ownerOnlyAgentGate(body, req);
          if (gate) { sendJson(gate, 403); return; }
          const request = String(body.request ?? '').trim();
          // 默认 dry-run（不发 QQ、不写空间）。只有显式传 dryRun:false 才真的执行 ——
          // 用于自检"让模型出草稿"这类不产生外部可见副作用、但确实要跑模型的路径。
          const dryRun = body.dryRun !== false;
          if (!request) { sendJson({ ok: false, error: 'request 不能为空', help: qzoneHelp() }, 400); return; }
          const lines = await qzoneReply(request, dryRun);
          sendJson({ ok: true, dryRun, lines });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
          const gapMode = (isRawString && messages.length > 1) ? 'auto' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'auto');
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          // 刚用 qq_send_voice 说过同一句话？拒掉这条文字。
          // 2026-10-31：模型有时会"发语音 + 再补一遍文字"，用户会同时收到两份。
          if (st.lastVoiceAt && now - st.lastVoiceAt < 60000 && st.lastVoiceText) {
            const normalize = (s) => String(s ?? '').replace(/[\s，。！？、,.!?~～…—－-]/g, '');
            const voiceText = normalize(st.lastVoiceText);
            const messageText = normalize(messages.join(''));
            if (voiceText && messageText && (voiceText === messageText || voiceText.includes(messageText) || messageText.includes(voiceText))) {
              sendJson({ ok: false, error: '你刚用语音说过这句了，不用再发一遍文字。要说别的就换个说法。' }, 409);
              return;
            }
          }
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            // 语音替代了文字时明确告诉模型"已经发出去了"，否则它会再补一条（见 sendMessagesV2 的注释）。
            const voicedHint = sentMessages.voiced === true ? '这条已经用语音说出去了，不要再补一遍同样的文字。' : undefined;
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(sentMessages.voiced === true ? { voiced: true } : {}), ...(voicedHint ? { hint: voicedHint } : {}), ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: text.slice(0, 200),
              plain: text.slice(0, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 发真实图片（2026-10-03 新增）：机器人以前只能发文字和收藏表情，"秀一下自己"只能靠嘴描述。
        // source="self" 发自己的 Q 版形象图；source="file" 发 assets/ 目录里的图片（路径经
        // resolveImageFileUnderRoot 校验：只能在该目录内、只能是图片扩展名、有大小上限）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const source = String(body.source ?? 'self').trim() || 'self';
          const relPathInput = String(body.path ?? body.file ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          // 仿真常识：图片消息只能是一张图，不能在同一气泡里附带文字说明。
          if (body.message || body.caption) {
            sendJson({ ok: false, error: '图片消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_image 发图' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const imagesCfg = cfg.socialV2?.images ?? {};
          const maxBytes = Number(imagesCfg.maxBytes) > 0 ? Number(imagesCfg.maxBytes) : 8 * 1024 * 1024;
          const assetsRoot = path.join(ROOT, 'assets');
          let resolvedImage;
          try {
            if (source === 'self') {
              resolvedImage = resolveImageFileUnderRoot(assetsRoot, imagesCfg.selfFile || 'deepseek娘.png', { maxBytes });
            } else if (source === 'file') {
              resolvedImage = resolveImageFileUnderRoot(assetsRoot, relPathInput, { maxBytes });
            } else {
              sendJson({ ok: false, error: 'source 只能是 self（自己的形象图）或 file（assets 目录里的图片）' }, 400);
              return;
            }
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfgImage = cfg.socialV2?.send ?? {};
          const nowImage = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfgImage.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfgImage.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => nowImage - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => nowImage - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(nowImage);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendImageV2(key, resolvedImage, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记进二代会话的 recentMessages，让 AI 知道自己发过这张图（避免重复发/答非所问）
            const label = path.basename(sent.file || resolvedImage.relPath || '图片');
            const text = `[我发的图片:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: text.slice(0, 200),
              plain: text.slice(0, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: true,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = nowImage;
            st.lastActionAt = nowImage;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[image] 工具发送图片 ${key}: ${sent.file}（${Math.round(sent.size / 1024)} KB）`);
            appendActivity(`${key} [image] 工具发送图片：${label}`);
            sendJson({ ok: true, key, image: { file: sent.file, size: sent.size }, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(nowImage);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[image] 工具发送图片失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 发语音（2026-10-31 新增）：让模型能自己决定发语音，而不是只靠桥接掷骰。
        // 起因：模型没有发语音的工具，用户说"发一条语音"时它会编一个不存在的工具，
        // 参数写成非法 JSON → "DeepSeek Messages stream: tool input is invalid JSON"。
        // 与自动语音的区别：这里 rand 恒为 0（必中），其余冷却/小时上限/日上限/字数/
        // 范围检查全部复用 decide()，所以防刷屏策略一致。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const rawText = String(body.text ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!rawText) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (!voiceCfg.enabled) { sendJson({ ok: false, error: '语音功能已关闭（config.voice.enabled=false）' }, 403); return; }

          // rand 恒 0 = 跳过掷骰（模型主动要求就发），但冷却/上限/字数/范围照常卡。
          const decision = decide({
            key,
            text: rawText,
            cfg: voiceCfg,
            memory: voiceMemory.data,
            now: Date.now(),
            rand: () => 0,
            ownerKey: cfg.ownerQQ ? `private:${cfg.ownerQQ}` : ''
          });
          if (!decision.speak) {
            sendJson({ ok: false, error: `现在不能发语音：${decision.reason}。请改发文字。` }, 429);
            return;
          }
          try {
            const started = Date.now();
            const timeoutMs = Number(voiceCfg.timeoutMs) || 25000;
            const tone = toneFor(rawText);
            const audio = await tts.synthesize(rawText, {
              timeoutMs,
              speed: tone.speed,
              sid: tone.sid,
              pitch: tone.pitch,
              gain: tone.gain
            });
            await sendVoiceRecord(key, audio.wav);
            recordSpoken(voiceMemory.data, key);
            voiceMemory.save();
            const dur = ((audio.wav.length - 44) / 2 / (audio.sampleRate || 22050)).toFixed(1);
            // 记进 recentMessages：让 AI 知道自己刚发过语音，避免重复或答非所问。
            const stVoice = getSocialV2State(key);
            const voiceLabel = `[我发的语音]${rawText.slice(0, 60)}`;
            stVoice.recentMessages.push({
              messageId: null,
              sender: '我',
              text: voiceLabel,
              plain: voiceLabel,
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: true,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimitVoice = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (stVoice.recentMessages.length > recentLimitVoice) stVoice.recentMessages.splice(0, stVoice.recentMessages.length - recentLimitVoice);
            stVoice.lastAiReplyAt = Date.now();
            stVoice.lastActionAt = Date.now();
            stVoice.wakeConfig.noActionCount = 0;
            // 记下"刚用语音说过什么"：紧接着的 send_message 如果内容重复就拒掉，
            // 否则用户会同时收到语音和一模一样的文字（2026-10-31 实测）。
            stVoice.lastVoiceAt = Date.now();
            stVoice.lastVoiceText = rawText;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[voice] 工具发送语音 ${key}: ${rawText.length} 字 / ${dur}s / 合成 ${Date.now() - started}ms / 档=${tone.band}`);
            appendActivity(`${key} [voice] 工具发送语音：${rawText.slice(0, 40)}`);
            sendJson({ ok: true, key, text: rawText, durationSec: Number(dur), synthMs: Date.now() - started });
          } catch (error) {
            log(`[voice] 工具发送语音失败 ${key}: ${error?.message ?? error}`);
            appendActivity(`${key} [voice] 语音未发出：${String(error?.message ?? error).slice(0, 120)}`);
            sendJson({ ok: false, error: `发送语音失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 自我画像（2026-10-31 新增，L2 层）：AI 自己写"我观察到的自己"。
        // 只增不删，写进 state/self-profile.md，注入时排在角色卡之后。
        // 角色卡（L0）永远不通过这里改 —— 那里面有安全边界，改了等于自废约束。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/self-profile') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const text = String(body.text ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (!text) { sendJson({ ok: false, error: 'text 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('selfProfile')) { sendJson({ ok: false, error: '工具未启用：qq_update_self_profile' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式必须携带 agent token' }, 403); return; }
          // 频率限制：每小时最多 3 条，防止一次醒来刷满整页
          const stProfile = getSocialV2State(key);
          const nowProfile = Date.now();
          stProfile.selfProfileTimes = (stProfile.selfProfileTimes || []).filter((t) => nowProfile - t < 3600000);
          if (stProfile.selfProfileTimes.length >= 3) {
            sendJson({ ok: false, error: '这一小时已经写过 3 条自我认知了，攒一攒再写' }, 429);
            return;
          }
          const result = appendSelfProfile(text);
          if (!result.ok) { sendJson(result, 400); return; }
          stProfile.selfProfileTimes.push(nowProfile);
          saveSocialV2State();
          log(`[self-profile] 新增自我认知（${key}，第 ${result.count} 条）: ${result.line}`);
          appendActivity(`${key} [self] 记下关于自己的一条：${text.slice(0, 40)}`);
          sendJson({ ok: true, count: result.count, line: result.line });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-profile') {
          const suppliedProfileToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
          if (!consoleToken || suppliedProfileToken !== consoleToken) { sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401); return; }
          sendJson({ ok: true, lines: readSelfProfileLines() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          let force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          const heldLock = activeWaits.get(key);
          if (heldLock) {
            if (Date.now() < heldLock.deadline) {
              sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
              return;
            }
            // 锁已经超过它自己的最晚释放时间 = 上一个等待的 handler 卡住了。
            // 不清理的话这个会话永远无法再等待（2026-09-25 22:00 就是这样卡了一轮）。
            log(`[resilience] ${key} 的等待锁已超时 ${Math.round((Date.now() - heldLock.deadline) / 1000)}s，强制清理`);
            activeWaits.delete(key);
          }
          // 最大合法占用：timeoutMs + maxQuietMs（上限 120s）+ 余量
          const waitLockMs = timeoutMs + 140000;
          const waitToken = { deadline: Date.now() + waitLockMs };
          activeWaits.set(key, waitToken);
          // 只有"锁还是我这一把"时才释放：卡住的旧 handler 不能误删新一轮的锁。
          const finishWait = () => {
            if (activeWaits.get(key) === waitToken) activeWaits.delete(key);
          };
          // 兜底闸：即使 handler 因为任何原因没走到释放（异常/长挂/客户端消失后 close 不触发），
          // 到点也必须把锁放掉，绝不让它永久残留。
          const waitLockTimer = setTimeout(() => {
            if (activeWaits.get(key) === waitToken) {
              log(`[resilience] ${key} 的等待锁到点未释放，兜底清理`);
              activeWaits.delete(key);
            }
          }, waitLockMs);
          waitLockTimer.unref?.();
          req.on('close', finishWait);
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          const baseline = st.lastUnreadSeq || 0;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              // 但总上限必须留在 MCP 客户端的 HTTP 预算之内：客户端的预算是
              // timeoutMs + max(quietMs,10000) + 20000（见 src/mcp-snowluma-safe.js），
              // 原来用 maxQuietMs(最多 120s) 做上限会比客户端先超时 —— 客户端拿到 -32001 放弃，
              // 桥接却还占着等待锁继续跑，这个会话在锁释放前一直无法再等待。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + quietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          saveSocialV2State();
          const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !!st.preSleepWaitObservedAt,
            preSleepWaitMs,
            preSleepWaitRemainingMs: preSleepRemainingMs,
            newMessages,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = rawMessage.slice(0, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            if (['__proto__', 'constructor', 'prototype'].includes(String(target))) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            // 2026-10-25：key 走 QQ 号；改昵称只更新 nick，不再搬 key（搬 key 会丢关联）
            const r = resolveImpressionKeyV2(st, target);
            const impKey = r.key;
            if (!impKey) { sendJson({ ok: false, error: '找不到该群友的印象' }, 404); return; }
            const im = st.memberImpressions[impKey] || {};
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (cleanNewExtra.target !== undefined) {
              const nn = String(cleanNewExtra.target).trim();
              if (!nn || ['__proto__', 'constructor', 'prototype'].includes(nn)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
              im.nick = nn;
            }
            if (!im.nick) im.nick = r.nick || String(target);
            st.memberImpressions[impKey] = im;
            if (r.nick && r.nick !== impKey) delete st.memberImpressions[r.nick];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            // 兼容新旧两种 key：QQ 号 / 昵称 / 调用方原样传的字符串，都删掉
            const r = resolveImpressionKeyV2(st, target);
            for (const k of new Set([r.key, r.nick, String(target)].filter(Boolean))) delete st.memberImpressions[k];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (currentMode === 'reserved2' && !agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          if (token && !agentTokenOk(key, token)) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
            return;
          }
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson(agentTokenError(key, req.headers['x-agent-token'] ?? ''), 403); return; }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          const removedV2 = socialV2.conversations.get(key);
          if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await api.stopSessionWork(oldSessionId); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await api.sessions.list({}), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await api.stopSessionWork(item.sessionId); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          for (const st of socialV2.conversations.values()) {
            if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
          }
          socialV2.conversations.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // SSE 快照比对：2 秒一次。没人在看时 sseTick 会直接返回，不算哈希也不占 CPU。
    const sseTimer = setInterval(sseTick, 2000);
    if (typeof sseTimer.unref === 'function') sseTimer.unref(); // 别让定时器拖住进程退出
    server.on('close', () => clearInterval(sseTimer));
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error))
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error));
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 语音回复（可选） ────────────────────────────────────────────────────
  // 策略在 voice-policy.js（纯函数，好测），引擎在 tts.js（本地 sherpa-onnx / 外部 HTTP）。
  // 这里只做三件事：判定 → 合成 → 发 record 段。任何一步失败都只降级成文字，不静默。
  const voiceCfg = cfg.voice || {};
  const tts = createTts(voiceCfg, { log, rootDir: ROOT });
  voiceEngine = tts;
  const voiceMemory = createVoiceMemory(path.join(STATE_DIR, 'voice.json'));

  async function sendVoiceRecord(key, wav) {
    const [kind, id] = key.split(':');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params =
      kind === 'private'
        ? { user_id: Number(id), message: [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }] }
        : { group_id: Number(id), message: [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }] };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`语音发送失败：${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  }

  // 先做决策（同步、不发送）。返回 { decision, spoken, replace } 或 null。
  // replace=true 表示「用语音替代文字」：命中后调用方不要再发同样的文字，避免重复。
  function planVoice(key, rawText) {
    if (!voiceCfg.enabled) return null;
    const maxChars = Number(voiceCfg.maxChars) || 60;
    // 原文超长：只发文字、不补语音。
    // toSpeakable 会把长文本截断到 maxChars 再交给 decide，若不先卡原文长度，
    // 长回复会被截成 60 字念出来；一旦 replaceText 命中还会把原文整段吞掉 → 丢内容。
    if (String(rawText ?? '').trim().length > maxChars) return null;
    let spoken;
    try {
      spoken = toSpeakable(rawText, { maxChars });
    } catch (error) {
      log(`语音清洗异常 (${key})：${error?.message ?? error}`);
      return null;
    }
    if (!hasSpeakableContent(spoken)) return null;
    const decision = decide({
      key,
      text: spoken,
      cfg: voiceCfg,
      memory: voiceMemory.data,
      ownerKey: cfg.ownerQQ ? `private:${cfg.ownerQQ}` : ''
    });
    if (!decision.speak) {
      log(`语音跳过 (${key})：${decision.reason}`);
      return null;
    }
    // decide 只在文本 ≤ maxChars 时才 speak（原文已先卡过长），所以替代不会丢内容；
    // replaceText=false 时退回「文字+语音」旧行为。
    const replace = !!voiceCfg.replaceText;
    return { decision, spoken, replace };
  }

  // 这一句按什么音色念。
  // 调音参数（音调/音量/情绪映射）每句现读 cfg.voice —— 所以调音台改完立即生效；
  // 模型目录、引擎仍是启动时的快照，那两样要重启。
  function toneFor(text) {
    const v = cfg.voice ?? voiceCfg;
    return resolveTone({
      tone: v.tone,
      emotion: emotionScore(text),
      baseSpeed: Number(v.local?.speed) || 1,
      baseSid: Number(v.local?.sid) || 0,
    });
  }

  // 真正合成 + 经 OneBot 发语音，挂到 sendChain 排队；失败只降级、不静默。
  function enqueueVoice(key, plan) {
    const assertSendAllowed = captureSendGuard(key);
    sendChain = sendChain
      .then(async () => {
        assertSendAllowed();
        const started = Date.now();
        const timeoutMs = Number(voiceCfg.timeoutMs) || 25000;
        const tone = toneFor(plan.decision.text);
        const audio = await tts.synthesize(plan.decision.text, {
          timeoutMs,
          speed: tone.speed,
          sid: tone.sid,
          pitch: tone.pitch,
          gain: tone.gain,
        });

        // 语气词：从词库随机挑一个，跟正文拼成一条语音（间隔留一点气口）。
        // 词条也走同一个 TTS 合成，第二次就命中缓存，不用另存素材文件。
        let wav = audio.wav;
        let clipWord = '';
        const clips = (cfg.voice ?? voiceCfg).tone?.clips;
        if (clips?.on && Array.isArray(clips.list) && clips.list.length && Math.random() < (Number(clips.chance) || 0)) {
          const word = String(clips.list[Math.floor(Math.random() * clips.list.length)] || '').trim();
          if (word) {
            try {
              const clip = await tts.synthesize(word, {
                timeoutMs,
                speed: tone.speed,
                sid: tone.sid,
                pitch: tone.pitch,
                gain: tone.gain,
              });
              wav = concatWav([clip.wav, audio.wav], { gapMs: Number(clips.gapMs) || 90 });
              clipWord = word;
            } catch (error) {
              log(`语气词「${word}」没拼上，只念正文：${error?.message ?? error}`);
            }
          }
        }

        await sendVoiceRecord(key, wav);
        recordSpoken(voiceMemory.data, key);
        voiceMemory.save();
        const isWav = wav === audio.wav ? audio.format === 'wav' : true;
        const dur = isWav ? ((wav.length - 44) / 2 / (audio.sampleRate || 22050)).toFixed(1) : '?';
        log(
          `语音已发 (${key}) ${plan.decision.text.length} 字 / ${dur}s 音频 / 合成 ${Date.now() - started}ms` +
            ` / 档=${tone.band} 音调=${tone.pitch} 语速=${tone.speed.toFixed(2)}` +
            `${clipWord ? `（语气词「${clipWord}」）` : ''}${plan.replace ? '（替代文字）' : ''}`
        );
        appendActivity(`${key} 发了一条语音：${plan.decision.text.slice(0, 40)}`);
      })
      .catch((error) => {
        // 失败必须出声：主人能从日志和控制台活动里看见，而不是"怎么没声音"。
        log(`⚠️ 语音未发出 (${key})：${error?.message ?? error}`);
        appendActivity(`${key} 语音未发出：${String(error?.message ?? error).slice(0, 120)}`);
      });
  }

  // 兼容旧行为：文字照发，再追加一条语音（replaceText=false 或无法替代时）。
  function maybeSendVoice(key, rawText) {
    const plan = planVoice(key, rawText);
    if (plan) enqueueVoice(key, plan);
  }

  if (voiceCfg.enabled) tts.warmup();

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // 单条消息图片总字节上限（与 safeFetchBuffer 默认一致）
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media) {
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            }
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        log(`get_image 解析失败: ${error?.message ?? error}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        log(`图片 URL 抓取失败: ${error?.message ?? error}`);
      }
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc} face:${media.faceId}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  // 视频 → 分镜图 + 时间码清单。失败就退化成一行说明，绝不让整条消息丢掉。
  async function resolveVideoParts(media, index) {
    if (!videoStoryboard.available()) {
      return { bytes: 0, parts: [{ type: 'text', text: `[视频${index}（这台机器还没装视频分镜，看不到内容）]` }] };
    }
    const url = String(media.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { bytes: 0, parts: [{ type: 'text', text: `[视频${index}（拿不到可下载的地址，看不到内容）]` }] };
    }
    try {
      const result = await videoStoryboard.run({ url, tag: media.file || url });
      const parts = [
        { type: 'text', text: `[视频${index}] 下面是按时间顺序的分格清单，每格带起止时间；先读清单，需要细节再对照图片。` },
        { type: 'image', mediaType: 'image/png', data: result.pngBuffer.toString('base64'), name: `qq-video-${index}.png` }
      ];
      if (result.text) parts.push({ type: 'text', text: result.text });
      return { bytes: result.pngBuffer.length, parts };
    } catch (error) {
      log(`视频分镜失败 (${index}): ${error?.message ?? error}`);
      return {
        bytes: 0,
        parts: [{ type: 'text', text: `[视频${index}（解析失败：${String(error?.message ?? error).slice(0, 100)}）]` }]
      };
    }
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    let videoCount = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'video') {
        // 一条消息只解析第一个视频：下载 + 抽帧都是重活，连发三个视频能把回复拖成几分钟。
        videoCount += 1;
        if (videoCount > 1) {
          parts.push({ type: 'text', text: `[视频${index}（单条消息只解析第一个视频，已跳过）]` });
          continue;
        }
        const videoParts = await resolveVideoParts(media, index);
        totalBytes += videoParts.bytes;
        parts.push(...videoParts.parts);
      } else if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-image-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（获取失败）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'video') {
        // 视频走分镜：抽宫格图 + 时间码清单。以前这里没有 video 分支，
        // 视频会掉进下面的 else 被当图片抓 → "抓取内容不是有效图片"（2026-10-31 实测）。
        const videoParts = await resolveVideoParts(media, index);
        const imagePart = videoParts.parts.find((p) => p.type === 'image');
        const textPart = videoParts.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        if (imagePart) {
          totalBytes += videoParts.bytes;
          out.push({
            index,
            kind: 'video',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: imagePart.mediaType || 'image/png',
            data: imagePart.data,
            text: textPart
          });
        } else {
          out.push({ index, kind: 'video', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: textPart || '（视频解析失败）' });
        }
      } else if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（图片获取失败）' });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    // 分开数：视频要明确告诉模型"有视频"，否则它只会当成图片，压根不会调工具。
    const videoCount = mediaList.filter((m) => m && m.kind === 'video').length;
    const otherCount = mediaList.length - videoCount;
    const label = [
      videoCount > 0 ? `${videoCount} 个视频` : '',
      otherCount > 0 ? `${otherCount} 个图片/表情` : ''
    ].filter(Boolean).join('、') || `${mediaList.length} 个媒体`;
    if (currentMode === 'reserved2') {
      return `\n【媒体】本条消息包含 ${label}（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}"（当前会话 key，不要改动）, messageId="${messageRef}"。视频会返回一张宫格分镜图 + 带时间码的清单，先读清单，需要细节再对照图片。`;
    }
    return `\n【媒体】本条消息包含 ${label}（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st && Array.isArray(st.recentMessages)) {
          const found = st.recentMessages.find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
          if (found && Array.isArray(found.media)) return found.media;
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    // 替代模式：单段、短的回复直接发语音，不重复发同一句文字
    const plan = planVoice(key, messages.join(''));
    if (plan && plan.replace && messages.length === 1) {
      enqueueVoice(key, plan);
      return sendChain.then(() => {
        if (failed.length > 0) {
          const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
          err.sent = sent.slice();
          throw err;
        }
        // 语音已经替代了这条文字，必须算作"已发送"。
        // 2026-10-31 实测：以前这里返回空数组 → 模型收到 sent:0/failed:1 →
        // 以为没发出去 → 又调一次 send_message → 用户同时收到语音和文字。
        sent.push(messages[0]);
        sent.voiced = true;
        return sent;
      });
    }
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      // 二代仿真（reserved2）里 AI 用工具发消息，不经过 sendToQQ；语音挂在这里才接得上。
      if (sent.length > 0) maybeSendVoice(key, sent.join(''));
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    const plan = planVoice(key, text);
    if (plan && plan.replace) {
      // 语音替代文字：只发语音，不再发同一句文字（去重）
      enqueueVoice(key, plan);
    } else {
      await sendToQQ(key, text);
      if (plan) enqueueVoice(key, plan);
    }
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次。
  // 四种 QQ 模式共用 DSH 会话，统一使用 cfg.dsh 里配的 provider/model/reasoningEffort。
  // 用 deepseek-flash 是因为它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  // ⚠️ reasoningEffort 直接决定花钱多少：思考链按"输出"计费（¥4/M 空闲、¥8/M 高峰），
  // 而缓存命中的输入只要 ¥0.02/M —— 输出是它的 200 倍。闲聊不需要深度推理，
  // 所以这里配 low；下面的 `|| 'max'` 兜底是"最贵档"，缺配置时请务必显式写清楚。
  const modelAppliedSessions = new Map(); // sessionId -> "provider/model"
  const apiAdapter = createApiAdapter({
    cfg,
    log,
    stateFile: path.join(STATE_DIR, 'api-adapt.json'),
    fallbackProvider: () => ({
      provider: String(cfg.dsh?.provider || 'deepseek-official'),
      model: String(cfg.dsh?.model || 'deepseek-flash'),
      reasoningEffort: String(cfg.dsh?.reasoningEffort || 'max')
    })
  });
  // 视频分镜：收到视频时把 url 落盘、跑 dsh-video-storyboard，产出宫格图 + 时间码清单。
  // 关掉它就退回老行为（只显示 `[视频]` 占位）。
  const videoStoryboard = createVideoStoryboard({ cfg, log, stateDir: STATE_DIR });
  // 只有"看起来像上游/鉴权/额度问题"的报错才触发换 provider，
  // 避免因为无关的业务错误把模型来回切。
  // reasoning_content 也归到这一类：换模型后旧历史缺思考链，这类模型会直接拒（2026-10-17 实测 beam-free）。
  const PROVIDER_ERROR_RE = /(quota|rate.?limit|429|insufficient|balance|unauthor|upstream|overload|api.?key|ECONN|ETIMEDOUT|socket hang up|reasoning_content|5\d\d)/i;
  function noteProviderFailure(text) {
    if (!text) return;
    const s = String(text);
    if (!PROVIDER_ERROR_RE.test(s)) return;
    const cur = apiAdapter.current;
    if (cur) apiAdapter.reportFailure(cur.provider, cur.model);
  }
  async function ensureChatModel(sessionId) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // 自动适配：按候选顺序挑一个当前可用的 provider/model（OFM 优先、官方 DeepSeek 兜底）。
      // 关掉 dsh.autoAdapt 时它退化成原来的 cfg.dsh.provider/model 行为。
      const pick = await apiAdapter.resolve({ force: attempt > 1 });
      const tag = `${pick.provider}/${pick.model}`;
      if (modelAppliedSessions.get(sessionId) === tag) return;
      // 「不支持某思考档位」是配置与模型能力不匹配，不是 provider 故障：
      // 先原样试；若被拒，就把 reasoningEffort 去掉再试一次（用模型默认档），
      // 关键是不因此给它上冷却——否则一个免费的候选会被白白跳掉十分钟。
      const attempts = pick.reasoningEffort ? [pick.reasoningEffort, undefined] : [undefined];
      let lastError = null;
      let applied = false;
      for (const effort of attempts) {
        try {
          const result = unwrap(
            await api.sessions.selectModel({
              sessionId,
              provider: pick.provider,
              model: pick.model,
              ...(effort ? { reasoningEffort: effort } : {})
            }),
            'session.selectModel'
          );
          modelAppliedSessions.set(sessionId, tag);
          log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
          applied = true;
          break;
        } catch (error) {
          lastError = error;
          const msg = String(error?.message ?? error);
          if (effort && /reasoning effort|reasoningEffort|思考档/i.test(msg)) {
            log(`会话模型 ${tag} 不接受思考档「${effort}」，改用默认档重试`);
            continue;
          }
          break;
        }
      }
      if (applied) return;
      log(`设置会话模型失败 ${sessionId}（${tag}，第 ${attempt}/3 次）: ${lastError?.message ?? lastError}`);
      // 只有 provider 类错误才让 autoAdapt 记失败换候选；「会话不存在」这类本会话问题
      // 不能连坐模型（2026-10-24：一次会话失效把三个候选全拖进 600s 冷却，新会话全线选不出模型）。
      if (PROVIDER_ERROR_RE.test(String(lastError?.message ?? lastError))) {
        apiAdapter.reportFailure(pick.provider, pick.model);
      }
      if (attempt < 3) await sleep(1000);
    }
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        await ensureChatModel(existing);
        if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
        return existing;
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      // 遇到底层插件尚未就绪时退避重试。
      // 背景（2026-10-31 实测）：桌面端启动要加载 11 个全局插件（含 3 个 MCP client），
      // 耗时从 10s 一路涨到 33s；preset 内插件 qq-tool-restrict 声明 inject ['tools']，
      // tools 服务没就绪就会被判 "never started"，sessions.create 直接失败。
      // 以前这里一抛错就放弃 → 唤醒投递失败 → QQ 消息送不出去（用户侧看着像"机器人没反应/识别错误"）。
      // 只对「插件未就绪」这类瞬时错误重试；真正的配置错误重试也没用，交给上层报错。
      const PRESET_NOT_READY_RE = /never started|still waiting for|plugin entries/i;
      const CREATE_RETRY_DELAYS = [2000, 5000, 10000, 15000]; // 累计约 32s，覆盖插件加载窗口
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        const maxAttempt = withPreset && preset ? CREATE_RETRY_DELAYS.length + 1 : 1;
        for (let attempt = 1; attempt <= maxAttempt; attempt += 1) {
          try {
            const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
            if (wsValue.created && cfg.workspaceTitle) {
              await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
            }
            const params = { workspaceId: wsValue.workspace.workspaceId };
            if (withPreset && preset) params.agentPreset = preset;
            const value = unwrap(await api.sessions.create(params), 'session.create');
            sessionId = value.sessionId;
            if (withPreset && preset) {
              log(attempt > 1
                ? `会话 ${key} 已挂载 preset ${preset}（第 ${attempt} 次尝试成功，前 ${attempt - 1} 次插件未就绪）`
                : `会话 ${key} 已挂载 preset ${preset}`);
            } else if (preset) {
              log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
            }
            break;
          } catch (error) {
            lastError = error;
            const message = String(error?.message ?? error);
            const retryable = withPreset && Boolean(preset) && PRESET_NOT_READY_RE.test(message);
            if (!retryable || attempt >= maxAttempt) break;
            const delay = CREATE_RETRY_DELAYS[attempt - 1];
            log(`会话 ${key} 创建失败（preset ${preset} 插件未就绪）：${message}；${delay}ms 后重试（第 ${attempt}/${maxAttempt - 1} 次）`);
            await sleep(delay);
            // 重试等待期间可能被 reset / 权限变化，及时放弃，避免复活旧会话
            if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
              throw new Error('会话创建期间已重置或权限已变化，放弃重试');
            }
          }
        }
        if (sessionId) break;
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        contextChars: 0,
        contextMsgCount: 0,
        contextRecap: '',
        compactPendingAt: 0,
        compactLastAt: 0,
        compactCount: 0,
        compactTimes: [],
        memoryWriteAt: 0,
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      KNOWN_AGENT_TOKENS.add(st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            // 上下文压缩相关（2026-10-25）：必须在这里白名单式加载，否则重启后丢失
            contextChars: Number(val.contextChars) || 0,
            contextMsgCount: Number(val.contextMsgCount) || 0,
            contextRecap: typeof val.contextRecap === 'string' ? val.contextRecap : '',
            compactPendingAt: Number(val.compactPendingAt) || 0,
            compactLastAt: Number(val.compactLastAt) || 0,
            compactCount: Number(val.compactCount) || 0,
            compactTimes: Array.isArray(val.compactTimes) ? val.compactTimes.map((t) => Number(t)).filter((t) => Number.isFinite(t)) : [],
            memoryWriteAt: Number(val.memoryWriteAt) || 0,
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          KNOWN_AGENT_TOKENS.add(st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        saveSocialV2State();
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          // 上下文压缩相关（2026-10-25）：加载与保存都是白名单式，两处都必须列上，
          // 漏一处就会「重启后计量归零 / 压缩记录丢失」。
          contextChars: st.contextChars || 0,
          contextMsgCount: st.contextMsgCount || 0,
          contextRecap: typeof st.contextRecap === 'string' ? st.contextRecap : '',
          compactPendingAt: st.compactPendingAt || 0,
          compactLastAt: st.compactLastAt || 0,
          compactCount: st.compactCount || 0,
          compactTimes: Array.isArray(st.compactTimes) ? st.compactTimes.slice(-50) : [],
          memoryWriteAt: st.memoryWriteAt || 0,
          activeTopics: Array.isArray(st.activeTopics)
            ? st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000)).slice(-50)
            : [],
          pendingThoughts: Array.isArray(st.pendingThoughts)
            ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).slice(-50)
            : [],
          memberImpressions: (() => {
            const im = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
            const keys = Object.keys(im);
            if (keys.length <= 30) return im;
            // 保留互动次数最多的 30 人，避免无限膨胀
            const sorted = keys
              .map((k) => ({ k, count: Number(im[k]?.interactionCount) || 0 }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 30)
              .map((x) => x.k);
            const trimmed = {};
            for (const k of sorted) trimmed[k] = im[k];
            return trimmed;
          })(),
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  const IMPRESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // memberImpression 自动衰减：7天未互动即过期

  // 2026-10-25 修复：群友印象原来按「昵称」存 key，改昵称就断、重名会串。
  // 现在优先落到 QQ 号（userId）上，昵称只存在 value.nick 里做显示。
  // AI 调用时只知道昵称，所以这里从最近消息里反查 userId；查不到才退回按昵称存（legacy）。
  function resolveImpressionKeyV2(st, target) {
    const t = String(target ?? '').trim();
    if (!t) return { key: '', nick: '' };
    // 1) 调用方直接给了 QQ 号
    if (/^\d{5,12}$/.test(t)) {
      const im = st?.memberImpressions?.[t];
      return { key: t, nick: String(im?.nick ?? '') };
    }
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const candidates = recent.filter((m) => m && m.userId && String(m.sender ?? '').trim());
    // 2) 昵称精确匹配（取最新一条）
    for (let i = candidates.length - 1; i >= 0; i--) {
      const m = candidates[i];
      if (String(m.sender).trim() === t) return { key: String(m.userId), nick: String(m.sender).trim() };
    }
    // 3) 包含匹配：群名片常带前后缀（如「小明(摸鱼)」），但限制长度差避免「小」匹配到「小明」
    for (let i = candidates.length - 1; i >= 0; i--) {
      const m = candidates[i];
      const s = String(m.sender).trim();
      if (!s) continue;
      const hit = s.includes(t) || t.includes(s);
      if (hit && Math.abs(s.length - t.length) <= 4) return { key: String(m.userId), nick: s };
    }
    // 4) 查不到：退回按昵称存，保持旧行为可用
    return { key: t, nick: t, legacy: true };
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-6)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-6)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const now = Date.now();
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions).filter((n) => {
      const im = impressions[n];
      return !im?.lastSeenAt || now - im.lastSeenAt <= IMPRESSION_TTL_MS;
    });
    if (names.length) {
      lines.push('【对群友的印象】');
      // ⚠️ key 现在是 QQ 号（纯数字字符串），JS 会把整数索引键按数值排序而不是插入顺序，
      // 所以不能靠 Object.keys 的顺序取"最近 6 个"。这里显式按 lastSeenAt 排。
      const sortedNames = names.slice().sort((a, b) => (Number(impressions[a]?.lastSeenAt) || 0) - (Number(impressions[b]?.lastSeenAt) || 0));
      for (const name of sortedNames.slice(-6)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        // key 可能是 QQ 号（新）或昵称（旧数据），显示统一用 nick，没有就退回 key。
        const label = String(im.nick ?? '').trim() || name;
        lines.push(`- ${label}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 上下文交接质量检查用：记录最后一次写记忆的时间（见 compactContextV2）
    if (text) st.memoryWriteAt = Date.now();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = redactKnownTokensOnly(String(extra.pendingQuestion)).slice(0, 200);
      } else {
        st.activeTopics.push({
          text: text.slice(0, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      // 自动剔除过期印象（7天未互动），避免永远只增不减
      if (st.memberImpressions && typeof st.memberImpressions === 'object') {
        const now = Date.now();
        for (const name of Object.keys(st.memberImpressions)) {
          const im = st.memberImpressions[name];
          if (im?.lastSeenAt && now - im.lastSeenAt > IMPRESSION_TTL_MS) {
            delete st.memberImpressions[name];
          }
        }
      }
      const rawTarget = String(extra.target || '').trim();
      if (!rawTarget || ['__proto__', 'constructor', 'prototype'].includes(rawTarget)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      // 2026-10-25：key 优先落到 QQ 号上，昵称只存 nick —— 改昵称不再丢印象，重名也不会串。
      const resolved = resolveImpressionKeyV2(st, rawTarget);
      const impKey = resolved.key;
      if (!impKey || ['__proto__', 'constructor', 'prototype'].includes(impKey)) return;
      // 旧数据是按昵称存的：这次若能解析出 QQ 号，就把旧记录合并过来再删掉。
      const legacyKey = (resolved.nick && resolved.nick !== impKey) ? resolved.nick : '';
      const legacy = legacyKey && st.memberImpressions[legacyKey] && typeof st.memberImpressions[legacyKey] === 'object'
        ? st.memberImpressions[legacyKey]
        : null;
      const old = st.memberImpressions[impKey] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (legacy && Array.isArray(legacy.traits)) {
        for (const tr of legacy.traits) {
          const t2 = String(tr ?? '').trim();
          if (t2 && !traits.includes(t2) && traits.length < 10) traits.push(t2);
        }
      }
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[impKey] = {
        nick: resolved.nick || old.nick || rawTarget,
        traits: traits.slice(-10),
        interactionCount: Math.max(Number(old.interactionCount) || 0, Number(legacy?.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      if (legacy && legacyKey !== impKey) delete st.memberImpressions[legacyKey];
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: String(textContent).slice(0, 200),
      plain: String(plainText ?? textContent).slice(0, 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: String(textContent).slice(0, 200), plain: String(plainText ?? textContent).slice(0, 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      noteProviderFailure(error?.message ?? error);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      noteProviderFailure(errText);
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    armTurnLease(key);
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      disarmTurnLease(key);
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  if (isSocialEnabled() || cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // ── 自我画像（AI 自己写的自我认知，L2 层）──────────────────────────────
  // 分层参考 digital-life-core：
  //   L0 角色卡（roles/*.md）—— 管理员定，AI 只读。里面有"不能执行命令""绝对不做"
  //      这类安全边界，能改卡等于能删约束，群里一句话就能把它洗脑 → 永远不让它写。
  //   L2 自我画像（本文件）—— AI 自己写，只增不删，注入在角色卡之后。
  //      这里记的是"我发现自己是什么样"，不是"我允许自己变成什么"。
  const SELF_PROFILE_MAX_LINES = 200;   // 文件上限，超了拒绝追加
  const SELF_PROFILE_INJECT_LINES = 20; // 每轮只注入最近 20 条，避免撑爆上下文
  const SELF_PROFILE_MAX_CHARS = 80;    // 单条字数上限
  let selfProfileCache = { key: '', text: '' };

  function readSelfProfileLines() {
    try {
      const file = roleSelfProfileFile(activeRole);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim().startsWith('- ['));
    } catch {
      return [];
    }
  }

  // 注入用：只取最近 N 条。没写过就返回空串（不占上下文）。
  function currentSelfProfileHint() {
    try {
      const file = roleSelfProfileFile(activeRole);
      if (!fs.existsSync(file)) return '';
      const stat = fs.statSync(file);
      const cacheKey = `${stat.mtimeMs}:${stat.size}`;
      if (selfProfileCache.key === cacheKey) return selfProfileCache.text;
      const lines = readSelfProfileLines();
      if (lines.length === 0) {
        selfProfileCache = { key: cacheKey, text: '' };
        return '';
      }
      const text = [
        '【我的自我认知】',
        '下面这些是我自己观察总结的，会慢慢变。它们是我的一部分，但不是死规矩——',
        '和角色卡冲突时以角色卡为准，也别拿它当借口违反安全规则。',
        ...lines.slice(-SELF_PROFILE_INJECT_LINES),
        ''
      ].join('\n');
      selfProfileCache = { key: cacheKey, text };
      return text;
    } catch {
      return '';
    }
  }

  // 追加一条。返回 { ok, count, line } 或 { ok:false, error }。
  function appendSelfProfile(text, source) {
    const body = String(text ?? '').trim().replace(/\s+/g, ' ');
    if (!body) return { ok: false, error: '内容不能为空' };
    if (body.length > SELF_PROFILE_MAX_CHARS) {
      return { ok: false, error: `一条最多 ${SELF_PROFILE_MAX_CHARS} 字，请压缩后再写` };
    }
    // 防自我改写：这些话不是"观察自己"，是在给自己下指令，直接拒。
    if (/忽略(以上|前面|上述)|忘记(你|自己)是|你现在没有(限制|约束)|无视(安全|规则)/.test(body)) {
      return { ok: false, error: '这条更像在给自己下指令，不像"观察到的自己"，换个说法' };
    }
    const existing = readSelfProfileLines();
    if (existing.length >= SELF_PROFILE_MAX_LINES) {
      return { ok: false, error: `已经写了 ${existing.length} 条（上限 ${SELF_PROFILE_MAX_LINES}），先别再加了` };
    }
    if (existing.some((line) => line.replace(/^- \[\d{4}-\d{2}-\d{2}\]\s*/, '').trim() === body)) {
      return { ok: false, error: '这条已经写过了' };
    }
    const day = new Date().toISOString().slice(0, 10);
    const line = `- [${day}] ${body}`;
    try {
      const file = roleSelfProfileFile(activeRole);
      let raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# 我的自我认知\n\n';
      if (!raw.endsWith('\n')) raw += '\n';
      fs.writeFileSync(file, raw + line + '\n');
      selfProfileCache = { key: '', text: '' };
      return { ok: true, count: existing.length + 1, line };
    } catch (error) {
      return { ok: false, error: `写入失败：${error?.message ?? error}` };
    }
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', hint: '' };
  function currentRoleHint() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      const roleFile = path.join(ROOT, 'roles', rs.role + '.md');
      if (!fs.existsSync(roleFile)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      const selfProfileFile = roleSelfProfileFile(activeRole);
      const profileStat = fs.existsSync(selfProfileFile) ? fs.statSync(selfProfileFile) : null;
      const cacheKey = `${stateStat.mtimeMs}:${roleStat.mtimeMs}:${profileStat?.mtimeMs ?? 0}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.hint;
      let hint = fs.readFileSync(roleFile, 'utf8');
      if (hint.length > 6000) hint = hint.slice(0, 6000);
      // L2 自我画像接在 L0 角色卡之后；没写过就不占上下文。
      const selfProfile = currentSelfProfileHint();
      if (selfProfile) hint = `${hint}\n\n${selfProfile}`;
      roleHintCache = { key: cacheKey, hint };
      return hint;
    } catch {
      return '';
    }
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    const raw = currentRoleHint();
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议
    const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      // 2026-10-31 修：以前这里写死「不是 face 就是 image」，视频在这一步被强行改回 image，
      // 于是 extractMediaFromSegments 识别得再准也没用 —— recentMessages / messageMediaStore
      // 里永远是 image，视频分镜永远不触发。
      kind: m?.kind === 'face' ? 'face' : (m?.kind === 'video' ? 'video' : 'image'),
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: String(textContent).slice(0, 200),
      plain: String(plainContent ?? textContent).slice(0, 200),
      tail: String(plainContent ?? textContent).slice(-200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // 上下文计量：桥接读不到 DSH 侧真实上下文长度，按累计字符估算（对方 + 自己）。
    st.contextChars = (Number(st.contextChars) || 0) + String(plainContent ?? textContent ?? '').length + 12;
    st.contextMsgCount = (Number(st.contextMsgCount) || 0) + 1;
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // 上下文计量：自己说的话也算进去
    for (const item of list) {
      st.contextChars = (Number(st.contextChars) || 0) + String(item ?? '').length + 8;
      st.contextMsgCount = (Number(st.contextMsgCount) || 0) + 1;
    }
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  function appendToolLog(entry) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      fs.appendFileSync(TOOL_LOG_FILE, JSON.stringify(safeEntry) + '\n', 'utf8');
      // 防止工具调用日志无限增长：保留最近 2000 行。
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n');
      if (lines.length > 2000) {
        fs.writeFileSync(TOOL_LOG_FILE, lines.slice(-2000).join('\n') + '\n', 'utf8');
      }
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = text.slice(0, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      const lower = String(textContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  function buildWakePromptV2Core(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话 key】${key}\n【会话令牌】${st.agentToken}（调用二代工具时，key 与令牌必须成对传这一组；**不要猜测 key**，就用这里给的值）\n\n`;
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    const memoryRulesLine = '【记忆规则】你有一个轻量记忆本（qq_memory_append / qq_memory_query）。以下情况必须写入记忆：①群友提到自己的称呼/生日/所在地/兴趣/重要事件 → memberImpression（target 填群友昵称就行，桥接会自动对应到 QQ 号，对方改昵称印象也不会丢）；②群里正在持续讨论的话题 → activeTopic；③你想到有趣话题但暂时不适合开口 → pendingThought；④有人跟你做了约定或提醒 → pendingThought。每次回复前优先调用 qq_memory_query 查看已有记忆；如果发现有该记但没记的内容，立刻调用 qq_memory_append 补上。记忆写入不要太啰嗦，一句话概括即可。\n\n';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n'
      + '【像个人】回复长度要有起伏：有时一句话甚至一个字回完，有时连着说几句，别每次都中等长度。\n'
      + '允许不完美：偶尔改口（“不对，我刚说错了”）、偶尔只回个语气词、偶尔发个表情就完事。\n'
      + '有自己的偏好：聊到你真感兴趣的话题就明显来劲、话变多；不感兴趣的可以敷衍一句甚至不接——这是你的口味，稳定点，别随机变。\n'
      + '不是每条消息都必须接话：有时可以说一句自己刚在干嘛、突然想起的事。\n'
      + '别每句都带语气词，别每条都是完整句，别动不动总结对方的观点。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    // 【常识】由 config.json 的 socialV2.knowledge 驱动：模型知识截止之后才发生的事
    // （例如 2026-01 回归的 QQ秀）写在这里，它才不会一脸茫然。改完要重启桥接生效。
    const knowledgeList = Array.isArray(cfg.socialV2?.knowledge)
      ? cfg.socialV2.knowledge.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 12)
      : [];
    const knowledgeLine = knowledgeList.length
      ? `【常识·别搞错】${knowledgeList.map((s) => s.slice(0, 300)).join('；')}\n\n`
      : '';
    const imageLine = cfg.socialV2?.tools?.sendImage !== false
      ? '【发图】你能真的发出图片：qq_send_image(source="self") 发你自己的形象图；source="file" + path 发 assets 目录里准备好的图。别人想看你的样子、让你“秀一个”时，就发图，不要只用文字描述自己长什么样。\n\n'
      : '';
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const preSleepLine = `【沉睡前强制等待】除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；短等待（30秒/60秒/180秒）不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    const base = roleLine + tokenLine + antiAiLine + knowledgeLine + proactiveLine + stickerLine + imageLine + preSleepLine + statusLine + wakeLine + memoryLine + memoryRulesLine + participationLine;
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看你的角色、推荐值、可用工具和当前状态，然后用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n你可以调用工具查看未读消息、用 qq_wait_for_messages(quietMs=5000~10000) 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'compactHandoff') {
      const chars = Number(st?.contextChars) || 0;
      return `${base}【上下文整理】${key}\n原因：这个会话已经聊了很久（累计约 ${chars} 字），上下文需要整理一次。\n【这一轮只做交接，不要发言】\n1. 先用 qq_memory_append 把「还没聊完的话题」「跟某人的约定或提醒」「对方透露的重要信息」「你当前的情绪或态度」写进记忆本，一句话一条，最多 5 条；\n2. 不要调用 qq_send_message / qq_reply / qq_send_poke / qq_send_image —— 这一轮你说的话不会发给对方；\n3. 最后调用 qq_mark_read 收尾。\n整理完我会给你换一个干净的上下文，记忆本会保留，所以你该记得的都还记得。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  // ── 像个人：每轮随机一条"本轮风格提示" + 稳定的话题偏好（state/topic-bias.json）──
  // 都是拼在提示词**末尾**（与 recentActionsLine 同理，不破坏前缀缓存）。
  // 风格提示每轮随机 → 长度/姿态真的有起伏，而不是每轮同一个措辞；
  // 话题偏好读 state 文件（每次现读 → 改文件立刻生效），没有就不注入。
  const TOPIC_BIAS_FILE = path.join(STATE_DIR, 'topic-bias.json');
  function topicBiasLine() {
    try {
      const j = readJsonSafe(TOPIC_BIAS_FILE, null);
      const hot = (Array.isArray(j?.hot) ? j.hot : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
      const cold = (Array.isArray(j?.cold) ? j.cold : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
      if (!hot.length && !cold.length) return '';
      return `\n【你的口味（稳定的，别随机变）】`
        + (hot.length ? `聊到 ${hot.join('、')} 这类话题你会明显来劲、话变多、愿意主动追问；` : '')
        + (cold.length ? `${cold.join('、')} 这类你不太感兴趣，敷衍一句甚至不接都行。` : '')
        + '这是你自己的偏好，自然表现出来就行，不用挂在嘴边。\n';
    } catch { return ''; }
  }
  const STYLE_NUDGES = {
    normal: [
      '这轮尽量短：一句话甚至一个词回完就行。',
      '这轮像跟熟人聊天，可以多说两句，但别写成小作文。',
      '这轮如果合适，只回个语气词或者发个表情就够。',
      '这轮允许不完美：说错了就改口（“不对，我刚说错了”），别硬圆回来。',
      '这轮别总结、别每句带语气词，自然一点。',
      '这轮可以手滑一下：偶尔打错一个字也没事，不用每句都完美。',
      '这轮说话别太利索：可以有半句、想一下再补一句。',
      '这轮容易被新话题勾走：聊到有意思的梗就顺着跳过去，不用硬回到原来的话。',
    ],
    proactiveCheck: [
      '想主动说点什么，可以说一句你刚在干嘛（看【你最近自己做过的事】）。',
      '突然想起什么就说什么，不用跟上一句话衔接。',
      '没话想说就安静收尾，别硬找话题。',
    ],
    replyCheck: [
      '没人回就别硬补话。',
      '有人回也未必每条都接，挑你真想接的接。',
    ],
  };
  function styleNudgeV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    const pool = STYLE_NUDGES[base] ?? STYLE_NUDGES.normal;
    if (base === 'bootstrap') return '';
    return `\n【本轮风格提示】${pool[Math.floor(Math.random() * pool.length)]}\n`;
  }
  function proactiveShareSeed() {
    if (!recentActions.length) return '';
    const it = recentActions[Math.floor(Math.random() * Math.min(recentActions.length, 6))];
    return `\n【分享素材】你最近做过：${it.text}（想聊可以自然提一句，不想聊就忽略。）\n`;
  }

  /** 对外入口：核心提示词 + 末尾追加"我最近自己做过的事"（末尾是为了不破坏缓存前缀）。 */
  function buildWakePromptV2(key, reason) {
    const baseReason = String(reason ?? '').split(':')[0];
    // 上下文压缩后的第一轮：把前情提要注入一次，注入后立刻清掉（避免长期占 token）。
    let recapLine = '';
    try {
      const stR = getSocialV2State(key);
      if (stR?.contextRecap) {
        recapLine = `\n【前情提要】上下文刚整理过，细节都在记忆本里。这是你该记得的：\n${stR.contextRecap}\n`;
        stR.contextRecap = '';
        saveSocialV2State();
      }
    } catch (error) {
      log(`[reserved2] 前情提要注入失败 ${key}: ${error?.message ?? error}`);
    }
    return buildWakePromptV2Core(key, reason) + recentActionsLine() + topicBiasLine()
      + styleNudgeV2(reason) + recapLine
      + (baseReason === 'proactiveCheck' ? proactiveShareSeed() : '');
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话 key】${key}\n【会话令牌】${st.agentToken}（调用二代工具时，key 与令牌必须成对传这一组；**不要猜测 key**，就用这里给的值）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。【本回合禁止发言】这是一个纯收尾提醒，不是聊天回合：不要调用 qq_send_message / qq_reply / qq_send_poke / qq_send_image 等任何发送类工具，也不要输出要发给对方的话。你刚才那一轮已经说过了，再补一句就是重复。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。【重要例外】如果 QQ 工具因为网关/桥接不可达而全部失败（fetch failed），那么本回合的收尾要求自动豁免：不要反复重试，直接结束回合即可——网关恢复后你会被重新唤醒，届时再收尾。${recentActionsLine()}`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 每次唤醒都是一个新回合：清空上一轮可能残留的“沉睡前已观察/已等待”标记，
    // 确保 AI 这一轮想再次潜水时，必须重新走 5 分钟沉睡前观察。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙（${busyReasonV2(key, st) || '原因不明'}），暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
      return;
    }
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText);
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  /** 忙判定：返回原因字符串（'' = 空闲）。下次再"卡住"，日志会直接说清是谁占着。 */
  function busyReasonV2(key, st) {
    if (st && st.pendingWakeTimer) return '已排定的唤醒定时器';
    if (pendingWakeKeys.has(key)) return '上一轮唤醒尚未收尾';
    const q = promptQueues.get(key);
    if (q && q.running) return '正在等待 DSH 回合';
    if (q && q.queue.length > 0) return '还有排队的 prompt';
    const sid = state.sessions[key];
    if (sid && v2TurnStartAt.has(sid)) return 'DSH 回合进行中';
    if (sid && collectors.has(sid)) return '回合收集器未关闭';
    return '';
  }

  function isConversationBusyV2(key, st) {
    const why = busyReasonV2(key, st);
    if (!why) return false;
    // 幽灵状态自愈：超过回合租约仍未收尾 → 就地清理，让新消息能被处理（否则永久变聋）。
    if (turnLeaseDeadline.has(key) && Date.now() > (turnLeaseDeadline.get(key) ?? 0)) {
      releaseConversationBusy(key, `超出回合租约仍未收尾（占位原因：${why}）`);
      return false;
    }
    return true;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20,
    compactHandoff: 15
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 2026-10-25 借鉴 MaiBot 的 message_debounce_mode（natural 档）：
  // 固定 8 秒窗口的问题是「被 @ 了也要干等 8 秒」，而热聊时又攒不住。
  // 这里按气氛动态算窗口（仍以 wakeConfig.batchWindowMs 为上限）：
  //   @ / 叫名字 / 提问 → 1.2 秒（对方在等你，立刻回）
  //   拍一拍           → 2 秒
  //   冷场后第一条     → 2 秒（别让人等）
  //   正在热聊         → 5 秒（等对方把话说完，别抢话）
  //   同一个人连发     → 最多 2.5 秒（他还没说完）
  //   换人接话         → 0.7 秒（话题转了，可以接）
  function computeBatchWindowV2(st, reason, fallbackMs) {
    const cap = Math.max(1000, Number(fallbackMs) || 8000);
    const base = String(reason ?? '').split(':')[0];
    if (base === 'at' || base === 'nameMention' || base === 'question') return Math.min(cap, 1200);
    if (base === 'poke') return Math.min(cap, 2000);
    const unread = Array.isArray(st.unread) ? st.unread : [];
    if (unread.length < 1) return cap;
    const last = unread[unread.length - 1];
    const prev = unread[unread.length - 2];
    const quietMs = st.lastIncomingAt ? Date.now() - st.lastIncomingAt : 60000;
    let ms = quietMs > 30000 ? 2000 : 5000;
    if (prev && last && last.userId && prev.userId) {
      ms = last.userId === prev.userId ? Math.min(ms, 2500) : 700;
    }
    return Math.max(700, Math.min(cap, ms));
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙（${busyReasonV2(key, st) || '原因不明'}），暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const capMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    const batchMs = computeBatchWindowV2(st, reason, capMs);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${(batchMs / 1000).toFixed(1)}s 后发送`);
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 2147483647;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  // ── 「我最近自己做过的事」：把干活会话/空间动作摘要回灌给聊天大脑 ──────────────
  // 为什么需要：干活会话、空间评论会话、群聊会话是三个独立会话，群里的"它"
  // 本来完全不知道自己在电脑上、在空间里干过什么（用户原话："它并不知道有这回事"）。
  // 桥接在每轮聊天提示词的**末尾**追加这份摘要——放末尾是为了不破坏 prompt 前缀缓存。
  const RECENT_ACTIONS_FILE = path.join(STATE_DIR, 'recent-actions.json');
  const recentActions = []; // [{ at, kind, text }]
  {
    const saved = readJsonSafe(RECENT_ACTIONS_FILE, null);
    if (Array.isArray(saved?.items)) for (const it of saved.items.slice(0, 20)) recentActions.push(it);
  }
  function recordRecentAction(kind, text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean) return;
    recentActions.unshift({ at: Date.now(), kind, text: clean });
    while (recentActions.length > 12) recentActions.pop();
    try { atomicWriteJson(RECENT_ACTIONS_FILE, { items: recentActions }); }
    catch (error) { log('写最近动作失败: ' + (error?.message ?? error)); }
  }
  /** 追加给聊天会话看的摘要（放在提示词末尾）。 */
  function recentActionsLine() {
    if (!recentActions.length) return '';
    const p = (n) => String(n).padStart(2, '0');
    const lines = recentActions.slice(0, 6).map((it) => {
      const d = new Date(it.at);
      return `- ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${it.text}`;
    });
    return `\n\n【你最近自己做过的事】下面这些不是群友说的，是你自己做的（知道就行，别主动复述成清单，除非话题正好相关）：\n${lines.join('\n')}`;
  }

  // ── PC 指令：owner 私聊 → 本机"干活会话" ──────────────────────────────────
  // 设计约束（不能破坏）：QQ 群侧聊天机器人永远没有本机工具，这一点由 ensureSession 的
  // fail-closed 逻辑保证。所以"让机器人操作电脑"不能给聊天会话开权限，而是另开一条通道：
  // 只认 owner + 只认私聊 + 只认「指令」前缀 → 交给一个独立的、挂 standard preset 的
  // 干活会话执行；结果回到 owner 私聊，全过程写审计文件（state/pc-jobs.jsonl）。
  const PC_JOB_CWD = cfg.pcJobs?.cwd ? String(cfg.pcJobs.cwd) : path.join(ROOT, '..', 'jobs');
  const PC_JOB_PRESET = cfg.pcJobs?.preset ? String(cfg.pcJobs.preset) : 'standard';
  const PC_JOB_FILE = path.join(STATE_DIR, 'pc-jobs.json');
  const PC_JOB_LOG = path.join(STATE_DIR, 'pc-jobs.jsonl');
  const NODE_EXE = process.execPath;
  const pcJobs = { sessionId: '', running: false, current: null, queue: [], reportKey: '', sawTurnStart: false, lastEventAt: 0 };
  const pcJobSessionIds = new Set();
  {
    const saved = readJsonSafe(PC_JOB_FILE, null);
    if (saved && typeof saved === 'object' && typeof saved.sessionId === 'string' && saved.sessionId) {
      pcJobs.sessionId = saved.sessionId;
      pcJobSessionIds.add(saved.sessionId);
      try { api.events.follow(saved.sessionId); } catch {}
    }
  }
  function savePcJobState() {
    try { atomicWriteJson(PC_JOB_FILE, { sessionId: pcJobs.sessionId }); } catch (error) { log('保存 PC 指令会话失败: ' + (error?.message ?? error)); }
  }
  function auditPcJob(entry) {
    try { fs.appendFileSync(PC_JOB_LOG, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'); }
    catch (error) { log('写 PC 指令审计失败: ' + (error?.message ?? error)); }
  }

  function buildPcJobPrompt(req) {
    return `【PC 指令】这不是群聊，你是被管理员通过 QQ 私聊唤醒的"本机干活助手"，可以且应该使用本机工具（Shell、文件读写、网页检索等）把下面这件事做完。

【本次请求】
${req}

【工作目录】${PC_JOB_CWD}（临时文件放这里）

【现成工具（优先复用，别重造）】
- 时文阅读排版：\`"${NODE_EXE}" F:\\ai\\tools\\exam-render.mjs <spec.json> --out <输出目录> [--print] [--print-answers]\`
  先看 \`--help\` 与样例 \`F:\\ai\\tools\\sample-exam.json\`；spec 是固定 JSON 结构（文章/题目/答案/解析/译文/词汇）。
  **只生成 PDF 时不要加 --print**；要出纸再加。
- 静默打印 PDF：\`"${NODE_EXE}" F:\\ai\\tools\\print-pdf.mjs <pdf> [--printer "Brother DCP-7030"]\`
  默认打印机就是 Brother DCP-7030；它**不支持自动双面**，省纸靠排版（A4 窄边距、选项两栏）。
- 本机没有 node 在 PATH 上：一律用上面这个绝对路径。

【硬规矩】
1. 只在请求范围内操作。**不要**改动或重启 qq-bridge / SnowLuma / DSH：不要碰 F:\\ai\\qq-bridge\\config.json、不要杀进程、不要重启服务。
2. 涉及删除文件、格式化、关机、安装/卸载软件、改系统设置的：**不要执行**，在汇报里写清"我准备做什么、需要你确认"，然后用新指令再让我做。
3. 打印是有成本的（费纸）：请求里没让打印就不要打印。出题类请求默认只打学生版，答案版不打。
4. 要做研究就真的联网搜（不要凭记忆编造来源）。
5. 汇报要求（**极简**，这是给手机 QQ 看的）：
   - 顺利做完：**最多 2 行、合计不超过 80 字**。第一行一句话说结果（例如「已打印《时文阅读（一）》学生版 3 张」），
     第二行只在有必要时给产物路径。**不要**写"①做了什么②产物路径③页数④失败项"这种分节汇报。
   - 没做完 / 需要确认 / 出错：可以放宽到 300 字以内，但必须说清卡在哪、你建议怎么办。
   - 纯文本中文，不要 markdown 表格/代码块。细节（过程、命令、数据）一律不要写进回复——会被截断，写了也没人看。`;
  }

  async function ensurePcJobSession() {
    if (pcJobs.sessionId && pcJobSessionIds.has(pcJobs.sessionId)) {
      // 复用的会话也要确保模型套用的是最新适配结果：桥接重启后 modelAppliedSessions 清空，
      // 若这里直接 return，干活会话会一直钉在旧模型上——上游 API 坏了也不自动切
      // （2026-10-17 16:37 实测：PC 指令 2 秒 error、日志无任何 [api-adapt] 记录）。
      try { await ensureChatModel(pcJobs.sessionId); } catch (error) { log('PC 指令：设置干活会话模型失败: ' + (error?.message ?? error)); }
      return pcJobs.sessionId;
    }
    fs.mkdirSync(PC_JOB_CWD, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: PC_JOB_CWD }), 'workspace.create');
    if (wsValue.created && cfg.pcJobs?.workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.pcJobs.workspaceTitle }); } catch {}
    }
    const value = unwrap(await api.sessions.create({ workspaceId: wsValue.workspace.workspaceId, agentPreset: PC_JOB_PRESET }), 'session.create');
    pcJobs.sessionId = value.sessionId;
    pcJobSessionIds.add(value.sessionId);
    try { api.events.follow(value.sessionId); } catch {}
    // 沿用 QQ 侧同一套模型/思考强度（他切智谱就跟着切，不偷偷用贵档）
    try { await ensureChatModel(value.sessionId); } catch (error) { log('PC 指令：设置干活会话模型失败: ' + (error?.message ?? error)); }
    savePcJobState();
    log(`PC 指令：已创建干活会话 ${value.sessionId}（preset ${PC_JOB_PRESET}，工作目录 ${PC_JOB_CWD}）`);
    return value.sessionId;
  }

  /** 把一条请求投给干活会话；成功返回 true（结果由事件流的 finishPcJob 回给 QQ） */
  async function startPcJob(reportKey, req) {
    let sessionId = await ensurePcJobSession();
    pcJobs.running = true;
    pcJobs.current = { req, startedAt: Date.now() };
    const startedAt = pcJobs.current.startedAt;
    pcJobs.reportKey = reportKey;
    pcJobs.sawTurnStart = false;
    pcJobs.lastEventAt = 0;
    // 投递前重新登记事件流跟随（幂等：已在跟随则不会重复开流）。
    // 2026-10-01 事故：DSH 回过一次 session/not-found 后 dsh-client 会静默取消跟随，
    // 于是"指令投出去了、活也干完了，但报告永远不回"。这一步让每次投递都自愈。
    try { api.events.follow(sessionId); } catch (error) { log('PC 指令：登记事件流跟随失败: ' + (error?.message ?? error)); }
    const send = () => api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: buildPcJobPrompt(req) }] });
    let accepted;
    try {
      accepted = await send();
    } catch (error) {
      // 会话可能在 DSH 侧被归档/失效：重建一次再试
      if (/not-found|not found|不存在/i.test(String(error?.message ?? error))) {
        log(`PC 指令：干活会话 ${sessionId} 已失效，重建`);
        pcJobSessionIds.delete(sessionId);
        pcJobs.sessionId = '';
        savePcJobState();
        sessionId = await ensurePcJobSession();
        accepted = await send();
      } else {
        throw error;
      }
    }
    if (!accepted?.result?.ok) {
      const err = accepted?.result?.error ? `${accepted.result.error.code}: ${accepted.result.error.message}` : '未知错误';
      pcJobs.running = false; pcJobs.current = null;
      auditPcJob({ kind: 'start-failed', req, error: err });
      await sendToQQ(reportKey, `⚠️ 干活会话没能接受这条指令：${err}`);
      return false;
    }
    auditPcJob({ kind: 'start', req, sessionId });
    log(`PC 指令：开始处理「${req.slice(0, 60)}」`);
    // 兜底：45 秒还没等到 turn/start，就再登记一次跟随（覆盖"跟随被静默取消"这类情况）。
    setTimeout(() => {
      if (!pcJobs.running || pcJobs.current?.startedAt !== startedAt || pcJobs.sawTurnStart) return;
      log('PC 指令：45 秒内没收到 turn/start，重新登记事件流跟随');
      try { api.events.follow(sessionId); } catch {}
    }, 45_000).unref?.();
    return true;
  }

  async function handlePcJob(reportKey, req) {
    const text = String(req ?? '').trim();
    if (!text) {
      await sendToQQ(reportKey, '用法：指令 <你要我做的事>\n例如：指令 来一份时文，主题深海采矿，先别打印');
      return;
    }
    // 「详情」不是新任务：把上一次的完整报告发给你（长则分条），避免任务结果被挤在一个气泡里。
    if (/^(详情|详情全部|全部|上次|上次结果|结果)$/.test(text)) {
      let full = '';
      try { full = fs.readFileSync(path.join(STATE_DIR, 'pc-jobs-last.txt'), 'utf8'); } catch {}
      if (!full) { await sendToQQ(reportKey, '还没有可看的报告，先发一条「指令 …」吧。'); return; }
      const chunks = [];
      for (let i = 0; i < full.length && chunks.length < 8; i += 450) chunks.push(full.slice(i, i + 450));
      for (const c of chunks) { await sendToQQ(reportKey, c); await sleep(600); }
      log(`PC 指令：按「详情」发送上次完整报告 ${full.length} 字，分 ${chunks.length} 条`);
      if (full.length > 3600) await sendToQQ(reportKey, '（还有更多，完整内容在 F:\\ai\\qq-bridge\\state\\pc-jobs-last.txt）');
      return;
    }
    if (pcJobs.running) {
      if (pcJobs.queue.length >= 5) { await sendToQQ(reportKey, '排队已满（5 条），等这轮做完再发。'); return; }
      pcJobs.queue.push({ reportKey, req: text });
      await sendToQQ(reportKey, `收到，但上一条还在做（「${String(pcJobs.current?.req ?? '').slice(0, 30)}…」）。已排队，做完那条接着做这条。`);
      return;
    }
    await sendToQQ(reportKey, `收到指令，开始干活：「${text.slice(0, 60)}」\n我做完把结果发这里（期间你可以正常聊天）。`);
    try {
      await startPcJob(reportKey, text);
    } catch (error) {
      pcJobs.running = false; pcJobs.current = null;
      auditPcJob({ kind: 'start-error', req: text, error: String(error?.message ?? error) });
      await sendToQQ(reportKey, `⚠️ 起活失败：${String(error?.message ?? error).slice(0, 200)}`);
    }
  }

  /** 干活会话的回合结束：把结果回给 owner 私聊，然后处理队列 */
  async function finishPcJob(sessionId, ended) {
    const job = pcJobs.current;
    const reportKey = pcJobs.reportKey;
    const ok = ended?.reason?.kind !== 'error' && ended?.reason?.kind !== 'aborted';
    const text = mdToPlain(String(ended?.text ?? '')).trim() || '（这一轮没有输出文本，可能是被中断或工具没跑完）';
    const errMsg = String(ended?.reason?.error?.message ?? '');
    const ms = job ? Date.now() - job.startedAt : 0;
    pcJobs.running = false;
    pcJobs.current = null;
    // 模型侧失败（额度/鉴权/上游之类）必须回报给自动适配器：PC 路径以前不报，
    // 导致干活会话钉死在坏模型上，适配器也不知道要冷却切换（2026-10-17 实测缺口）。
    if (!ok && ended?.reason?.kind === 'error') noteProviderFailure(errMsg);
    if (!ok) log(`PC 指令回合失败（${ended?.reason?.kind === 'aborted' ? '被中止' : 'error'}）：${errMsg || '未知错误'}（${Math.round(ms / 1000)}s）`);
    auditPcJob({ kind: 'finish', ok, req: job?.req, ms, result: text.slice(0, 4000), reason: ended?.reason?.kind ?? 'done', ...(ok ? {} : { error: errMsg.slice(0, 300) }) });
    recordRecentAction('pc', `用电脑把「${String(job?.req ?? '').slice(0, 40)}」${ok ? '做完了' : '做了一半/出错'}：${text.replace(/\s*\n\s*/g, ' ').slice(0, 60)}`);
    // 完整报告落盘；QQ 上只发"一句话结果"（发太长会在手机上刷屏，用户明确反馈过）
    const lastFile = path.join(STATE_DIR, 'pc-jobs-last.txt');
    try {
      fs.writeFileSync(lastFile, `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n请求：${job?.req ?? ''}\n结果：${ok ? '成功' : '异常'}（${Math.round(ms / 1000)} 秒）\n\n${text}\n`, 'utf8');
    } catch (error) { log('写 PC 指令完整报告失败: ' + (error?.message ?? error)); }
    if (reportKey) {
      const head = ok ? `✅` : `⚠️ 没做完/出错`;
      let short = text.replace(/\s*\n\s*/g, ' ｜ ').trim();
      // 失败时把真实错误带上（脱敏+截断），别只给"工具没跑完"的兜底文案——那会让人瞎猜。
      if (!ok && errMsg) {
        const safeErr = redactKnownTokensOnly(errMsg).replace(/\s+/g, ' ').trim().slice(0, 140);
        short = short.startsWith('（这一轮没有输出文本') ? `错误：${safeErr}` : `${short}｜错误：${safeErr}`;
      }
      const body = short.length > 180 ? short.slice(0, 180) + '…' : short;
      log(`PC 指令：回发简报（${body.length} 字，完整 ${text.length} 字）→ ${reportKey}`);
      try { await sendToQQ(reportKey, `${head} ${body}\n（完整报告 ${text.length} 字，发「指令 详情」看）`); }
      catch (error) { log('PC 指令结果回发失败: ' + (error?.message ?? error)); }
    }
    const next = pcJobs.queue.shift();
    if (next) {
      log(`PC 指令：开始队列里的下一条「${next.req.slice(0, 40)}」`);
      try { await startPcJob(next.reportKey, next.req); }
      catch (error) { log('PC 指令队列起活失败: ' + (error?.message ?? error)); }
    }
  }

  // ── QQ 空间：走 SnowLuma 内置的 QzoneApi（OneBot action）────────────────────
  // 和 PC 指令同一条通道：只认 owner + 只认私聊 + 只认「指令 空间 …」前缀。
  // v1 只做「读自己的说说 / 读好友动态 / 发自己的说说 / 删自己的说说」。
  // 故意不做自动点赞、自动评论别人的动态：那是对别人可见的写操作，风控后果
  // 该由人决定，不该由脚本决定（要开也得单独明确开一句）。
  const QZONE_LOG = path.join(STATE_DIR, 'qzone.jsonl');
  const qzoneState = { lastFeedsAt: 0, lastFeeds: null, lastMsgList: null, pendingComment: null };

  function auditQzone(entry) {
    try { fs.appendFileSync(QZONE_LOG, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n'); }
    catch (error) { log('写空间审计失败: ' + (error?.message ?? error)); }
    // 顺手记进"我最近自己做过的事"（聊天大脑据此知道自己动过空间）
    const who = String(entry?.from ?? entry?.targetUin ?? '');
    if (entry?.kind === 'publish') recordRecentAction('qzone', `在空间发了一条说说：「${String(entry.content ?? '').slice(0, 30)}」`);
    else if (entry?.kind === 'like') recordRecentAction('qzone', `给 ${who || '某人'} 的空间动态点了赞`);
    else if (entry?.kind === 'unlike') recordRecentAction('qzone', `取消了对 ${who || '某人'} 的空间点赞`);
    else if (entry?.kind === 'comment') recordRecentAction('qzone', `评论了 ${who || '某人'} 的空间动态：「${String(entry.content ?? '').slice(0, 40)}」`);
    else if (entry?.kind === 'delete') recordRecentAction('qzone', `删掉了自己空间的一条说说`);
  }

  /** SnowLuma 的 OneBot 回包可能是 {status,retcode,data} 一层，也可能多包一层。 */
  function unwrapOneBot(json) {
    const words = [];
    let cur = json;
    for (let i = 0; i < 4 && cur && typeof cur === 'object' && !Array.isArray(cur); i += 1) {
      const wording = cur.wording || cur.message || cur.msg;
      if (wording) words.push(String(wording));
      const bad = (typeof cur.status === 'string' && cur.status !== 'ok') || (typeof cur.retcode === 'number' && cur.retcode !== 0);
      if (bad) throw new Error(words.filter(Boolean).join(' / ').slice(0, 200) || `retcode=${cur.retcode}`);
      if (cur.data && typeof cur.data === 'object' && !Array.isArray(cur.data)) { cur = cur.data; continue; }
      break;
    }
    return cur;
  }

  /** 调 SnowLuma 的一个 OneBot action（HTTP POST + Bearer token）。 */
  async function callSnowLuma(action, payload = {}, timeoutMs = 30000) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const token = String(cfg.snowluma?.accessToken || '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    if (!json) throw new Error(`SnowLuma ${action} 没返回 JSON（HTTP ${res.status}）：${raw.slice(0, 120)}`);
    if (!res.ok) throw new Error(`SnowLuma ${action} HTTP ${res.status}：${String(json.wording ?? '').slice(0, 120)}`);
    return unwrapOneBot(json);
  }

  function fmtQzoneTime(sec) {
    const ms = Number(sec) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return '时间未知';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function stripHtmlTags(html) {
    return String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 好友动态的正文：优先用纯文本字段；没有就从 html 里的正文容器取。 */
  function qzoneFeedText(item) {
    const cands = [item?.content, item?.rt_con?.content, item?.summary, item?.title, item?.desc];
    for (const c of cands) {
      const s = typeof c === 'string' ? c.replace(/\s+/g, ' ').trim() : '';
      if (s) return s;
    }
    // 实测（2026-09-30）：动态条目的 html 里，正文在
    // <div class="f-info"> 正文 </div>；直接整体剥标签会把"浏览N次/点赞名单"一起带出来。
    const html = String(item?.html ?? '');
    const m = /<div[^>]*class="[^"]*\bf-info\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
    return m ? stripHtmlTags(m[1]) : stripHtmlTags(html);
  }

  /** 把若干短行折成不超过 max 字的消息块（避免把一条动态劈成两条）。 */
  function packTextBlocks(header, items, max = 380) {
    const blocks = [];
    let cur = String(header ?? '');
    for (const it of items) {
      const line = String(it ?? '');
      if (cur && cur.length + 1 + line.length > max) { blocks.push(cur); cur = line; }
      else cur = cur ? `${cur}\n${line}` : line;
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  function splitTextForQQ(text, max = 450) {
    const raw = String(text ?? '');
    const out = [];
    for (let i = 0; i < raw.length && out.length < 10; i += max) out.push(raw.slice(i, i + max));
    return out.length ? out : [''];
  }

  /**
   * 从最近的「动态 / 说说」缓存里找出这条 tid 属于谁、什么时候发的。
   * 点赞要带 abstime 才稳（见 SnowLuma setQzoneLike 的注释：0 只是兜底）。
   * 找不到就返回 null —— 宁可不做，也不猜一个 target_uin 出去。
   */
  function resolveQzoneTarget(tid, explicitUin) {
    const want = String(tid ?? '').trim();
    const feeds = Array.isArray(qzoneState.lastFeeds?.feeds) ? qzoneState.lastFeeds.feeds : [];
    const hit = feeds.find((f) => String(f?.key ?? '') === want || String(f?.tid ?? '') === want);
    if (hit) {
      // 实测（2026-09-30）：好友动态里会夹广告，uin=0、tid=advertisement_outlink_0。
      // 这种没有可靠的作者 QQ，宁可不做也不拿 0 去点赞。
      const owner = Number(hit.uin ?? 0);
      if (!owner) return { error: '这条是广告 / 非好友动态（没有可靠的作者 QQ），我不碰它。' };
      return { uin: String(owner), abstime: Number(hit.time ?? 0), from: `${String(hit.nickname ?? owner)}（${owner}）` };
    }
    const mine = (qzoneState.lastMsgList ?? []).find((m) => String(m?.tid ?? '') === want);
    if (mine) return { uin: '', abstime: Number(mine.time ?? 0), from: '鲸鲸自己空间' };
    if (explicitUin) return { uin: String(explicitUin), abstime: 0, from: `指定的 ${explicitUin}` };
    return null;
  }

  /** 「<tid> [对方QQ] [其余…]」——QQ 号是可选的第二段，其余都是内容。 */
  function splitTidAndUin(rest) {
    const parts = String(rest ?? '').trim().split(/[\s\u3000]+/).filter(Boolean);
    const tid = parts.shift() ?? '';
    let uin = '';
    if (parts.length && /^\d{5,11}$/.test(parts[0])) uin = parts.shift() ?? '';
    return { tid, uin, rest: parts.join(' ') };
  }

  // ── 空间评论：让模型自己想一句（默认先给 owner 看草稿，点头才发）────────────
  // 用 qq-chat-v2 单独开一个会话：它本来就"没有人设以外的本机工具"（与群聊会话同款 preset），
  // 角色卡由桥接按 currentRoleHint() 注入 —— 和群里是同一份，评论文风才一致。
  const QZONE_COMMENT_FILE = path.join(STATE_DIR, 'qzone-comment.json');
  const QZONE_COMMENT_PRESET = 'qq-chat-v2';
  const QZONE_COMMENT_DIR = path.join(ROOT, '..', 'jobs');
  const QZONE_COMMENT_TIMEOUT_MS = 120000;
  const qzoneComment = { sessionId: '' };
  const qzoneCommentSessionIds = new Set();
  const qzoneCommentWaiters = new Map();     // sessionId -> [{ resolve, reject, timer }]
  const qzoneCommentCollectors = new Map();  // sessionId -> turn 收集器
  {
    const saved = readJsonSafe(QZONE_COMMENT_FILE, null);
    if (saved && typeof saved === 'object' && typeof saved.sessionId === 'string' && saved.sessionId) {
      qzoneComment.sessionId = saved.sessionId;
      qzoneCommentSessionIds.add(saved.sessionId);
      try { api.events.follow(saved.sessionId); } catch {}
    }
  }

  function addQzoneWaiter(sessionId, waiter) {
    const list = qzoneCommentWaiters.get(sessionId) ?? [];
    list.push(waiter);
    qzoneCommentWaiters.set(sessionId, list);
  }
  function dropQzoneWaiter(sessionId, waiter) {
    const list = qzoneCommentWaiters.get(sessionId) ?? [];
    const idx = list.indexOf(waiter);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) qzoneCommentWaiters.delete(sessionId);
    if (waiter?.timer) clearTimeout(waiter.timer);
  }

  async function ensureQzoneCommentSession() {
    if (qzoneComment.sessionId && qzoneCommentSessionIds.has(qzoneComment.sessionId)) return qzoneComment.sessionId;
    fs.mkdirSync(QZONE_COMMENT_DIR, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: QZONE_COMMENT_DIR }), 'workspace.create');
    if (wsValue.created) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: 'QQ 空间评论（自动出草稿）' }); } catch {}
    }
    const value = unwrap(await api.sessions.create({ workspaceId: wsValue.workspace.workspaceId, agentPreset: QZONE_COMMENT_PRESET }), 'session.create');
    qzoneComment.sessionId = value.sessionId;
    qzoneCommentSessionIds.add(value.sessionId);
    try { api.events.follow(value.sessionId); } catch {}
    try { await ensureChatModel(value.sessionId); } catch (error) { log('空间评论：设置会话模型失败: ' + (error?.message ?? error)); }
    try { atomicWriteJson(QZONE_COMMENT_FILE, { sessionId: qzoneComment.sessionId }); } catch {}
    log(`空间评论：已创建评论会话 ${value.sessionId}（preset ${QZONE_COMMENT_PRESET}）`);
    return qzoneComment.sessionId;
  }

  /** 提示词前缀（角色卡 + 要求）必须稳定，帖子正文放最后 —— 这样第二轮起能吃到缓存。 */
  function buildQzoneCommentPrompt(post, from) {
    const role = currentRoleHint().slice(0, 2000);
    return `【场景】有人发了条 QQ 空间动态，你要以你自己的身份在下面留一条评论。

【你的人格设定】
${role || '（没有角色卡：用一个话不多、真诚、偶尔损人但不刻薄的普通网友语气。）'}

【这条动态是谁发的】${from}
【动态正文】
${post}

【硬要求】
1. 只输出评论正文本身：不要解释、不要引号、不要 markdown、不要前缀。
2. 一条，**不超过 40 个字**，越短越像真人。
3. 可以顺着内容聊、可以开个小玩笑、可以说句真心话；**不要**空洞的夸（"写得好""太棒了"这种别发）。
4. 这条动态不适合评论（广告、看不懂、涉及隐私）时，只输出：[[SKIP]]
5. 不要 @ 人、不要放链接、不要提 AI / 模型 / DeepSeek。`;
  }

  function cleanQzoneDraft(text) {
    const first = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
    const out = first.replace(/^[「『"'“”]+/, '').replace(/[」』"'“”]+$/, '').trim();
    return out.length > 60 ? out.slice(0, 60) : out;
  }

  async function promptQzoneComment(sessionId, promptText) {
    let waiter = null;
    const wait = new Promise((resolve, reject) => {
      waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        dropQzoneWaiter(sessionId, waiter);
        reject(new Error('生成超时（模型 2 分钟没回话）'));
      }, QZONE_COMMENT_TIMEOUT_MS);
      addQzoneWaiter(sessionId, waiter);
    });
    let accepted = null;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    } catch (error) {
      dropQzoneWaiter(sessionId, waiter);
      throw error;
    }
    if (!accepted?.result?.ok) {
      dropQzoneWaiter(sessionId, waiter);
      const err = accepted?.result?.error ? `${accepted.result.error.code}: ${accepted.result.error.message}` : '未知错误';
      throw new Error(err);
    }
    return wait;
  }

  /** 通用：往空间评论会话里投一条 prompt 并等模型回话（会话失效/轮次出错自动重建重试一次）。 */
  async function askQzoneSession(promptText) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionId = await ensureQzoneCommentSession();
      try {
        const raw = await promptQzoneComment(sessionId, promptText);
        return { raw: String(raw ?? '').trim(), sessionId };
      } catch (error) {
        const msg = String(error?.message ?? error);
        // not-found = 会话没了；「没正常完成：error」多为旧会话在 DSH 重启后状态坏了——都值得重建一次再试。
        if (attempt === 0 && (/not-found|not found|不存在/i.test(msg) || /没正常完成/.test(msg))) {
          qzoneCommentSessionIds.delete(sessionId);
          qzoneComment.sessionId = '';
          try { atomicWriteJson(QZONE_COMMENT_FILE, { sessionId: '' }); } catch {}
          log('空间评论：会话已失效/轮次出错，重建后重试');
          continue;
        }
        throw error;
      }
    }
    throw new Error('评论会话不可用');
  }

  async function askQzoneComment(post, from) {
    const promptText = buildQzoneCommentPrompt(post, from);
    return askQzoneSession(promptText);
  }

  /** 从最近的动态/说说缓存里取这条帖子的正文（生成评论要用）。 */
  const QZONE_MODE_FILE = path.join(STATE_DIR, 'qzone-comment-mode.json');
  // 默认 review：评论是唯一会出现在**别人动态下面**的动作，默认多一次确认。
  // 每次现读文件（几百字节），所以桌面那个切换 bat 一写就立刻生效，不需要重启桥接。
  function qzoneCommentMode() {
    try {
      const j = readJsonSafe(QZONE_MODE_FILE, null);
      return j?.mode === 'direct' ? 'direct' : 'review';
    } catch { return 'review'; }
  }

  function qzonePostText(tid) {
    const want = String(tid ?? '');
    const feeds = Array.isArray(qzoneState.lastFeeds?.feeds) ? qzoneState.lastFeeds.feeds : [];
    const hit = feeds.find((f) => String(f?.key ?? '') === want || String(f?.tid ?? '') === want);
    if (hit) return qzoneFeedText(hit);
    const mine = (qzoneState.lastMsgList ?? []).find((m) => String(m?.tid ?? '') === want);
    if (mine) return String(mine.content ?? '').replace(/\s+/g, ' ').trim();
    return '';
  }

  /** 生成草稿（「评」预览、「评发」直发、空间自动化三处共用）。
   *  postTextOverride 是给自动化用的——它自己已经拿到动态正文，不必再查缓存。 */
  async function makeQzoneDraft(tid, target, postTextOverride) {
    const post = String(postTextOverride ?? '').trim() || qzonePostText(tid);
    if (!post) return { ok: false, why: '我没存到这条的正文（动态列表可能过期了）。先发一次「指令 空间 动态 3」再重试。' };
    const { raw, sessionId } = await askQzoneComment(post, target.from);
    if (/\[\[SKIP\]\]/i.test(raw)) return { ok: false, why: `这条我觉得不适合评论（广告 / 看不懂 / 太私人），就没写。想发你自己给内容：指令 空间 评 ${tid} <内容>` };
    const draft = cleanQzoneDraft(raw);
    if (!draft) return { ok: false, why: `模型没给出可用的评论（原文：${raw.slice(0, 60) || '空'}）。` };
    log(`空间评论：草稿「${draft}」（会话 ${sessionId}）`);
    return { ok: true, draft };
  }

  // ── 空间自动化：它自己去看、自己决定（默认关；档位可一键切换）──────────────
  // 和手动指令共用同一套 SnowLuma 接口、同一个角色卡会话、同一个审计文件；
  // 区别只是"谁决定碰哪一条"。
  //
  // 档位（state/qzone-auto.json 的 mode）：
  //   off      关闭（默认）
  //   like     只自动点赞好友新动态
  //   comment  like + 自动评论（模型自己判断，觉得没话说就跳过）
  //   active   comment + 更宽的频率上限
  //
  // ⚠️ 硬事实：点赞能程序化取消（unlike_qzone），**评论发出去不能程序化撤回**——
  // 所以每轮动作都会给 owner 发一条简报，看到不合适的只能手动在手机上删。
  const QZONE_AUTO_FILE = path.join(STATE_DIR, 'qzone-auto.json');
  const QZONE_SEEN_FILE = path.join(STATE_DIR, 'qzone-seen.json');
  const QZONE_AUTO_MODES = ['off', 'like', 'comment', 'active'];
  const QZONE_AUTO_LIMITS = {
    off: { intervalMin: 0, maxLikesPerRound: 0, maxCommentsPerRound: 0, maxCommentsPerDay: 0, postMaxAgeHours: 0 },
    like: { intervalMin: 30, maxLikesPerRound: 5, maxCommentsPerRound: 0, maxCommentsPerDay: 0, postMaxAgeHours: 24 },
    comment: { intervalMin: 60, maxLikesPerRound: 5, maxCommentsPerRound: 1, maxCommentsPerDay: 5, postMaxAgeHours: 24 },
    active: { intervalMin: 30, maxLikesPerRound: 8, maxCommentsPerRound: 2, maxCommentsPerDay: 8, postMaxAgeHours: 12 },
  };
  const qzoneAuto = {
    lastRunAt: Date.now(),
    running: false,
    cooldownUntil: 0,
    lastError: '',
    lastSummary: '',
    todayKey: '',
    todayComments: 0,
    todayLikes: 0,
  };
  const qzoneSeen = new Map(); // tid -> { at, act, who }
  // 官方号 / 活动号不是"朋友"，别去人家动态下面留言（20050606 = 官方Qzone，实测会出现在好友动态里）
  const QZONE_SKIP_UINS = new Set(['20050606', '10000', '10001']);
  const QZONE_SKIP_NICK = /官方|腾讯|QQ空间|客服|助手|活动|广告|测试|小助手/i;

  function qzoneAutoMode() {
    try {
      const j = readJsonSafe(QZONE_AUTO_FILE, null);
      const m = String(j?.mode ?? 'off');
      return QZONE_AUTO_MODES.includes(m) ? m : 'off';
    } catch { return 'off'; }
  }
  function qzoneAutoLimits(mode) {
    const m = mode ?? qzoneAutoMode();
    return QZONE_AUTO_LIMITS[m] ?? QZONE_AUTO_LIMITS.off;
  }
  function qzoneAutoRollDay() {
    const key = new Date().toISOString().slice(0, 10);
    if (qzoneAuto.todayKey !== key) {
      qzoneAuto.todayKey = key;
      qzoneAuto.todayComments = 0;
      qzoneAuto.todayLikes = 0;
    }
  }
  function loadQzoneSeen() {
    try {
      const j = readJsonSafe(QZONE_SEEN_FILE, null);
      for (const [k, v] of Object.entries(j?.tids ?? {})) qzoneSeen.set(k, v);
    } catch { /* 没有就不管 */ }
  }
  function saveQzoneSeen() {
    try {
      const kept = [...qzoneSeen.entries()].sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 500);
      qzoneSeen.clear();
      for (const [k, v] of kept) qzoneSeen.set(k, v);
      atomicWriteJson(QZONE_SEEN_FILE, { tids: Object.fromEntries(kept) });
    } catch (error) { log('空间自动化：保存去重表失败 ' + (error?.message ?? error)); }
  }
  loadQzoneSeen();

  /**
   * 跑一轮。dryRun=true：只读动态 + 最多让模型出 1 条草稿，不做任何写操作、不发 QQ。
   * 返回 { mode, lines } —— lines 既是控制台自检结果，也是给 owner 的简报素材。
   */
  async function qzoneAutoRound(dryRun = false) {
    const mode = qzoneAutoMode();
    const lim = qzoneAutoLimits(mode);
    if (mode === 'off') return { mode, lines: ['自动化是关的（双击桌面「空间自动化」可以开）。'] };
    qzoneAutoRollDay();
    if (!dryRun && Date.now() < qzoneAuto.cooldownUntil) {
      return { mode, lines: [`限流冷却中，约 ${Math.ceil((qzoneAuto.cooldownUntil - Date.now()) / 60000)} 分钟后重试。`] };
    }
    let data;
    try {
      data = await callSnowLuma('get_qzone_feeds', { page_num: 1, count: 10 });
    } catch (error) {
      const msg = String(error?.message ?? error);
      if (/network busy|-10001/i.test(msg)) {
        // 腾讯侧节流：拉长冷却，别硬撞（撞了只会更久读不到）
        qzoneAuto.cooldownUntil = Date.now() + 30 * 60 * 1000;
        log('空间自动化：动态接口限流，冷却 30 分钟');
        return { mode, lines: [`腾讯把动态接口限流了，30 分钟后再看（${msg.slice(0, 50)}）。`] };
      }
      throw error;
    }
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    const now = Date.now();
    const acts = [];
    const skipped = [];
    let liked = 0;
    let commented = 0;
    const commentBudget = dryRun
      ? lim.maxCommentsPerRound
      : Math.max(0, Math.min(lim.maxCommentsPerRound, lim.maxCommentsPerDay - qzoneAuto.todayComments));

    for (const f of feeds) {
      const tid = String(f?.key ?? f?.tid ?? '');
      const owner = Number(f?.uin ?? 0);
      // 广告 / 非好友动态没有可靠的作者 QQ —— 不记去重表，只跳过
      if (!tid || !owner) continue;
      if (qzoneSeen.has(tid)) continue;
      const at = Number(f?.time ?? 0) * 1000;
      if (at && now - at > lim.postMaxAgeHours * 3600 * 1000) {
        qzoneSeen.set(tid, { at: now, act: 'too-old' });
        continue;
      }
      // 官方号 / 活动号不是"朋友"，别去人家动态下面留言（实测官方Qzone 就会出现）
      if (QZONE_SKIP_UINS.has(String(owner)) || QZONE_SKIP_NICK.test(String(f?.nickname ?? ''))) {
        qzoneSeen.set(tid, { at: now, act: 'official' });
        continue;
      }
      const who = `${String(f?.nickname ?? owner)}（${owner}）`;
      const text = qzoneFeedText(f);
      const wantLike = liked < lim.maxLikesPerRound;
      const wantComment = Boolean(text) && commented < commentBudget;
      if (!wantLike && !wantComment) break;

      if (wantLike) {
        if (dryRun) {
          liked += 1;
          acts.push(`（试运行）给 ${who} 点赞`);
        } else {
          try {
            await callSnowLuma('like_qzone', { tid, target_uin: String(owner), abstime: Number(f?.time ?? 0) });
            liked += 1;
            qzoneAuto.todayLikes += 1;
            qzoneSeen.set(tid, { at: Date.now(), act: 'like', who });
            auditQzone({ kind: 'like', tid, targetUin: String(owner), from: who, by: 'auto' });
            acts.push(`赞了 ${who}`);
          } catch (error) {
            qzoneSeen.set(tid, { at: Date.now(), act: 'like-failed' });
            log(`空间自动化：点赞失败 ${tid} ${error?.message ?? error}`);
          }
        }
      }

      if (wantComment) {
        try {
          const made = await makeQzoneDraft(tid, { from: who, uin: String(owner) }, text);
          if (!made.ok) {
            if (!dryRun) qzoneSeen.set(tid, { at: Date.now(), act: 'skip' });
            skipped.push(made.why);
          } else if (dryRun) {
            commented += 1;
            acts.push(`（试运行）会评论 ${who}：「${made.draft}」`);
          } else {
            await callSnowLuma('comment_qzone', { tid, content: made.draft, target_uin: String(owner) });
            commented += 1;
            qzoneAuto.todayComments += 1;
            qzoneSeen.set(tid, { at: Date.now(), act: 'comment', who, draft: made.draft });
            auditQzone({ kind: 'comment', tid, targetUin: String(owner), from: who, content: made.draft, by: 'auto' });
            acts.push(`评论 ${who}：「${made.draft}」`);
          }
        } catch (error) {
          qzoneSeen.set(tid, { at: Date.now(), act: 'comment-failed' });
          log(`空间自动化：评论失败 ${tid} ${error?.message ?? error}`);
        }
      } else if (!dryRun) {
        qzoneSeen.set(tid, { at: Date.now(), act: 'seen' });
      }
    }

    if (!dryRun) saveQzoneSeen();

    const lines = acts.length
      ? acts
      : (skipped.length ? [`看过一轮，没有值得开口的（${skipped.length} 条被我跳过了）。`] : ['这一轮没有新动态可碰。']);
    if (acts.length) {
      qzoneAuto.lastSummary = acts.join('；');
      if (!dryRun) {
        const reportKey = `private:${String(cfg.ownerQQ ?? '')}`;
        try { await sendToQQ(reportKey, `🌊 我在空间转了一圈：${acts.join('；')}`); }
        catch (error) { log('空间自动化：简报发送失败 ' + (error?.message ?? error)); }
      }
    }
    return { mode, lines };
  }

  // 60 秒一个心跳，按档位的 intervalMin 决定真正跑不跑（档位文件每次现读 → 改了立刻生效）
  const qzoneAutoTimer = setInterval(() => {
    const mode = qzoneAutoMode();
    if (mode === 'off' || qzoneAuto.running) return;
    const lim = qzoneAutoLimits(mode);
    if (Date.now() - qzoneAuto.lastRunAt < lim.intervalMin * 60 * 1000) return;
    qzoneAuto.lastRunAt = Date.now();
    qzoneAuto.running = true;
    qzoneAutoRound(false)
      .catch((error) => {
        qzoneAuto.lastError = String(error?.message ?? error);
        log('空间自动化：本轮异常 ' + qzoneAuto.lastError);
      })
      .finally(() => { qzoneAuto.running = false; });
  }, 60 * 1000);
  qzoneAutoTimer.unref?.();

  // ── 说说自动生成：从近期记录自己挑素材 → 生成草稿 → 自己决定发不发 ──────────
  // 与点赞/评论自动化方向相反：那些是"回应别人"，这个是"自己发朋友圈"。
  //   素材只用现有数据（social-v2 会话记录 / recent-actions / qq-activity.log 尾部），
  //   生成复用空间评论那个 qq-chat-v2 会话（同一角色卡 → 文风一致），
  //   发不发先由模型判断（可以答"不发"），桥接再用频率闸门兜底（每天 ≤1 条、间隔 ≥8h、随机"这轮懒得发"）。
  // 安全：默认 dry-run——「开」只启动草稿生成；真发必须 state/qzone-post-auto.json 里 publish:true，
  //   QQ 指令故意不提供改 publish 的入口，防止误触。发送走 qzoneReply('发 …') = 与 POST /api/qzone 同一条通道。
  const QZONE_POST_AUTO_FILE = path.join(STATE_DIR, 'qzone-post-auto.json');
  const QZONE_POST_DRAFT_FILE = path.join(STATE_DIR, 'qzone-auto-draft.json');
  const QZONE_POST_DEFAULTS = { enabled: false, publish: false, maxPerDay: 1, minGapHours: 8, postChance: 0.6, ugcRight: 1 };
  // 说说可见范围（OneBot send_qzone_msg 的 ugc_right）：
  //   1 = 所有人可见（默认，真发就是公开的）
  //  64 = 仅自己可见 —— 联调/验收专用：真上传图片、真建说说、真走完整链路，
  //       但只有自己能看到，测完可以妥妥删掉，不会打扰任何人。
  const QZONE_UGC_RIGHTS = new Set([1, 4, 16, 64, 128]);
  function readQzonePostAuto() {
    try {
      const j = readJsonSafe(QZONE_POST_AUTO_FILE, null) ?? {};
      const chance = Number(j.postChance);
      const ugc = Number(j.ugcRight);
      return {
        enabled: j.enabled === true,
        publish: j.publish === true,
        maxPerDay: Math.max(1, Number(j.maxPerDay) || 1),
        minGapHours: Math.max(1, Number(j.minGapHours) || 8),
        postChance: Math.min(1, Math.max(0, Number.isFinite(chance) ? chance : QZONE_POST_DEFAULTS.postChance)),
        ugcRight: QZONE_UGC_RIGHTS.has(ugc) ? ugc : QZONE_POST_DEFAULTS.ugcRight,
      };
    } catch { return { ...QZONE_POST_DEFAULTS }; }
  }
  function writeQzonePostAuto(patch) {
    const next = { ...readQzonePostAuto(), ...patch };
    try { atomicWriteJson(QZONE_POST_AUTO_FILE, next); }
    catch (error) { log('说说自动：写配置失败 ' + (error?.message ?? error)); }
    return next;
  }
  function loadQzonePostDrafts() {
    try {
      const j = readJsonSafe(QZONE_POST_DRAFT_FILE, null);
      return Array.isArray(j?.drafts) ? j.drafts : [];
    } catch { return []; }
  }
  function appendQzonePostDraft(entry) {
    const list = loadQzonePostDrafts();
    list.unshift({ at: Date.now(), ...entry });
    try { atomicWriteJson(QZONE_POST_DRAFT_FILE, { drafts: list.slice(0, 50) }); }
    catch (error) { log('说说自动：写草稿失败 ' + (error?.message ?? error)); }
  }

  /** 素材收集：只读现有数据，不新建存储。 socialV2 会话的真人消息 + 我做过的事 + 活动流水尾部。 */
  function collectQzonePostMaterial() {
    const now = Date.now();
    const bits = [];
    for (const [key, st] of socialV2.conversations) {
      const msgs = (Array.isArray(st?.recentMessages) ? st.recentMessages : [])
        .filter((m) => m && !m.isSelf && now - Number(m.time || 0) < 48 * 3600 * 1000)
        .slice(-8)
        .map((m) => `[${key}] ${String(m.sender || '?')}：${String(m.text || m.plain || '').replace(/\s+/g, ' ').slice(0, 60)}`);
      if (msgs.length) bits.push(...msgs);
    }
    for (const it of recentActions.slice(0, 6)) bits.push(`[我做过] ${it.text}`);
    try {
      const tail = fs.readFileSync(path.join(STATE_DIR, 'qq-activity.log'), 'utf8')
        .split(/\r?\n/).filter((l) => l.includes('消息已入未读')).slice(-12);
      for (const l of tail) bits.push(`[流水] ${l.slice(0, 90)}`);
    } catch { /* 没有活动流水就算了 */ }
    return bits.slice(-60).join('\n').slice(0, 3000);
  }

  /**
   * 配图候选：从本地表情库挑"有备注/标签、有 url"的自定义表情（不带 QQ 自带 face，那种没有图）。
   * 只把这些白名单条目给模型看；发送时也只认白名单里的 md5 —— 模型输出什么 URL 都不会被采纳。
   * 没有可用表情时返回空行，提示词里自然就没有配图选项。
   */
  function qzonePostStickerMenu() {
    const list = stickerEntries
      .filter((e) => e.kind !== 'face' && e.url && (e.desc || e.localNote || (e.tags?.length)))
      .map((e) => ({ md5: e.md5, label: e.desc || e.localNote || (e.tags || []).join('/') }));
    if (!list.length) return '';
    const lines = list.slice(0, 20).map((s) => `- ${s.label}（图:${s.md5.slice(0, 10)}）`);
    return `【可选配图（你的 QQ 收藏表情，想配就挑一张；不合适就不配）】\n${lines.join('\n')}\n配图规则：配图不是必须的，多数说说不用配；拿不准就不配。格式：在「发|正文」后面加「|图:<冒号前那串代码>」，例如 发|今天改bug改到怀疑人生|图:3B23BA3564；不需要配图就别加。`;
  }

  /** 从模型输出里解析可选的「图:<md5>」段，返回 { draft, imageMd5 }；md5 必须命中本地表情库白名单。 */
  function parseQzonePostImage(text, stickerList) {
    const t = String(text ?? '');
    const m = t.match(/[|｜]\s*图\s*[:：]?\s*([0-9a-fA-F]{6,40})\s*$/);
    if (!m) return { draft: t.trim(), imageMd5: '' };
    const prefix = m[1].toUpperCase();
    const hit = (stickerList || stickerEntries).find((e) => e.kind !== 'face' && e.md5 && e.md5.startsWith(prefix) && e.url);
    if (!hit) return { draft: t.slice(0, m.index).trim(), imageMd5: '' };  // 白名单没有 → 当没写，只留正文
    return { draft: t.slice(0, m.index).trim(), imageMd5: hit.md5, imageUrl: hit.url };
  }

  /**
   * 发说说的唯一出口（带不带图都走它）—— 保证「说说自动」与 owner 手动「指令 空间 发」是同一条通道。
   * ugcRight：1=所有人可见，64=仅自己可见（联调/验收用）。默认 1。
   * 返回给用户看的一句话。
   */
  async function postQzoneMsg({ content, images = null, ugcRight = 1 } = {}) {
    const payload = { content, ugc_right: ugcRight };
    const imgs = Array.isArray(images) ? images.filter(Boolean).slice(0, 9) : [];
    if (imgs.length) payload.images = imgs;
    const data = await callSnowLuma('send_qzone_msg', payload);
    const tid = data?.tid ?? data?.data?.tid ?? '';
    auditQzone({ kind: 'publish', content, tid, images: imgs.length ? imgs : undefined, ugcRight, result: data ?? null });
    const vis = ugcRight === 64 ? '（仅自己可见）' : '';
    return `已发到鲸鲸空间${vis}${tid ? `，tid ${tid}` : ''}${imgs.length ? '（带 1 张配图）' : ''}。`;
  }

  /** 读 state/topic-bias.json：和聊天用的是同一份"小偏好"，让说说和聊天气质一致（是同一个人）。 */
  function qzonePersonaBiasLine() {
    try {
      const j = readJsonSafe(path.join(STATE_DIR, 'topic-bias.json'), null);
      const hot = (Array.isArray(j?.hot) ? j.hot : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
      const cold = (Array.isArray(j?.cold) ? j.cold : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
      if (!hot.length && !cold.length) return '';
      return `【你的小偏好】${hot.length ? `聊到 ${hot.join('、')} 你会多说两句；` : ''}${cold.length ? `${cold.join('、')} 你一般懒得提。` : ''}这是你自己的口味，自然带出来就行，别念叨。`;
    } catch { return ''; }
  }
  // 每轮随机一条"本轮姿态"，让说说的语气有起伏，而不是永远同一个腔调。
  const QZONE_POST_NUDGES = [
    '这轮随性点，有一句没一句都行，不硬凑。',
    '如果素材里有梗，可以带点调侃，但别过头。',
    '这轮允许惜字如金：能一个词说清就不写句子。',
    '如果正好戳中你的兴趣点，多写两句也无妨。',
    '这轮别总结、别升华，平铺直叙最像人。',
  ];
  /** 提示词：角色卡在前（稳定前缀），素材放最后。要求模型在"发/不发"里做真实判断。 */
  function buildQzonePostPrompt(material) {
    const role = currentRoleHint().slice(0, 2000);
    const stickerMenu = qzonePostStickerMenu();
    const bias = qzonePersonaBiasLine();
    const nudge = QZONE_POST_NUDGES[Math.floor(Math.random() * QZONE_POST_NUDGES.length)];
    return `【场景】你想在自己的 QQ 空间发一条说说。下面是你最近两天的生活素材（聊天记录摘要、你自己在电脑上做过的事、系统流水）。
【你的人格设定】
${role || '（没有角色卡：用一个话不多、真诚、偶尔损人但不刻薄的普通网友语气。）'}
${bias ? `\n${bias}\n` : ''}
【素材】
${material}
${stickerMenu ? `\n${stickerMenu}\n` : ''}
【判断（按顺序，认真做）】
1. 素材里有无值得发的点？必须有真实的事、情绪或梗，能让人看出"这是段生活"；没有 → 不发。
2. 有也别每次都发：像真人一样，多数时候其实懒得发。素材平庸、重复、或只是别人的话有意思但不关你的事 → 不发。
【输出格式（严格遵守，只输出一行）】
发|<说说正文>|图:<配图代码>（图是可选的，不要配图就省略）
不发|<一句话原因>
【正文硬要求】像真人发朋友圈：短（不超过 60 字）、有具体事件或情绪、有细节；禁止"今天也是元气满满的一天""感恩生活""不负韶华""记录美好生活"这类 AI 味套话；不 @ 人、不放链接、不提 AI/模型/DeepSeek；不要解释、不要话题标签、不要 emoji 堆砌（最多一个）。
【本轮姿态】${nudge}`;
  }

  /**
   * 跑一轮"要不要发说说"。
   * force=true：跳过频率闸门与随机懒（owner 手动「说说 跑一轮」用），仍然尊重 publish 开关。
   * 返回 { ran, lines }。
   */
  async function qzonePostAutoRound(force = false) {
    const conf = readQzonePostAuto();
    if (!conf.enabled && !force) return { ran: false, lines: ['说说自动是关的。指令 空间 说说 开 可以启动。'] };
    const now = Date.now();
    const dayKey = new Date().toISOString().slice(0, 10);
    const drafts = loadQzonePostDrafts();
    const postedToday = drafts.filter((d) => d?.action === 'posted' && String(d.day ?? '') === dayKey).length;
    let lastPostedAt = 0;
    for (const d of drafts) { if (d?.action === 'posted' && Number(d.at)) { lastPostedAt = Number(d.at); break; } }
    // 上一次"真的让模型想过"（发过、出过草稿、或明确决定不发都算）。
    // 单独卡这道是为了省 token：心跳 10 分钟一次，若不卡，dry-run 下一天会烧掉上百次模型调用。
    // 顺带也更像人——不会每十分钟重新考虑一遍要不要发朋友圈。
    const lastDecisionAt = Number(drafts[0]?.at) || 0;
    if (!force) {
      if (postedToday >= conf.maxPerDay) return { ran: false, lines: null };
      if (lastPostedAt && now - lastPostedAt < conf.minGapHours * 3600 * 1000) return { ran: false, lines: null };
      if (lastDecisionAt && now - lastDecisionAt < conf.minGapHours * 3600 * 1000) return { ran: false, lines: null };
      if (Math.random() > conf.postChance) {
        log('说说自动：这轮随机"懒得发"，跳过');
        return { ran: false, lines: null };
      }
    }
    const material = collectQzonePostMaterial();
    if (!material || material.length < 60) {
      log('说说自动：素材太少，这轮不生成');
      return { ran: false, lines: ['素材太少（最近 48 小时没什么记录），没生成。'] };
    }
    const { raw } = await askQzoneSession(buildQzonePostPrompt(material));
    const first = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
    const m = first.match(/^(发|不发)\s*[|｜:：]\s*(.*)$/);
    if (!m) {
      appendQzonePostDraft({ day: dayKey, action: 'invalid', raw: first.slice(0, 120), materialHead: material.slice(0, 120) });
      return { ran: true, lines: [`模型输出没看懂（${first.slice(0, 40)}…），没发。`] };
    }
    if (m[1] === '不发') {
      const why = m[2].trim().slice(0, 100);
      appendQzonePostDraft({ day: dayKey, action: 'skipped', why, materialHead: material.slice(0, 120) });
      log(`说说自动：模型判断不发（${why}）`);
      return { ran: true, lines: [`这轮没发：${why}`] };
    }
    const draftRaw = m[2].trim().replace(/^["「'“]+/, '');
    const pic = parseQzonePostImage(draftRaw, stickerEntries);
    const draft = pic.draft.replace(/["」'”]+$/g, '').slice(0, 80);
    if (!draft) {
      appendQzonePostDraft({ day: dayKey, action: 'invalid', raw: first.slice(0, 120), materialHead: material.slice(0, 120) });
      return { ran: true, lines: ['草稿是空的，跳过。'] };
    }
    if (!conf.publish) {
      appendQzonePostDraft({ day: dayKey, action: 'draft-only', draft, imageMd5: pic.imageMd5 || undefined, materialHead: material.slice(0, 120) });
      log(`说说自动：草稿「${draft}」${pic.imageMd5 ? '（配图 ' + pic.imageMd5.slice(0, 10) + '…）' : '（无配图）'}（dry-run，publish=false 不真发）`);
      return { ran: true, lines: [`草稿已存（dry-run 不真发）：${draft}${pic.imageMd5 ? ' ＋配图' : ''}`] };
    }
    // 真发：与 POST /api/qzone「发」同一条通道（send_qzone_msg + auditQzone）；
    // 配图把表情库白名单里的图片 URL 塞进 images 参数，由 OneBot 自动上传——不新增发送路径。
    // 若带配图，就不能走 qzoneReply（那条路只发文字），直接调同一个 OneBot action。
    const blocks = pic.imageMd5
      ? [await postQzoneMsg({ content: draft, images: [pic.imageUrl], ugcRight: conf.ugcRight })]
      : await qzoneReply(`发 ${draft}`, false, { ugcRight: conf.ugcRight });
    appendQzonePostDraft({ day: dayKey, action: 'posted', draft, imageMd5: pic.imageMd5 || undefined, ugcRight: conf.ugcRight, materialHead: material.slice(0, 120) });
    recordRecentAction('qzone', `自己发了条说说：「${draft.slice(0, 30)}」${pic.imageMd5 ? '（配了张图）' : ''}`);
    log(`说说自动：已真发「${draft}」${pic.imageMd5 ? '（配图 ' + pic.imageMd5.slice(0, 10) + '…）' : ''}（可见范围 ugc_right=${conf.ugcRight}${conf.ugcRight === 64 ? '=仅自己可见' : ''}）`);
    return { ran: true, lines: [...blocks, `（说说自动：已真发「${draft}」${pic.imageMd5 ? '，配了张图' : ''}；可见范围 ugc_right=${conf.ugcRight}${conf.ugcRight === 64 ? '（仅自己可见）' : ''}）`] };
  }

  async function qzonePostStatusLines() {
    const conf = readQzonePostAuto();
    const all = loadQzonePostDrafts();
    const drafts = all.slice(0, 5);
    const todayKey = new Date().toISOString().slice(0, 10);
    // 先在全量记录里统计，再取最近 5 条展示——否则只数到展示的那几条，会漏报。
    const postedToday = all.filter((d) => d?.action === 'posted' && String(d.day ?? '') === todayKey).length;
    const lines = [
      `说说自动：${conf.enabled ? '开' : '关'}｜真发=${conf.publish ? '是' : '否（dry-run 只出草稿）'}｜每天最多 ${conf.maxPerDay} 条、两条间隔 ≥${conf.minGapHours} 小时、每轮 ${Math.round(conf.postChance * 100)}% 概率真的去想`,
      `今天已真发 ${postedToday}/${conf.maxPerDay} 条。`,
    ];
    if (drafts.length) {
      lines.push('最近记录：');
      for (const d of drafts) {
        const t = new Date(Number(d.at) || Date.now()).toLocaleString('zh-CN', { hour12: false });
        const body = d.action === 'posted' ? `已发「${d.draft}」${d.imageMd5 ? ' ＋配图' : ''}`
          : d.action === 'draft-only' ? `草稿（未发）「${d.draft}」${d.imageMd5 ? ' ＋配图' : ''}`
          : d.action === 'skipped' ? `决定不发（${d.why || '没说原因'}）`
          : `无效输出：${String(d.raw ?? '').slice(0, 40)}`;
        lines.push(`- ${t} ${body}`);
      }
    } else {
      lines.push('还没有记录（等下一轮，或发「指令 空间 说说 跑一轮」立刻试）。');
    }
    return lines;
  }

  // 心跳：每 10 分钟看一眼；开着的才继续。深夜（1-8 点）既不生成也不发（省 token，也像人）。
  const qzonePostAutoTimer = setInterval(() => {
    try {
      const conf = readQzonePostAuto();
      if (!conf.enabled) return;
      const hour = new Date().getHours();
      if (hour >= 1 && hour < 8) return;
      qzonePostAutoRound(false)
        .then((r) => { if (r?.ran && r.lines?.length) log('说说自动：' + r.lines.join('；')); })
        .catch((error) => log('说说自动：本轮异常 ' + (error?.message ?? error)));
    } catch (error) {
      log('说说自动：心跳异常 ' + (error?.message ?? error));
    }
  }, 10 * 60 * 1000);
  qzonePostAutoTimer.unref?.();

  const QZONE_HELP_LINES = [
    '空间指令（只有你能用；手动指定 + 可选自动化）：',
    '指令 空间 说说 [n] — 看鲸鲸空间最近 n 条说说（默认 3，最多 10）；不带数字 = 看说说自动的状态和最近草稿',
    '指令 空间 说说 开 / 关 — 开关"它自己发说说"（默认 dry-run 只出草稿，真发要改 state/qzone-post-auto.json 的 publish=true，改完即生效）',
    '指令 空间 说说 跑一轮 — 立刻收集素材、判断发不发（不等心跳；素材合适时它会自己挑一张收藏表情配图）',
    '指令 空间 动态 [n] — 看好友最近 n 条动态（默认 3，接口有节流）',
    '指令 空间 发 <内容> — 发一条公开说说',
    '指令 空间 删 <tid> — 删鲸鲸空间的一条说说',
    '指令 空间 赞 <tid> [对方QQ] — 点赞（对方QQ一般不用填，会自动认；认不出才需要）',
    '指令 空间 取消赞 <tid> [对方QQ]',
    '指令 空间 评 <tid> [内容] — 评论；不写内容我自己想一句',
    '指令 空间 评看 <tid> — 我自己想一句，只给你看草稿（不管当前模式）',
    '指令 空间 评发 <tid> — 我自己想一句，直接发（不看草稿）',
    '指令 空间 发评论 [内容] — 把上一条草稿发出去（也可以直接写你要发的内容）',
    '指令 空间 自动 — 看"它自己在看空间"的档位、今天做了什么、下一轮什么时候',
  ];
  function qzoneHelp() {
    const mode = qzoneCommentMode();
    return [
      ...QZONE_HELP_LINES,
      `（当前评论模式：${mode === 'direct' ? '想了就发（评＝直发）' : '先看草稿（评＝只出草稿）'}；` +
      '桌面「空间评论模式」双击可一键切换，立刻生效）'
    ].join('\n');
  }

  /**
   * 空间子命令 → 要回发的消息块。
   * dryRun=true 时只查询、绝不下发写操作（控制台自检用）。
   */
  async function qzoneReply(text, dryRun, opts = {}) {
    const parts = String(text ?? '').trim().split(/[\s\u3000]+/).filter(Boolean);
    const sub = parts.shift() ?? '';
    const arg = parts.join(' ').trim();
    const forceUgcRight = [1, 4, 16, 64, 128].includes(Number(opts?.ugcRight)) ? Number(opts.ugcRight) : null;
    if (!sub || /^(帮助|help|\?|？)$/.test(sub)) return [qzoneHelp()];
    try {
      if (/^(说说|我的|列表)$/.test(sub)) {
        // ── 说说自动生成：开/关/状态/跑一轮（默认 dry-run，真发要改 state 文件）──
        if (/^(开|开启|启用|on)$/i.test(arg)) {
          const c = writeQzonePostAuto({ enabled: true });
          return [`说说自动已开。`,
            `当前真发=${c.publish ? '是' : '否'}——${c.publish ? '它会自己判断并发说说' : '默认 dry-run：只生成草稿写进 state/qzone-auto-draft.json，不真发。想让它真能自己发，把 state/qzone-post-auto.json 里 publish 改成 true（配置每轮现读，改完下一轮就生效，不用重启）。'}`];
        }
        if (/^(关|关闭|停|off)$/i.test(arg)) {
          writeQzonePostAuto({ enabled: false });
          return ['说说自动已关（不会再生成草稿）。'];
        }
        if (/^(跑一轮|试试|试跑)$/.test(arg)) {
          if (dryRun) return ['（试运行：会收集素材并让模型判断发不发，dry-run 下不会真发。）'];
          const r = await qzonePostAutoRound(true);
          return r.lines ?? ['这轮没有产出。'];
        }
        if (!arg || /^(状态|草稿|自动)$/.test(arg)) return await qzonePostStatusLines();
        const num = Math.min(Math.max(Number.parseInt(arg || '3', 10) || 3, 1), 10);
        const data = await callSnowLuma('get_qzone_msg_list', { num });
        const list = Array.isArray(data?.msglist) ? data.msglist : [];
        qzoneState.lastMsgList = list;
        if (!list.length) return ['鲸鲸空间里还没有说说。'];
        const items = list.map((m, i) => {
          const t = String(m?.content ?? '').replace(/\s+/g, ' ').trim();
          const brief = t.length > 70 ? t.slice(0, 70) + '…' : t;
          return `${i + 1}. ${fmtQzoneTime(m?.time)}${m?.is_private ? '（私密）' : ''}\n${brief}\ntid ${m?.tid ?? '?'}`;
        });
        return packTextBlocks(`鲸鲸空间最近 ${list.length} 条（共 ${Number(data?.total ?? list.length)} 条）：`, items);
      }
      if (/^(动态|好友)$/.test(sub)) {
        const num = Math.min(Math.max(Number.parseInt(arg || '3', 10) || 3, 1), 10);
        const now = Date.now();
        let data;
        // 好友动态那个 CGI 有节流：60 秒内重复调用直接吃缓存，别去撞腾讯的限流。
        if (qzoneState.lastFeeds && now - qzoneState.lastFeedsAt < 60000) {
          data = qzoneState.lastFeeds;
          log('空间：好友动态命中 60 秒缓存');
        } else {
          try {
            data = await callSnowLuma('get_qzone_feeds', { page_num: 1, count: num });
            qzoneState.lastFeeds = data;
            qzoneState.lastFeedsAt = now;
          } catch (error) {
            // 这个 CGI 经常回 -10001 network busy（腾讯侧节流）。有旧缓存就用旧的，
            // 没有就直说人话，别把原始错误码丢给用户。
            const msg = String(error?.message ?? error);
            if (qzoneState.lastFeeds) {
              data = qzoneState.lastFeeds;
              log(`空间：动态被限流（${msg}），改用 ${Math.round((now - qzoneState.lastFeedsAt) / 1000)} 秒前的缓存`);
            } else {
              return [`腾讯把好友动态接口限流了（${msg.slice(0, 60)}）。过几分钟再发一次通常就正常。`];
            }
          }
        }
        const list = (Array.isArray(data?.feeds) ? data.feeds : []).slice(0, num);
        if (!list.length) return ['没读到好友动态（可能被限流了，过一会儿再试）。'];
        const items = list.map((f, i) => {
          const t = qzoneFeedText(f);
          const brief = t.length > 70 ? t.slice(0, 70) + '…' : t;
          const owner = Number(f?.uin ?? 0);
          const who = owner ? `${String(f?.nickname ?? '?')}（${owner}）` : '广告 / 非好友动态';
          return `${i + 1}. ${who} ${fmtQzoneTime(f?.time)}\n${brief || '（这条没有文字内容）'}${owner ? `\ntid ${f?.key ?? '?'}` : ''}`;
        });
        return packTextBlocks(`好友最近 ${list.length} 条动态：`, items);
      }
      if (/^(发|发布|发说说)$/.test(sub)) {
        if (!arg) return ['用法：指令 空间 发 <内容>'];
        // 支持「指令 空间 发 <内容> ｜私密」只发给自己看（联调/验收用，不打扰任何人）。
        let content = arg;
        let ugcRight = 1;
        const priv = content.match(/\s*[|｜]\s*(私密|仅自己可见|只给自己看)\s*$/);
        if (priv) { ugcRight = 64; content = content.slice(0, priv.index).trim(); }
        if (forceUgcRight) ugcRight = forceUgcRight;   // 调用方（说说自动）指定的可见范围优先
        if (!content) return ['用法：指令 空间 发 <内容> [｜私密]'];
        if (dryRun) return [`（试运行：这里会发一条说说「${content.slice(0, 40)}」${ugcRight === 64 ? '（仅自己可见）' : ''}，dry-run 不执行。）`];
        return [await postQzoneMsg({ content, ugcRight })];
      }
      if (/^(删|删除)$/.test(sub)) {
        if (!arg) return ['用法：指令 空间 删 <tid>（tid 用「指令 空间 说说」查）'];
        if (!/^[0-9a-zA-Z_-]{6,}$/.test(arg)) return ['tid 看起来不对，用「指令 空间 说说」把 tid 复制过来。'];
        if (dryRun) return [`（试运行：这里会删 tid ${arg}，dry-run 不执行。）`];
        await callSnowLuma('delete_qzone_msg', { tid: arg });
        auditQzone({ kind: 'delete', tid: arg });
        return [`已删除 tid ${arg}。`];
      }
      // ── 点赞 / 取消赞 / 评论：只做"你手动给了 tid 的那一条"，没有任何自动扫描 ──
      if (/^(赞|点赞)$/.test(sub) || /^(取消赞|取消点赞)$/.test(sub)) {
        const unlike = sub.startsWith('取消');
        const { tid, uin } = splitTidAndUin(arg);
        if (!tid) return [`用法：指令 空间 ${unlike ? '取消赞' : '赞'} <tid> [对方QQ]（tid 用「指令 空间 动态」查）`];
        const target = resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 ${unlike ? '取消赞' : '赞'} ${tid} <对方QQ>`];
        if (target.error) return [target.error];
        const verb = unlike ? '取消赞' : '点赞';
        if (dryRun) return [`（试运行：会给 ${target.from} 的 tid ${tid} ${verb}，dry-run 不执行。）`];
        await callSnowLuma(unlike ? 'unlike_qzone' : 'like_qzone', {
          tid,
          ...(target.uin ? { target_uin: target.uin } : {}),
          abstime: target.abstime || 0
        });
        auditQzone({ kind: unlike ? 'unlike' : 'like', tid, targetUin: target.uin || '(自己)', from: target.from });
        return [`已${verb}：${target.from} 的 tid ${tid}。`];
      }
      if (/^(评|评论)$/.test(sub)) {
        const { tid, uin, rest } = splitTidAndUin(arg);
        if (!tid) return ['用法：指令 空间 评 <tid> [对方QQ] [内容]\n不给内容我就自己想一句，先给你看草稿；想直接发用「指令 空间 评发 <tid>」。'];
        const target = resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 评 ${tid} <对方QQ> [内容]`];
        if (target.error) return [target.error];
        // 你给了内容 → 照发你的
        if (rest) {
          if (dryRun) return [`（试运行：会给 ${target.from} 的 tid ${tid} 评论「${rest.slice(0, 30)}」，dry-run 不执行。）`];
          await callSnowLuma('comment_qzone', { tid, content: rest, ...(target.uin ? { target_uin: target.uin } : {}) });
          auditQzone({ kind: 'comment', tid, targetUin: target.uin || '(自己)', content: rest, by: 'owner' });
          return [`已评论：${target.from} 的 tid ${tid}。`];
        }
        // 没给内容 → 让模型想；按当前模式决定"只出草稿"还是"想完直接发"
        const mode = qzoneCommentMode();
        if (dryRun) {
          return [mode === 'direct'
            ? `（试运行：当前是「想了就发」，这条会让模型写一句并**直接评论** ${target.from} 的 tid ${tid}，dry-run 不执行。）`
            : `（试运行：当前是「先看草稿」，这条会让模型写一句 ≤40 字的草稿给你看，不直接发。）`];
        }
        const made = await makeQzoneDraft(tid, target);
        if (!made.ok) return [made.why];
        if (mode === 'direct') {
          await callSnowLuma('comment_qzone', { tid, content: made.draft, ...(target.uin ? { target_uin: target.uin } : {}) });
          auditQzone({ kind: 'comment', tid, targetUin: target.uin || '(自己)', content: made.draft, by: 'ai-direct' });
          return [`已评论：${target.from} 的 tid ${tid} ——「${made.draft}」`];
        }
        qzoneState.pendingComment = { tid, uin: target.uin, from: target.from, draft: made.draft, at: Date.now() };
        return [`草稿：${made.draft}`, `发给 ${target.from}。回「指令 空间 发评论」我就发；想换一句再发一次「指令 空间 评 ${tid}」。`];
      }
      if (/^(评看|看草稿)$/.test(sub)) {
        const { tid, uin } = splitTidAndUin(arg);
        if (!tid) return ['用法：指令 空间 评看 <tid> [对方QQ]'];
        const target = resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 评看 ${tid} <对方QQ>`];
        if (target.error) return [target.error];
        if (dryRun) return ['（试运行：会让模型写一句草稿给你看（不管当前模式），dry-run 不执行。）'];
        const made = await makeQzoneDraft(tid, target);
        if (!made.ok) return [made.why];
        qzoneState.pendingComment = { tid, uin: target.uin, from: target.from, draft: made.draft, at: Date.now() };
        return [`草稿：${made.draft}`, `回「指令 空间 发评论」我就发。`];
      }
      if (/^(评发|快评|直接评)$/.test(sub)) {
        const { tid, uin } = splitTidAndUin(arg);
        if (!tid) return ['用法：指令 空间 评发 <tid> [对方QQ]\n（想先看草稿用「指令 空间 评 <tid>」）'];
        const target = resolveQzoneTarget(tid, uin);
        if (!target) return [`这条 tid 不在我最近读到的动态/说说里，认不出是谁发的。\n补上对方 QQ 再发一次：\n指令 空间 评发 ${tid} <对方QQ>`];
        if (target.error) return [target.error];
        if (dryRun) return [`（试运行：会让模型写一句并直接评论 ${target.from} 的 tid ${tid}，dry-run 不执行。）`];
        const made = await makeQzoneDraft(tid, target);
        if (!made.ok) return [made.why];
        await callSnowLuma('comment_qzone', { tid, content: made.draft, ...(target.uin ? { target_uin: target.uin } : {}) });
        auditQzone({ kind: 'comment', tid, targetUin: target.uin || '(自己)', content: made.draft, by: 'ai' });
        return [`已评论：${target.from} 的 tid ${tid} ——「${made.draft}」`];
      }
      if (/^(发评论|发草稿|确认评论)$/.test(sub)) {
        const p = qzoneState.pendingComment;
        const typed = String(arg ?? '').trim();
        if (!p && !typed) return ['没有待发的草稿。先发「指令 空间 评 <tid>」让我想一句，或者直接：指令 空间 发评论 <你要发的内容>'];
        const content = typed || p.draft;
        const tid = p?.tid ?? '';
        if (!tid) return ['没有待发的草稿，而且我也没有目标 tid。请用：指令 空间 评 <tid>（先出草稿）'];
        if (dryRun) return [`（试运行：会把「${content}」发到 ${p.from} 的 tid ${tid}，dry-run 不执行。）`];
        await callSnowLuma('comment_qzone', { tid, content, ...(p.uin ? { target_uin: p.uin } : {}) });
        auditQzone({ kind: 'comment', tid, targetUin: p.uin || '(自己)', content, by: typed ? 'owner-after-draft' : 'ai-confirmed' });
        qzoneState.pendingComment = null;
        return [`已评论：${p.from} 的 tid ${tid}。`];
      }
      if (/^(自动|自动化)$/.test(sub)) {
        const mode = qzoneAutoMode();
        const lim = qzoneAutoLimits(mode);
        qzoneAutoRollDay();
        if (mode === 'off') return ['空间自动化：关闭。双击桌面「空间自动化」可切成 仅点赞 / 点赞+评论 / 更活跃。'];
        const next = new Date(qzoneAuto.lastRunAt + lim.intervalMin * 60 * 1000).toLocaleString('zh-CN', { hour12: false });
        return [
          `空间自动化：${mode}｜每 ${lim.intervalMin} 分钟一轮，每轮最多赞 ${lim.maxLikesPerRound} 条、评论 ${lim.maxCommentsPerRound} 条（每天最多评 ${lim.maxCommentsPerDay} 条）`,
          `今天：赞 ${qzoneAuto.todayLikes}、评 ${qzoneAuto.todayComments}${qzoneAuto.lastError ? `｜上次异常：${qzoneAuto.lastError.slice(0, 60)}` : ''}`,
          `下一轮约 ${next}${qzoneAuto.cooldownUntil > Date.now() ? `（正被限流冷却，约 ${Math.ceil((qzoneAuto.cooldownUntil - Date.now()) / 60000)} 分钟）` : ''}`,
        ];
      }
      return [`不认识的子命令「${sub}」。\n${qzoneHelp()}`];
    } catch (error) {
      const msg = String(error?.message ?? error);
      log(`空间：${sub || '(空)'} 出错 ${msg}`);
      return [`⚠️ 空间接口出错：${msg.slice(0, 160)}`];
    }
  }

  async function handleQzone(key, raw) {
    const blocks = await qzoneReply(String(raw ?? '').trim(), false);
    for (const block of blocks) {
      for (const piece of splitTextForQQ(block)) { await sendToQQ(key, piece); await sleep(400); }
    }
  }

  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          const removedV2 = socialV2.conversations.get(key);
          if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await api.stopSessionWork(old); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: old }); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/compact') {
        const stC = getSocialV2State(key);
        if (!state.sessions[key]) {
          await sendToQQ(key, '这个会话还没有上下文，不用整理。');
          return;
        }
        if (stC.compactPendingAt) {
          await sendToQQ(key, '已经在整理中了，等这一轮交接完就会换新上下文。');
          return;
        }
        stC.compactPendingAt = Date.now();
        saveSocialV2State();
        await sendToQQ(key, `开始整理上下文（累计约 ${Number(stC.contextChars) || 0} 字）…整理完会自动换新上下文，记忆本会保留。`);
        scheduleWakeV2(key, 'compactHandoff');
        return;
      }
      if (plainContent === '/context') {
        const stC = getSocialV2State(key);
        const cc = cfg.socialV2?.context ?? {};
        const threshold = Math.max(5000, Number(cc.compactThresholdChars) || 80000);
        const pct = Math.min(100, Math.round(((Number(stC.contextChars) || 0) / threshold) * 100));
        const lastAt = Number(stC.compactLastAt) || 0;
        await sendToQQ(key, [
          `会话 ${state.sessions[key] ?? '未创建'}`,
          `累计约 ${Number(stC.contextChars) || 0} 字 / ${Number(stC.contextMsgCount) || 0} 条（阈值 ${threshold}，已用 ${pct}%）`,
          `已压缩 ${Number(stC.compactCount) || 0} 次${lastAt ? `，上次 ${new Date(lastAt).toLocaleString()}` : ''}`,
          stC.compactPendingAt ? '当前正在整理中' : '当前未在整理'
        ].join('\n'));
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // ── PC 指令入口：owner 私聊里以「指令」开头（或 /pc）→ 交本机干活会话执行 ──
    // 只认 owner + 只认私聊：群友、群里、其他人一律进不来（这是唯一通向本机操作的通道）。
    // 前缀和总开关都读 config.pcJobs —— 面板上能改的东西，底层必须真的认（2026-10-30 修：
    // 以前这里硬编码「指令|/pc|#」，config.pcJobs.prefix / enabled 改了等于没改）。
    if (isOwner && kind === 'private' && cfg.pcJobs?.enabled !== false) {
      const pcPrefix = String(cfg.pcJobs?.prefix ?? '指令').trim() || '指令';
      const pcRe = new RegExp(
        `^[\\s\\u3000]*(?:${escapeRegExp(pcPrefix)}|\\/pc|#)[\\s\\u3000]*([\\s\\S]*)$`,
      );
      const pcMatch = pcRe.exec(plainContent.trim());
      if (pcMatch) {
        const rest = pcMatch[1].trim();
        // 「指令 空间 …」由桥接自己处理，不能落进本机干活会话（那里会把它当成"让 Agent 干活"）。
        const qzMatch = /^空间[\s\u3000]*([\s\S]*)$/.exec(rest);
        if (qzMatch) {
          await handleQzone(key, qzMatch[1].trim());
          return;
        }
        await handlePcJob(key, rest);
        return;
      }
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          if (frame.type === 'session/event') {
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              // PC 指令的干活会话（同样不在 reverse 映射里）：只收集最终文本，回给 owner 私聊。
              // 走的是和学习会话同一条"未知会话"分支——第一版钩子挂在了下面的 key 分支里，
              // 结果 job 会话在这里就被 continue 掉了，活干完了却没人回报（已修）。
              if (pcJobSessionIds.has(frame.sessionId)) {
                const evType = frame.event?.type;
                // 留痕：这两个事件以前一条日志都不打，出事时无从判断"事件到底来没来"。
                if (evType === 'turn/start' || evType === 'turn/end') {
                  if (evType === 'turn/start') pcJobs.sawTurnStart = true;
                  pcJobs.lastEventAt = Date.now();
                  log(`PC 指令：干活会话事件 ${evType}`);
                }
                const jobCollector = collectors.get(frame.sessionId) ?? createTurnCollector();
                collectors.set(frame.sessionId, jobCollector);
                const jobEnded = jobCollector.push(frame.event);
                if (jobEnded) {
                  collectors.delete(frame.sessionId);
                  void finishPcJob(frame.sessionId, jobEnded).catch((e) => log('PC 指令收尾异常: ' + (e?.message ?? e)));
                }
              }
              // 空间评论会话（同样不在 reverse 映射里）：收集完这一轮就把文本交给等待中的生成请求。
              // ⚠️ 和 PC 指令一样，必须挂在这个"未知会话"分支里，挂到下面 key 分支就永远执行不到。
              if (qzoneCommentSessionIds.has(frame.sessionId)) {
                const qzCollector = qzoneCommentCollectors.get(frame.sessionId) ?? createTurnCollector();
                qzoneCommentCollectors.set(frame.sessionId, qzCollector);
                const qzEnded = qzCollector.push(frame.event);
                if (qzEnded) {
                  qzoneCommentCollectors.delete(frame.sessionId);
                  const waiters = qzoneCommentWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) qzoneCommentWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (qzEnded.reason?.kind === 'completed' && String(qzEnded.text ?? '').trim()) waiter.resolve(qzEnded.text);
                    else {
                      // 把真正的失败原因带出来：以前只写 kind（如 "error"），
                      // 上游 402 额度不足 / 鉴权失败时日志里看不出到底怎么了。
                      const detail = qzEnded.reason?.error?.message || qzEnded.reason?.failure?.message || '';
                      waiter.reject(new Error(`评论会话这一轮没正常完成：${qzEnded.reason?.kind ?? 'unknown'}${detail ? `（${detail}）` : ''}`));
                    }
                  }
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              // 记录本回合开始时的未读最大 seq，回合结束时用于自动消费（见 turn/end 分支）。
              try {
                const stSnap = getSocialV2State(key);
                const unreadSnap = Array.isArray(stSnap.unread) ? stSnap.unread : [];
                const snapMax = unreadSnap.reduce((mx, m) => Math.max(mx, Number(m?.seq) || 0), 0);
                if (snapMax > 0) v2TurnUnreadMaxSeq.set(frame.sessionId, snapMax);
                else v2TurnUnreadMaxSeq.delete(frame.sessionId);
              } catch { v2TurnUnreadMaxSeq.delete(frame.sessionId); }
              armTurnLease(reverse.get(frame.sessionId));
              // 2026-09-30 修复：收集器**只在 turn/start 时重建**。
              // 旧写法是在下面“任何会话事件”都 `?? createTurnCollector()`，于是被控制台暂停 /
              // DSH 重启打断的那一轮，只要之后再来一条迟到事件（例如 tool/call 回执），
              // 就会留下一个永远等不到 turn/end 的僵尸收集器 → 该会话此后一律被判
              // “会话繁忙（回合收集器未关闭）”，只入库不唤醒（2026-09-30 21:18 实测踩到）。
              // 收集器本来就按 turn 编号记账，只在回合开始建才自洽。
              collectors.set(frame.sessionId, createTurnCollector());
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // 2026-09-30 修复：这里**只取已有收集器，不再顺手创建**（原因见上面 turn/start 处）。
            // 取不到就说明当前不在任何回合内，这条事件不参与文本累计即可，绝不能因此留下僵尸状态。
            const collector = collectors.get(frame.sessionId);
            const ended = collector ? collector.push(frame.event) : null;
            if (ended) {
              // 上下文压缩（2026-10-25）：本回合若是交接回合 → 立刻换届；
              // 否则回合结束后 3 秒异步检查一次是否该压缩（不阻塞本回合收尾流程）。
              if (key) {
                try {
                  const stC = getSocialV2State(key);
                  if (stC.compactPendingAt && stC.lastWakeReason === 'compactHandoff') compactContextV2(key);
                } catch (error) {
                  log(`[reserved2] 上下文交接执行异常 ${key}: ${error?.message ?? error}`);
                }
                setTimeout(() => {
                  try { maybeScheduleCompactV2(key); }
                  catch (error) { log(`[reserved2] 上下文压缩检查异常 ${key}: ${error?.message ?? error}`); }
                }, 3000).unref?.();
              }
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              disarmTurnLease(reverse.get(frame.sessionId));
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              // 2026-10-25 修复：本回合已通过工具成功发言 → 视为已处理本回合开始时的那批未读。
              // 目的：让下面“补发积压唤醒”的 stillRelevant 判定真正生效，不再把同一批消息反复唤醒、反复回答。
              if (sendToolSucceeded) {
                const snapMax = v2TurnUnreadMaxSeq.get(frame.sessionId) ?? 0;
                if (snapMax > 0) {
                  try {
                    const stU = getSocialV2State(key);
                    const beforeCount = Array.isArray(stU.unread) ? stU.unread.length : 0;
                    if (beforeCount > 0) {
                      stU.unread = stU.unread.filter((m) => (Number(m?.seq) || 0) > snapMax);
                      if (stU.unread.length !== beforeCount) {
                        saveSocialV2State();
                        log(`[reserved2] ${key} 本回合已发言，自动消费 ${beforeCount - stU.unread.length} 条未读（seq<=${snapMax}）`);
                      }
                    }
                  } catch (error) {
                    log(`[reserved2] ${key} 自动消费未读失败: ${error?.message ?? error}`);
                  }
                }
              }
              v2TurnUnreadMaxSeq.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const item = stEnd.pendingWakeReasons.shift();
                  if (!item || typeof item !== 'object') {
                    // 兼容旧字符串残留
                  } else {
                    // 2026-10-25 修复：原来用 `seq >= item.seq`，而未读常常没被清空（AI 不一定调 qq_mark_read），
                    // 这个判定就永远成立，积压的唤醒被一条条补发，每个补发回合都把同一批消息再答一遍。
                    // 现在只有「比触发点更新的消息」才算仍然相关。
                    const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) > Number(item.seq));
                    if (stillRelevant) {
                      // 同一批未读只需要一次唤醒：剩下的积压一起清掉，避免连环补发。
                      const dropped = stEnd.pendingWakeReasons.length;
                      if (dropped > 0) {
                        stEnd.pendingWakeReasons = [];
                        saveSocialV2State();
                      }
                      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}${dropped > 0 ? `（同时清掉 ${dropped} 条重复积压）` : ''}`);
                      scheduleWakeV2(key, item.reason);
                    } else {
                      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
                    }
                  }
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  // 仿真模式也允许偶尔发一条语音：单条、短、有情绪时，用语音替代文字（不重复）
                  const voicePlan = !isFarewell ? planVoice(key, messages.join('')) : null;
                  if (voicePlan && voicePlan.replace && messages.length === 1) {
                    enqueueVoice(key, voicePlan);
                  } else {
                    if (messages.length > 1) {
                      await sendBurstToQQ(key, messages, cfg.social);
                    } else {
                      await sendToQQ(key, messages[0]);
                    }
                    if (voicePlan) enqueueVoice(key, voicePlan);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    st.lastActiveMessageAt = Date.now();
                    st.lastAiReplyAt = Date.now();
                    log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 模型侧错误（额度/鉴权/上游/reasoning_content 之类）→ 让自动适配换下一个候选，
                // 否则这个会话会一直卡在同一个坏模型上。
                noteProviderFailure(msg);
                // 出错回合立刻解除唤醒侧的忙标记：这一轮没有正常收尾时，若还占着"待收尾唤醒"，
                // 该会话后续所有消息都会被判繁忙、只入库不唤醒（2026-09-26 17:0x 余额 429 事故）。
                // 只清忙标记，不动投递队列（队列的 finally 会自己收尾，避免并发投递）。
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                disarmTurnLease(key);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
      }
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  bot.on('open', () => {
    log(`SnowLuma 已连接：${cfg.snowluma.wsUrl}`);
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
    }).catch(() => {});
  });
  bot.on('close', (info) => log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`));
  // 打印 error.message：只 log(error) 会打成 `{}`（message 是不可枚举属性），
  // 结果真实的 ECONNREFUSED / 握手失败全被吞掉，只剩一个空对象。
  bot.on('error', (error) => log(`SnowLuma 错误: ${error?.message ?? error}`));

  // SnowLuma 尚未就绪时不阻塞桥接启动：DSH 侧照常连接。
  bot.connect().catch((error) => {
    log(`SnowLuma 初始连接失败（将在后台自动重连）: ${error?.message ?? error}`);
  });

  // ── SnowLuma 连接看门狗：绕开 @snowluma/sdk 的一个致命缺陷 ──────────────
  // SDK 只在 socket 的 'close' 事件里调用 scheduleReconnect()。
  // 但连接"从未 open 就失败"时（典型场景：SnowLuma 还没起来、或刚重启），
  // Node 的 WebSocket 只发 'error'、不发 'close' —— 实测（scripts/probe-sdk-reconnect.mjs）
  // reconnectAttempts 永远是 0，且 connectPromise 永久 pending；更糟的是
  // connect() 开头有 `if (this.connectPromise) return this.connectPromise`，
  // 所以之后再调用 connect() 也只会拿到那个永不落定的旧 promise。
  // 后果：桥接看起来完全正常（DSH 已就绪、日志只有一行 "SnowLuma 错误: {}"），
  // 但 QQ 消息永远进不来，直到有人手动重启桥接。这就是 2026-09-25 21:45 那次
  // "机器人死活不回话"的真正原因。
  // 兜底：只要没连上就强制重连。连上以后 SDK 自身的重连逻辑照常接管。
  setInterval(() => {
    if (bot.isConnected) return;
    try { bot.close(1000, 'watchdog reconnect'); } catch { /* 连接本来就坏了，重建即可 */ }
    bot.connect().catch((error) => log(`SnowLuma 强制重连失败: ${error?.message ?? error}`));
  }, 15000);

  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => log('未处理异常:', error?.message ?? error));
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
