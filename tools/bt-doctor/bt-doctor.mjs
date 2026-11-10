#!/usr/bin/env node
/**
 * bt-doctor —— Botogether 模型服务兼容体检工具
 *
 * 目的：解决三个已知问题带来的「用户无法自查」困境
 *   #1 Windows 上 npm 原生 exe 型 Agent 被判定为不可用
 *   #2 OpenCode 2.x 不支持自定义模型服务（provider 注入）
 *   #3 /v1/models 返回的已下线模型被当作可用模型呈现
 *
 * 用法示例：
 *   node bt-doctor.mjs --endpoint https://api.minimaxi.com/v1 --protocol openai --key sk-xxx
 *   node bt-doctor.mjs --endpoint https://api.minimaxi.com/anthropic --protocol anthropic --key sk-xxx
 *   node bt-doctor.mjs --endpoint https://api.minimaxi.com/v1 --key sk-xxx --skip-probe
 *   node bt-doctor.mjs --endpoint https://api.minimaxi.com/v1 --key sk-xxx --json
 *
 * 退出码：0 = 端点与所选引擎均可用；1 = 存在阻断项；2 = 参数或网络错误
 */

import fs from "node:fs";
import path from "node:path";

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const opts = {
  endpoint: "",
  protocol: "auto",
  key: "",
  keyFile: "",
  models: [],
  engines: ["opencode", "claude", "codex"],
  skipProbe: false,
  concurrency: 4,
  json: false,
  timeoutMs: 45000,
};
const need = (i) => {
  const v = argv[i + 1];
  if (v === undefined) {
    console.error(`缺少参数值：${argv[i]}`);
    process.exit(2);
  }
  return v;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--endpoint") opts.endpoint = need(i++);
  else if (a === "--protocol") opts.protocol = need(i++).toLowerCase();
  else if (a === "--key") opts.key = need(i++);
  else if (a === "--key-file") opts.keyFile = need(i++);
  else if (a === "--models") opts.models = need(i++).split(",").map((s) => s.trim()).filter(Boolean);
  else if (a === "--engines") opts.engines = need(i++).split(",").map((s) => s.trim()).filter(Boolean);
  else if (a === "--skip-probe") opts.skipProbe = true;
  else if (a === "--concurrency") opts.concurrency = Number(need(i++)) || 4;
  else if (a === "--timeout") opts.timeoutMs = Number(need(i++)) || 45000;
  else if (a === "--json") opts.json = true;
  else if (a === "-h" || a === "--help") {
    printHelp();
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    printHelp();
    process.exit(2);
  }
}
if (!opts.endpoint) {
  console.error("必须提供 --endpoint");
  printHelp();
  process.exit(2);
}
if (!opts.key && opts.keyFile) {
  try {
    const raw = fs.readFileSync(path.resolve(opts.keyFile), "utf8");
    // 兼容两种形态：纯文本密钥，或含 api_key 字段的 JSON（如 ~/.mmx/config.json）
    let k = raw.trim();
    try {
      const j = JSON.parse(raw);
      if (j && (j.api_key || j.apiKey || j.key)) k = j.api_key || j.apiKey || j.key;
    } catch {}
    opts.key = k;
  } catch (e) {
    console.error(`读取密钥文件失败：${e.message}`);
    process.exit(2);
  }
}
if (!opts.key) {
  console.error("必须提供 --key 或 --key-file");
  process.exit(2);
}
opts.endpoint = opts.endpoint.replace(/\/+$/, "");

function printHelp() {
  console.log(`bt-doctor —— Botogether 模型服务兼容体检

必填：
  --endpoint <url>        服务基地址，如 https://api.minimaxi.com/v1
  --key <key>             API 密钥（或用 --key-file <路径>）
可选：
  --protocol <p>          openai | anthropic | auto（默认 auto）
  --models <a,b,c>        指定要探测的模型（默认取服务返回的清单）
  --engines <a,b,c>       要评估的引擎：opencode,claude,codex
  --skip-probe            只读模型清单，不逐个发请求
  --concurrency <n>       并发探测数（默认 4）
  --timeout <ms>          单次请求超时（默认 45000）
  --json                  输出机器可读 JSON
`);
}

// ---------- 协议与端点推导 ----------
function candidates(protocol) {
  const e = opts.endpoint;
  const list = [];
  if (protocol === "anthropic") {
    list.push({
      protocol: "anthropic",
      models: `${e}/v1/models`,
      call: `${e}/v1/messages`,
      responses: null,
    });
  } else {
    list.push({
      protocol: "openai",
      models: `${e}/models`,
      call: `${e}/chat/completions`,
      responses: `${e}/responses`,
    });
    // 端点没带 /v1 时的常见写法
    if (!/\/v\d+$/.test(e)) {
      list.push({
        protocol: "openai",
        models: `${e}/v1/models`,
        call: `${e}/v1/chat/completions`,
        responses: `${e}/v1/responses`,
      });
    }
  }
  return list;
}

function authHeaders(protocol, authMode) {
  const h = { "Content-Type": "application/json" };
  if (protocol === "anthropic") {
    if (authMode === "api-key") {
      h["x-api-key"] = opts.key;
    } else {
      h["Authorization"] = `Bearer ${opts.key}`;
    }
    h["anthropic-version"] = "2023-06-01";
  } else {
    h["Authorization"] = `Bearer ${opts.key}`;
  }
  return h;
}

async function httpJson(url, { method = "GET", body, headers = {}, timeout = opts.timeoutMs } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const msg =
      json && json.error
        ? (json.error.message || JSON.stringify(json.error)).slice(0, 200)
        : json && json.message
          ? String(json.message).slice(0, 200)
          : text.slice(0, 200);
    return { ok: res.ok, status: res.status, json, msg, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, json: null, msg: e.message, ms: Date.now() - t0 };
  }
}

// ---------- 步骤 1：端点与凭据 ----------
async function resolveEndpoint() {
  const probes = candidates(opts.protocol === "auto" ? "openai" : opts.protocol);
  const tried = [];
  for (const p of probes) {
    for (const authMode of p.protocol === "anthropic" ? ["bearer", "api-key"] : ["bearer"]) {
      const r = await httpJson(p.models, { headers: authHeaders(p.protocol, authMode) });
      tried.push({ url: p.models, authMode, status: r.status });
      if (r.ok && r.json && Array.isArray(r.json.data)) {
        return {
          profile: p,
          authMode,
          models: r.json.data.map((m) => m.id).filter(Boolean),
          raw: r,
          tried,
        };
      }
      // 鉴权失败但端点存在：记住这个组合，稍后单独报告
      if (r.status === 401 || r.status === 403) {
        return {
          profile: p,
          authMode,
          authFailed: true,
          models: [],
          raw: r,
          tried,
        };
      }
    }
  }
  return { profile: probes[0], authMode: "bearer", failed: true, models: [], tried };
}

// ---------- 步骤 2：逐模型可调用性 ----------
async function probeModel(profile, model) {
  const headers = authHeaders(profile.protocol, profile.authMode);
  const body =
    profile.protocol === "anthropic"
      ? { model, max_tokens: 32, messages: [{ role: "user", content: "reply with the single word: ok" }] }
      : { model, messages: [{ role: "user", content: "reply with the single word: ok" }], max_tokens: 32 };
  const r = await httpJson(profile.call, { method: "POST", body, headers });
  if (r.ok) return { model, status: r.status, ok: true, ms: r.ms, note: "" };
  const retired = /no longer available|not found|unknown model/i.test(r.msg);
  return {
    model,
    status: r.status,
    ok: false,
    retired,
    ms: r.ms,
    note: r.msg.replace(/\s+/g, " ").slice(0, 120),
  };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------- 步骤 3：引擎兼容判定 ----------
function engineVerdict(engine, profile, probes) {
  const callable = probes.filter((p) => p.ok).map((p) => p.model);
  const retired = probes.filter((p) => p.retired).map((p) => p.model);
  const rows = [];
  // ok: true=可用  false=阻断  null=未知
  const add = (ok, verdict, fix, blocking = false) => rows.push({ engine, ok, verdict, fix, blocking });

  if (engine === "opencode") {
    if (profile.protocol !== "openai") {
      add(false, "协议不匹配", "OpenCode 只接受 openai 协议；Anthropic 兼容端点无法用于 OpenCode", true);
    } else {
      add(true, "协议匹配", "填 protocol=openai，targetEngine=opencode");
      add(
        false,
        "引擎版本受阻",
        "OpenCode 2.x 不支持 provider 注入（issue #2）。请安装并注册 opencode-ai 1.x 的真实 exe",
        true
      );
    }
  } else if (engine === "claude") {
    if (profile.protocol !== "anthropic") {
      add(false, "协议不匹配", "Claude Code 只接受 anthropic 协议", true);
    } else {
      add(true, "协议匹配", "填 protocol=anthropic，targetEngine=claude");
      add(true, "端点形态匹配", `endpoint 填 ${opts.endpoint}，authMode 按实测取值 ${resolvedAuthMode}`);
    }
  } else if (engine === "codex") {
    if (profile.protocol !== "openai") {
      add(false, "协议不匹配", "Codex 只接受 openai 协议", true);
    } else if (probes.responsesOk === true) {
      add(true, "Responses 可用", "wire_api 固定为 responses，该端点已验证支持");
    } else if (probes.responsesOk === false) {
      add(false, "仅支持 Chat Completions", "Codex 适配器硬编码 wire_api=responses，该端点的 /responses 不可用", true);
    } else {
      add(null, "未探测 Responses", "该端点未探测 /responses，Codex 可用性未知");
    }
  }
  return { rows, callable, retired };
}

// 由端点域名推断建议的 secretEnv
function guessSecretEnv(endpoint) {
  const host = (() => {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return "";
    }
  })();
  if (/minimaxi\.com|minimax\.io/.test(host)) return "MINIMAX_API_KEY";
  if (/bigmodel\.cn|z\.ai/.test(host)) return "ZHIPU_API_KEY";
  if (/dashscope|aliyuncs/.test(host)) return "DASHSCOPE_API_KEY";
  if (/deepseek/.test(host)) return "DEEPSEEK_API_KEY";
  if (/moonshot|kimi/.test(host)) return "MOONSHOT_API_KEY";
  if (/volces|ark/.test(host)) return "ARK_API_KEY";
  return "OPENAI_API_KEY";
}

let resolvedAuthMode = "bearer";

// ---------- 主流程 ----------
async function main() {
  const resolved = await resolveEndpoint();
  const profile = resolved.profile;
  resolvedAuthMode = resolved.authMode || "bearer";

  const modelList = opts.models.length ? opts.models : resolved.models;
  let probes = [];
  if (!opts.skipProbe && modelList.length && !resolved.authFailed) {
    probes = await pool(modelList, opts.concurrency, (m) => probeModel(profile, m));
    // 顺带探测 Responses（Codex 可用性）
    if (profile.responses) {
      const r = await httpJson(profile.responses, {
        method: "POST",
        body: { model: modelList[0], input: "reply with the single word: ok", max_output_tokens: 32 },
        headers: authHeaders("openai", profile.authMode),
      });
      probes.responsesOk = r.ok;
    }
  }

  const report = {
    endpoint: opts.endpoint,
    resolvedProfile: {
      protocol: profile.protocol,
      modelsUrl: profile.models,
      callUrl: profile.call,
      authMode: resolvedAuthMode,
    },
    endpointReachable: !resolved.failed,
    authOk: !resolved.authFailed && !resolved.failed,
    declaredModels: resolved.models,
    probedModels: probes.filter((p) => p && typeof p === "object" && p.model),
    callable: probes.filter((p) => p && p.ok).map((p) => p.model),
    retired: probes.filter((p) => p && p.retired).map((p) => p.model),
    failed: probes.filter((p) => p && !p.ok && !p.retired).map((p) => p.model),
    engines: {},
    botogetherConfig: {},
    notes: [],
  };

  for (const eng of opts.engines) {
    const v = engineVerdict(eng, profile, probes);
    report.engines[eng] = v.rows;
    if (v.callable.length && !report.botogetherConfig.models) {
      report.botogetherConfig.models = v.callable;
    }
  }
  const usableEngines = Object.entries(report.engines)
    .filter(([, rows]) => rows.some((r) => r.ok === true) && !rows.some((r) => r.blocking))
    .map(([e]) => e);
  report.usableEngines = usableEngines;
  report.botogetherConfig = {
    name: "<自定义名称>",
    endpoint: opts.endpoint,
    protocol: profile.protocol,
    targetEngine: usableEngines[0] || "<opencode|claude|codex>",
    credentialSource: "secure",
    authMode: resolvedAuthMode,
    defaultModel: report.callable[0] || "<模型 id>",
    models: report.callable,
    secretEnv: guessSecretEnv(opts.endpoint),
  };

  if (resolved.authFailed) report.notes.push("端点可达但凭据被拒：检查密钥与区域（国内站/国际站密钥不通用）");
  if (resolved.failed) report.notes.push(`端点不可达，已尝试：${resolved.tried.map((t) => `${t.url}(${t.status})`).join(", ")}`);
  if (report.retired.length)
    report.notes.push(`以下模型在 /models 中声明但已不可调用（issue #3），Botogether 会把它们当作可用：${report.retired.join(", ")}`);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  const blocking = Object.values(report.engines).some((rows) => rows.some((r) => r.blocking));
  process.exit(blocking || !report.authOk ? 1 : 0);
}

function printHuman(r) {
  const line = "─".repeat(64);
  console.log(line);
  console.log("bt-doctor · Botogether 模型服务兼容体检");
  console.log(line);
  console.log(`端点          ${r.endpoint}`);
  console.log(`协议 / 认证    ${r.resolvedProfile.protocol} / ${r.resolvedProfile.authMode}`);
  console.log(`模型清单      ${r.declaredModels.length} 个（${r.declaredModels.slice(0, 6).join(", ")}${r.declaredModels.length > 6 ? " …" : ""}）`);
  console.log(`端点可达      ${r.endpointReachable ? "✓" : "✗"}`);
  console.log(`凭据有效      ${r.authOk ? "✓" : "✗"}`);

  if (r.probedModels.length) {
    console.log("\n【模型可调用性】");
    console.log("  模型".padEnd(30) + "结果".padEnd(12) + "耗时".padStart(8));
    for (const p of r.probedModels) {
      const state = p.ok ? "✓ 可调用" : p.retired ? "✗ 已下线" : `✗ ${p.status}`;
      console.log("  " + p.model.padEnd(30) + state.padEnd(12) + `${p.ms}ms`.padStart(8));
      if (!p.ok && p.note) console.log("      " + p.note);
    }
    console.log(`  → 可调用 ${r.callable.length} · 已下线 ${r.retired.length} · 其他失败 ${r.failed.length}`);
  }

  console.log("\n【引擎兼容性】");
  for (const [eng, rows] of Object.entries(r.engines)) {
    console.log(`  ${eng}`);
    for (const row of rows) {
      const mark = row.ok === true ? "✓" : row.ok === false ? "✗" : "·";
      console.log(`    ${mark} ${row.verdict}`);
      if (row.fix) console.log(`        → ${row.fix}`);
    }
  }

  console.log("\n【建议的 Botogether 模型服务配置】");
  console.log("  设置 → 模型与代理 → 添加模型服务");
  for (const [k, v] of Object.entries(r.botogetherConfig)) {
    console.log(`    ${k.padEnd(16)} ${Array.isArray(v) ? v.join(", ") : v}`);
  }

  if (r.notes.length) {
    console.log("\n【提示】");
    for (const n of r.notes) console.log("  • " + n);
  }
  console.log(line);
}

main().catch((e) => {
  console.error("体检失败：" + (e && e.message ? e.message : String(e)));
  process.exit(2);
});
