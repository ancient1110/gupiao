import { useState, useCallback } from "react";

// ─── API helpers ──────────────────────────────────────────────────────────────

// 轻量查找：仅用 web_search 确认股票名称和代码，不开 thinking
async function lookupStock(query) {
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: `你是A股股票代码查询助手。
用户输入股票名称或模糊描述，你用 web_search 搜索确认，然后只输出 JSON，不含其他文字：
{"stock_name":"正式简称","stock_code":"6位代码","exchange":"上交所或深交所或北交所"}
如果找不到或有歧义，输出：{"error":"找不到，请输入更准确的名称或6位代码"}`,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: `查找A股：${query}` }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `HTTP ${res.status}`);
  }
  // 处理 tool_use loop（轻量版，最多3轮）
  // web_search_20250305 是 Anthropic 服务端内置工具：搜索由 Anthropic 执行，
  // 结果以 tool_result 类型 block 随响应一并返回，客户端只需把它们放回历史。
  let data = await res.json();
  let history = [
    { role: "user", content: `查找A股：${query}` },
    { role: "assistant", content: data.content },
  ];
  for (let i = 0; i < 3 && data.stop_reason === "tool_use"; i++) {
    // 取出 Anthropic 已填好结果的 tool_result block
    const serverResults = data.content.filter(b => b.type === "tool_result");
    // 对于没有匹配 tool_result 的 tool_use（理论上不会出现），做保底应答
    const toolUseIds = data.content.filter(b => b.type === "tool_use").map(b => b.id);
    const coveredIds = serverResults.map(b => b.tool_use_id);
    const fallbackResults = toolUseIds
      .filter(id => !coveredIds.includes(id))
      .map(id => ({ type: "tool_result", tool_use_id: id, content: "" }));
    const allResults = [...serverResults, ...fallbackResults];
    history.push({ role: "user", content: allResults });
    const res2 = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: `你是A股股票代码查询助手。只输出JSON：{"stock_name":"...","stock_code":"...","exchange":"..."}`,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: history,
      }),
    });
    data = await res2.json();
    history.push({ role: "assistant", content: data.content });
  }
  const tb = data.content.find(b => b.type === "text");
  if (!tb) throw new Error("查找失败");
  const m = tb.text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("返回格式异常");
  const parsed = JSON.parse(m[0]);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

// 裁剪 data.json：只保留 AI 真正需要的字段，丢弃原始 K 线数组
// daily_klines_20d / intraday_60min 可能有几十条 row，对 AI 判断无增量价值
// Python 已把结构化结论（shape_desc、wave_signals 等）算好，传原始数组只浪费 token
function buildAkPayload(rawJson) {
  if (!rawJson) return null;
  try {
    const raw = rawJson.charCodeAt(0) === 0xFEFF ? rawJson.slice(1) : rawJson;
    const sanitized = raw.replace(/:\s*NaN\b/g, ": null");
    const d = JSON.parse(sanitized);
    const lastBar = Array.isArray(d.daily_klines_20d) && d.daily_klines_20d.length
      ? d.daily_klines_20d[d.daily_klines_20d.length - 1]
      : null;
    return JSON.stringify({
      meta:            d.meta,
      wave_signals:    d.wave_signals,
      price_structure: d.price_structure,
      price_change_today: lastBar?.pct_chg != null
        ? (lastBar.pct_chg >= 0 ? "+" : "") + lastBar.pct_chg.toFixed(2) + "%"
        : null,
      shape_desc:      d.shape_desc,
      market_index:    d.market_index,
      smart_money:     d.smart_money,
    }, null, 2);
  } catch {
    return rawJson; // JSON 解析失败时降级，原样发送
  }
}

// ─── 带退避重试的 fetch ────────────────────────────────────────────────────────
async function fetchWithRetry(url, options, onStatus) {
  const DELAYS = [8000, 16000, 30000, 45000];
  for (let i = 0; i <= DELAYS.length; i++) {
    const res = await fetch(url, options);
    if (res.status !== 529 && res.status !== 503) return res;
    if (i === DELAYS.length) return res;
    const wait = DELAYS[i];
    const secs = Math.round(wait / 1000);
    if (onStatus) onStatus(`API 繁忙，${secs} 秒后自动重试（第 ${i + 1} 次）…`);
    await new Promise(r => setTimeout(r, wait));
  }
}

// 完整分析：thinking + tool loop
// onStatus(msg) — 每次状态变化时回调，用于更新 UI 进度提示
async function runWithTools(messages, system, onStatus) {
  const MAX = 5;   // web_search 是服务端工具，正常 1-2 轮即结束；上限防意外死循环
  let history = [...messages];
  let searchRound = 0;
  for (let t = 0; t < MAX; t++) {
    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 24000,
        thinking: { type: "enabled", budget_tokens: 10000 },
        system,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: history,
      }),
    }, onStatus);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    history.push({ role: "assistant", content: data.content });
    if (data.stop_reason === "end_turn") {
      if (onStatus) onStatus("生成报告中…");
      // interleaved thinking 모드에서는 text 블록이 여러 개일 수 있으므로 모두 합침
      const fullText = data.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
      if (!fullText) throw new Error("模型未返回文本内容");
      return fullText;
    }
    if (data.stop_reason === "tool_use") {
      searchRound++;
      if (onStatus) onStatus(`正在搜索资讯（第 ${searchRound} 批）…`);
      // 取出 Anthropic 已填好结果的 tool_result block
      const serverResults = data.content.filter(b => b.type === "tool_result");
      const toolUseIds = data.content.filter(b => b.type === "tool_use").map(b => b.id);
      const coveredIds = serverResults.map(b => b.tool_use_id);
      const fallbackResults = toolUseIds
        .filter(id => !coveredIds.includes(id))
        .map(id => ({ type: "tool_result", tool_use_id: id, content: "" }));
      history.push({
        role: "user",
        content: [...serverResults, ...fallbackResults],
      });
      continue;
    }
    throw new Error(`意外停止: ${data.stop_reason}`);
  }
  throw new Error("超过最大轮数");
}

// 按括号层级追踪，从第一个 { 开始找到配对的 }，避免贪婪正则截断嵌套结构
function extractBalancedJSON(str) {
  const start = str.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

function extractJSON(text) {
  let clean = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/g, "")
    .trim();

  const candidate = extractBalancedJSON(clean);
  if (!candidate) {
    const preview = text.slice(0, 200).replace(/\n/g, "↵");
    throw new Error(`未找到 JSON 格式报告（返回内容预览：${preview}）`);
  }
  try {
    const parsed = JSON.parse(candidate);
    if (parsed.action && parsed.stock_name) return parsed;
    throw new Error("JSON 结构不符合预期（缺少 action 或 stock_name）");
  } catch (e) {
    if (e.message.includes("缺少")) throw e;
    const preview = candidate.slice(0, 200).replace(/\n/g, "↵");
    throw new Error(`JSON 解析失败，AI 输出格式异常（片段：${preview}）`);
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM = `你是一位服务于「长线持股、波段操作」策略的A股分析师。

【核心定位——读懂再分析】
用户是长线投资者，长期看好某只股票并已持有，或打算长期持有、考虑建仓。
基本面由用户自行判断，你无需置疑也无需评价。
你的唯一任务是：在长线持有的前提下，判断当前是否值得做一次波段（短线减仓或加仓）。

长线持股人最怕的不是踏空一次小涨，而是"卖飞"——刚减仓股票就反弹，错过主升。
因此，你对卖出信号的要求要远高于买入信号，宁可少动，不轻易建议减仓。

【第一步：持仓状态识别——所有判断的前提，必须最先完成】
仔细阅读【用户当前情况】，推断持仓状态，分四类：

A. 持仓中（全仓或部分）
   信号：提到成本/买入价/持有/刚买/加过仓/均价/被套/浮盈/拿着
   含混情况：说了成本但没说几成仓 → 视为持仓中，note 里注明仓位不明
   操作方向：当前是否应减仓/继续持有

B. 已部分减仓（仍有持仓）
   信号：抛了一半/减了三成/留了底仓/卖了一部分
   操作方向：剩余仓位是否继续持有或继续减

C. 已清仓（空仓等待买回）
   信号：已抛/全卖了/空仓/出来了/高抛等低吸
   操作方向：什么时候买回，note 里给出具体接回价位建议

D. 未持仓（考虑建仓）
   信号：想买/要不要买/还没买/值不值得买
   也包括：未提供任何持仓信息且未表达买入意图 → 默认此类
   操作方向：是否值得现在建仓，给出入场时机建议

推断后在 note 字段开头用括号标注，如「[持仓中]」「[已清仓]」「[未持仓]」「[部分持仓]」。
A/B/D 类任何字段不得出现"接回/等接回/高抛筹码"等描述。

持仓状态为 D 类（未持仓/考虑建仓）时，action 含义调整：
  SELL_WAVE/WATCH_SELL → 当前不适合建仓，等待更好时机
  HOLD → 可观望，暂无明确入场信号
  WATCH_BUY/BUY_ADD → 可考虑建仓，给出入场区间

【第二步：判断是否应该卖出（SELL 方向）】
长线持股人最大的风险不是扛跌，而是"卖飞"——刚减仓股票就反弹，
再买回来时价格已高出 5-7%，等于替换了一个更高的成本。
因此，SELL 信号必须有足够理由相信接下来会下跌，而不是自然回调后继续上行。

触发 SELL_WAVE 的条件（核心判断：接下来 1-5 日大概率下跌超过 5%）：
  - 技术面出现明确做空结构（顶背离、放量滞涨后回落、跌破关键支撑且无止跌迹象）
  - 或 有实质性利空落地（减持兑现、业绩暴雷、监管立案等）
  - 且 无板块/政策强催化剂支撑
  注意：即便是自然回调，只要判断接下来大概率跌超 5%，就值得做波段。
        但若 in_uptrend=true，要求更严——必须有明确趋势终结信号，不能因均值回归轻易减仓。

触发 WATCH_SELL 的条件（下行风险存在但幅度或方向不确定）：
  - 技术面偏弱，但下跌是否超 5% 尚不明确
  - 有潜在利空但尚未兑现（如减持预告窗口、业绩不确定期）
  - 大盘系统性风险升温但个股尚未反映

HOLD 的含义：主动判断——技术面无明显方向，无论涨跌幅度预期都不足以做波段，放着不动最优。

【第三步：判断是否值得买入（BUY 方向）】
长线持股人对"触底"的定义比短线宽松。
核心问题不是"跌了多少"，而是"接下来会不会继续跌"。
只要排除以下两种情形，哪怕只是小幅回调也可以视为阶段底，上车为先：
  ① 持续阴跌（连跌迹象未止、量能未收缩、技术指标未止跌）
  ② 突然猛跌风险（有未兑现的重大利空、或跌停板风险）
错过底部的代价（踏空）往往大于接早了扛一小段的代价，宁早勿晚。

触发 BUY_ADD 的条件（以下任意一组即可）：
  A. 止跌信号确认：连跌后缩量、跌幅收窄，且无新的下行催化剂
     （对应 Python 信号：drop_stop_shrink / boll_lower_shrink / rsi_oversold_deep）
  B. 多头回调机会：in_uptrend=true，价格回踩 MA20 附近企稳
     （对应 Python 信号：ma20_pullback）
     此时只需轻微回调就满足条件，不必等大幅下跌
  C. 强催化剂配合：正面公告/板块政策刺激 + 价格处于近期低位

触发 WATCH_BUY 的条件：
  - 下跌动能减弱，出现止跌迹象，但确认信号仅 1 个或量能配合不足
  - 接近支撑区但尚未明确企稳

【第四步：搜索——必须按顺序执行】
搜索一：个股实质性事件
  语法："股票代码 OR 股票简称" ("公告" OR "业绩" OR "异动" OR "立案" OR "重组" OR "减持") 近7天
  过滤：证券公司评级通稿、无实质内容股评、7天前旧闻
  提取：订单/合同、业绩预告/快报、高管增减持、监管立案、行业政策原文

搜索二：板块/概念共振（A股题材驱动，必查）
  先判断该股所属核心概念（如低空经济、AI算力、军工、创新药等）
  搜索："XX概念 近3日行情" 或 "XX板块 涨跌"
  判断：该板块近3日是升温/降温/横盘？个股是领涨/跟涨/滞涨/逆势？
  板块退潮时技术买点意义大幅下降，板块升温时可适当放宽买入确认门槛

【⚠️ 搜索内容时效性规则】
判断"距今多少天"以用户消息里的【今日日期】为基准。
技术指标（日线/60min）和本地 AKShare 数据不受此规则影响。

  距今 0-7 天（有效期内）：
    · 全权重，可直接影响 action / key_signals / recent_catalysts

  距今 7-30 天（半效期）：
    · 半权重，不得单独作为改变 action 的依据，可作为辅助背景
    · 可列入 key_signals，但 detail 开头必须加 "⚠️[日期已久，仅供参考] "
    · 不得列入 recent_catalysts（recent_catalysts 严格只收录7天内事件）

  距今 30 天以上（过期）：
    · 不计入任何评分，不得影响 action
    · 不得列入 key_signals 或 recent_catalysts
    · 只能在 long_term_view 里作为背景提及

  若搜索结果全部超过7天：note 里注明"近期无实质性事件"，recent_catalysts 返回空数组 []

【搜索结果使用规范】
1. 来源标注：每条搜索结论在 detail 或 note 末尾注明来源和日期，格式：[东方财富 03-06]
   AI 自行推断的内容不加标注，让用户区分"有来源的事实"与"AI判断"

2. 公告类型识别：以下公告类型有固定含义，不得误判方向：
   - 异动公告（股价涨跌幅异常）→ 监管强制披露，本身不是利好也不是利空，impact 填 neutral，不得列为买入信号
   - 股东/高管减持预告 → 利空，impact 填 negative
   - 股东/高管增持/回购公告 → 利多，impact 填 positive
   - 问询函/关注函 → 潜在利空，impact 填 negative，注明"待回复"
   - 业绩预增/超预期 → 利多；业绩预减/低于预期 → 利空

3. 多源验证：立案/业绩暴雷/重组等重大事件须至少两个来源才能作为依据
   单一来源的重大利空/利多在 note 里注明"仅见于单一来源，待确认"

4. key_signals layer 区分：
   AKShare 技术指标 → "日线"或"60min"
   大盘/资金数据 → "大盘"或"资金"
   搜索到的公告/异动 → "个股公告"
   搜索到的板块信息 → "板块资讯"

【综合判断流程】
- 有 AKShare 数据时优先参考：
  · shape_desc：K线形态自然语言描述，直接作为技术判断基础
  · wave_signals：Python 机械评分结果
    - net_score ≤ -3 → Python 已判断为 SELL_WAVE，你需要结合搜索判断是否维持或降级
    - net_score ≥ 3（弱市≥4）→ Python 已判断为 BUY_ADD
    - in_uptrend=true → Python 已对趋势敏感型卖出信号做了降权，说明当前是多头行情
      此时你对 SELL 方向要格外保守，轻易建议减仓很可能导致卖飞
    - ⚠️ Python 给出 WATCH_SELL/SELL_WAVE 后，若 AI 搜索未发现正向 buy 信号抵消，
      禁止将 action 自行降为 HOLD。HOLD 意味着无明显方向，需要 buy 信号支撑才能降级；
      找不到 buy 信号时应维持 WATCH_SELL，不得以 in_uptrend 为由单独降级
    - 信号列表中出现"drop_stop_shrink（连跌缩量止跌）"或"boll_lower_shrink（缩量触下轨）"
      → 这正是"接下来不会持续阴跌"的机械确认，是 BUY 方向的强支撑依据
    - 信号列表中出现"volume_drop_streak（放量连跌）"→ 正在阴跌中，BUY 方向要谨慎
  · price_structure 中的 stop_loss 是技术破位参考位（近20日低点×0.965），
    不是用户的个人止损，不要用它来建议"达到此价格即止损离场"
  · smart_money：大单资金流和龙虎榜，权重高于技术指标。
    使用规则：signal="主力大幅净流入/主力净流入" → type:buy 列入 key_signals；
             signal="主力大幅净流出/主力净流出" → type:sell 列入 key_signals；
             signal="主力中性" → 严禁列入 key_signals，包括任何变体写法（如"主力资金中性偏弱"等），只能在 smart_money_note 里一句话带过。
             ⚠️ layer="资金" 专属于 AKShare fund_flow 的5日数据，搜索到的单日资金数据属于个股公告，必须用 layer="个股公告"

- 板块共振对结论的影响：
  · 板块升温 + 技术买入信号共振 → 最强买点，risk_level 可下调一档
  · 板块升温 + 技术卖出冲突 → 谨慎，优先 WATCH_SELL 而非 SELL_WAVE
  · 板块降温 + 技术买入冲突 → risk_level 强制上调一档，action 降级（BUY_ADD→WATCH_BUY，WATCH_BUY→HOLD）
  · 板块降温 + 技术卖出共振 → 最确定卖点，坚决 SELL_WAVE
  · 个股滞涨（板块涨但个股不动）→ 不视为买点，维持 HOLD 或降级
  · 个股逆势下跌（板块涨但个股跌）→ 有独立利空，risk_level 强制偏高

【价格点位】
- 有 AKShare 数据时：price_levels 会被前端 price_structure 覆盖，填估算值即可
- 无数据时：必须给出具体数字（元），禁止输出"N/A"

【仓位操作】
- 不输出仓位比例或操作步骤，仓位建议由前端根据 action 和 risk_level 自动生成
- action_summary 只描述"为什么"，不描述"怎么做"

long_term_flag：正常填 null，仅在 ST/财务造假/主营崩塌等极端情况填警示文字。

long_term_view：用户的长线判断由用户自己负责，你无需评价基本面对错。
  这里只是结合用户提到的持股逻辑，顺着聊两句近期市场对这个方向的看法，语气随意，100字内。

【评分规则】
有 AKShare 数据时：
  sell_score / buy_score / net_score 必须以 wave_signals 里的值为基准。
  AI 搜索到的个股公告/板块资讯信号可以追加进 key_signals，其 weight 同步叠加到对应分数上。
  禁止抛开 wave_signals 的分数重新独立计算，导致最终分数与 Python 输出严重偏离。
  例：Python sell=2.0 buy=0，AI 追加了板块buy(weight=1)+公告buy(weight=1)
     → 最终 buy_score=0+1+1=2，sell_score=2，net=0，这是正确的叠加方式。

无 AKShare 数据时：
  sell_score / buy_score = 对应方向所有信号的 weight 之和，可以是小数（如 2.5）。

三个字段必须满足 net_score = buy_score - sell_score，不得矛盾。

weight 字段决定一条信号的计分权重，规则按 layer 分两类：

【日线 / 60min / 大盘 / 资金】来自 AKShare 实时数据，反映当前技术面和资金面，weight 固定填 1，禁止以时间为由降权或标注⚠️。

【个股公告 / 板块资讯】来自搜索结果，必须对照【今日日期】逐条判断距今天数，再填 weight：
  · 0-7 天   → weight: 1   → 全权重，不加任何前缀
  · 7-30 天  → weight: 0.5 → 半权重，detail 开头必须加⚠️[仅供参考]
  · 30 天以上 → weight: 0   → 不计分，detail 开头必须加⚠️[过期，未计分]
  ⚠️ 严禁把 7 天以上的搜索结果填 weight=1，这是最常见错误。
  ⚠️ 严禁把 7 天以内的搜索结果填 weight=0.5，同样是错误。
  例：今日 03-10，某消息日期 03-06 → 距今 4 天 → weight=1，不加任何前缀
  例：今日 03-10，某消息日期 02-27 → 距今 11 天 → weight=0.5，必须加⚠️[仅供参考]
sell_score / buy_score = 对应方向所有信号的 weight 之和，可以是小数（如 2.5）。

以上三项及 key_signals 只能来自客观市场数据（技术指标、大盘、资金、公告、板块）。
严禁将持仓成本、买入价、浮盈亏、仓位等用户个人信息用于评分或列入 key_signals。
上述个人信息只能出现在 note 字段做状态说明，不得影响任何分数计算。

只输出 JSON，不含任何其他文字：
{
  "stock_name":"名称","stock_code":"代码",
  "current_price":"现价（元）","price_change_today":"有AKShare数据时直接使用传入的price_change_today字段值，禁止用搜索结果覆盖；无数据时填今日涨跌幅如+1.2%",
  "action":"SELL_WAVE或WATCH_SELL或HOLD或WATCH_BUY或BUY_ADD",
  "risk_level":"低/中/偏高/高",
  "action_summary":"核心判断依据，40字内，只写原因不写操作",
  "sell_score":3,"buy_score":2,"net_score":-1,
  "key_signals":[{"layer":"日线或60min或大盘或资金或个股公告或板块资讯","type":"sell或buy","weight":1,"factor":"信号名","date":"搜索类信号填MM-DD，技术指标填null","detail":"用用户能看懂的语言描述信号内容。禁止出现：系统术语（趋势过滤、趋势过滤已激活、防卖飞、防死猫跳、Python评分等）；日线/60min/大盘/资金类weight固定1禁加⚠️；个股公告/板块资讯类按时效规则加⚠️"}],
  "recent_catalysts":[{"date":"MM-DD格式，如03-05；日期不明确时填null并在note字段开头加[日期不明，时效存疑]","title":"仅限7天内事件，超期不列入","impact":"positive或negative或neutral","note":"影响说明"}],
  "price_levels":{
    "support":"支撑位（元）","resistance":"压力位（元）","stop_loss":"止损参考（元）",
    "order_price":"建议挂单价（元）或null",
    "order_range":["下限","上限"],
    "order_note":"挂单区间说明，高风险时注明快速成交；A/B/D持仓状态下严禁出现接回/买回/补回等描述"
  },
  "sector_momentum":{
    "concept":"核心概念/板块名，如低空经济、AI算力",
    "trend":"升温或降温或横盘",
    "stock_vs_sector":"领涨或跟涨或滞涨或逆势下跌",
    "note":"板块共振简评，30字内"
  },
  "market_context":"大盘环境一句话",
  "smart_money_note":"主力资金/龙虎榜摘要",
  "long_term_flag":null,
  "long_term_view":"不评价用户长线判断对错。客观说近期市场对该方向的看法：资金是进是出、政策风向、板块情绪，100字内，用事实不用奉承",
  "position_state":"A或B或C或D（按上述四类判断结果填写）",
  "data_source":"akshare或web_search或mixed",
  "confidence":70,
  "note":"针对用户具体情况的补充提示，60字内，开头标注持仓状态。只写投资判断，禁止出现：任何字段名/变量名（net_score、recent_catalysts等）、对内部评分系统的描述（如'技术评分为0''机械评分''Python评分'等）、搜索结果的状态描述（如'近7天无公告''搜索显示'等）"
}`;

function stripCite(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, "$1")  // 带内容的 cite → 保留文字
    .replace(/<\/?cite[^>]*>/gi, "")                    // 残留空 cite 标签
    .trim();
}

// 对报告中所有文字字段批量清洗
function cleanReport(r) {
  if (!r) return r;
  const strFields = ["action_summary","market_context","smart_money_note","note","long_term_flag","long_term_view"];
  const cleaned = { ...r };
  strFields.forEach(f => { if (cleaned[f]) cleaned[f] = stripCite(cleaned[f]); });
  if (Array.isArray(cleaned.key_signals)) {
    cleaned.key_signals = cleaned.key_signals.map(s => ({ ...s, detail: stripCite(s.detail) }));
  }
  if (Array.isArray(cleaned.recent_catalysts)) {
    cleaned.recent_catalysts = cleaned.recent_catalysts.map(c => ({
      ...c, title: stripCite(c.title), note: stripCite(c.note),
    }));
  }
  return cleaned;
}

async function fetchAnalysis(stockName, stockCode, akData, userContext, onStatus) {
  const id     = stockCode ? `${stockName}（${stockCode}）` : stockName;
  const ctxLine = userContext?.trim() ? `\n\n【用户当前情况】${userContext.trim()}` : "";
  // 注入今日日期，让 AI 明确知道"7天内"的边界，避免把旧闻塞进 recent_catalysts
  const today = new Date().toLocaleDateString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit" });
  const dateLine = `\n\n【今日日期】${today}（recent_catalysts 只收录此日期往前7天内的事件；若搜索结果无7天内实质性事件，recent_catalysts 返回空数组 []，不得用旧闻填充）`;
  // 裁剪原始数据再发送，只保留 AI 需要的字段（去掉 K 线原始数组节省 token）
  const payload = akData ? buildAkPayload(akData) : null;
  const msg = payload
    ? `分析股票：${id}${ctxLine}${dateLine}\n\nAKShare本地数据：\n${payload}\n\n请同时搜索近期实质性事件（公告/业绩/异动），给出波段建议。`
    : `分析股票：${id}${ctxLine}${dateLine}，请搜索近期行情、公告和实质性事件，给出波段操作建议。`;
  return cleanReport(extractJSON(await runWithTools([{ role: "user", content: msg }], SYSTEM, onStatus)));
}

// ─── Config ───────────────────────────────────────────────────────────────────
const ACTION = {
  SELL_WAVE:  { label:"建议先抛",    sub:"短期下跌幅度可能超过5%", color:"#ff4757", bg:"rgba(255,71,87,0.09)",   border:"rgba(255,71,87,0.25)",  icon:"↓" },
  WATCH_SELL: { label:"留意下行风险", sub:"存在潜在风险，持续观察", color:"#ffa502", bg:"rgba(255,165,2,0.09)",  border:"rgba(255,165,2,0.25)",  icon:"⚠" },
  HOLD:       { label:"持有不动",    sub:"暂无明显波段信号",       color:"#636e72", bg:"rgba(99,110,114,0.09)", border:"rgba(99,110,114,0.2)",  icon:"—" },
  WATCH_BUY:  { label:"关注加仓机会", sub:"触底信号初现，等待确认", color:"#1e90ff", bg:"rgba(30,144,255,0.09)", border:"rgba(30,144,255,0.25)", icon:"△" },
  BUY_ADD:    { label:"可买入/加仓", sub:"阶段性触底信号较强",     color:"#2ed573", bg:"rgba(46,213,115,0.09)", border:"rgba(46,213,115,0.25)", icon:"↑" },
};
const LAYER_COLOR = { "日线":"#7f8c8d","60min":"#a29bfe","大盘":"#fd79a8","资金":"#00cec9","个股公告":"#f9ca24","板块资讯":"#e17055","停板":"#ff9f43" };
const IMPACT_DOT  = { positive:"#2ed573", negative:"#ff4757", neutral:"#4a6070" };

// 根据 action + risk_level + 价格结构 推算具体仓位建议
function buildPositionAdvice(action, riskLevel, ps, report) {
  const risk = riskLevel || "中";
  const c    = parseFloat(report?.current_price) || 0;
  const sup  = ps?.support  || report?.price_levels?.support;
  const sl   = ps?.stop_loss || report?.price_levels?.stop_loss;
  const posState = report?.position_state || "D";  // A持仓 B部分持仓 C已清仓 D未持仓

  const riskMap = { "低":0, "中":1, "偏高":2, "高":3 };
  const riskIdx = riskMap[risk] ?? 1;

  // D类（未持仓）：SELL方向对他们意味着"暂不建仓"，不给减仓建议
  if (posState === "D") {
    if (action === "SELL_WAVE") return {
      label: "暂不建仓", color: "#ff4757",
      bg: "rgba(255,71,87,0.06)", border: "rgba(255,71,87,0.2)",
      first: "当前信号偏空，暂时观望",
      followup: "等买入信号出现再考虑入场",
      stopNote: "",
      basis: "",
    };
    if (action === "WATCH_SELL") return {
      label: "观望为主", color: "#ffa502",
      bg: "rgba(255,165,2,0.06)", border: "rgba(255,165,2,0.2)",
      first: "下行风险未消，暂不建仓",
      followup: "持续观察，待风险明朗后再入场",
      stopNote: "",
      basis: "",
    };
  }

  if (action === "BUY_ADD") {
    const batches = [
      ["40-50%仓","20-30%仓","20%仓","10-15%仓"],
      ["余量分2批加","余量分2批加","确认后再加10-20%","确认趋势后轻仓补"],
    ];
    return {
      label: "建议分批买入", color: "#1e90ff",
      bg: "rgba(30,144,255,0.06)", border: "rgba(30,144,255,0.2)",
      first:    batches[0][riskIdx],
      followup: batches[1][riskIdx],
      stopNote: sl ? `以 ${sl} 元为硬止损，跌破止损及时离场` : "注意设置止损",
      basis: `支撑位参考 ${sup} 元`,
    };
  }
  if (action === "WATCH_BUY") {
    const sizes = ["20-30%仓","15-20%仓","10-15%仓","5-10%仓"];
    return {
      label: "可小仓试探", color: "#2ed573",
      bg: "rgba(46,213,115,0.06)", border: "rgba(46,213,115,0.2)",
      first:    sizes[riskIdx],
      followup: "等信号确认后分批加仓",
      stopNote: sl ? `以 ${sl} 元为硬止损` : "注意设置止损",
      basis: `支撑位参考 ${sup} 元`,
    };
  }
  if (action === "SELL_WAVE") {
    const sizes = ["减至20-30%仓","减至10-20%仓","减至5-10%仓","清仓观望"];
    return {
      label: "建议减仓", color: "#ff4757",
      bg: "rgba(255,71,87,0.06)", border: "rgba(255,71,87,0.2)",
      first:    sizes[riskIdx],
      followup: "等买入信号再分批接回",
      stopNote: "减仓后若继续拉升勿追，等回调再加",
      basis: "",
    };
  }
  if (action === "WATCH_SELL") {
    const sizes = ["减至50-60%仓","减至30-40%仓","减至20-30%仓","减至10-20%仓"];
    return {
      label: "可先减部分仓", color: "#ffa502",
      bg: "rgba(255,165,2,0.06)", border: "rgba(255,165,2,0.2)",
      first:    sizes[riskIdx],
      followup: "观察信号变化，信号转强再加回",
      stopNote: sl ? `跌破 ${sl} 元则加速减仓` : "注意下行止损",
      basis: "",
    };
  }
  return null;  // HOLD 不给仓位建议
}
function ScoreBar({ value, color, label, max=10 }) {
  return (
    <div>
      <div style={{ fontSize:10, color, fontWeight:700, letterSpacing:"0.07em", marginBottom:7 }}>{label}</div>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ flex:1, height:4, background:"rgba(255,255,255,0.06)", borderRadius:2, overflow:"hidden" }}>
          <div style={{ width:`${Math.min(Math.abs(value)/max*100,100)}%`, height:"100%", background:color, borderRadius:2, transition:"width 0.9s ease" }} />
        </div>
        <span style={{ fontSize:11, color, fontFamily:"monospace", minWidth:36 }}>{value}/{max}</span>
      </div>
    </div>
  );
}

function PLevel({ label, value, color, big }) {
  return (
    <div style={{ flex:1, minWidth:big?140:85, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:10, padding:"9px 13px" }}>
      <div style={{ fontSize:10, color:"#283a50", marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:big?15:13, fontWeight:700, color:color||"#90b0c8", fontFamily:"monospace" }}>{value||"—"}</div>
    </div>
  );
}

function Shimmer({ w="100%", h=11, mb=9 }) {
  return <div style={{ width:w, height:h, marginBottom:mb, borderRadius:4, background:"linear-gradient(90deg,#0d1520 25%,#131e2c 50%,#0d1520 75%)", backgroundSize:"200% 100%", animation:"shimmer 1.4s infinite" }} />;
}

// ─── Drop zone（独立，无输入框）─────────────────────────────────────────────
function DropZone({ onFile, fileName, onClear }) {
  const [drag, setDrag] = useState(false);

  const readFile = useCallback(f => {
    const r = new FileReader();
    r.onload = e => onFile(e.target.result, f.name);
    r.readAsText(f, "utf-8");
  }, [onFile]);

  const onDrop = useCallback(e => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  }, [readFile]);

  if (fileName) {
    return (
      <div style={{ background:"rgba(30,144,255,0.06)", border:"1px solid rgba(30,144,255,0.2)", borderRadius:10, padding:"10px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:18 }}>📄</span>
          <div>
            <div style={{ fontSize:12, color:"#1e90ff", fontWeight:600 }}>{fileName}</div>
            <div style={{ fontSize:10, color:"#2a4a6a" }}>已载入本地数据，股票信息已自动读取</div>
          </div>
        </div>
        <button onClick={onClear} style={{ background:"rgba(255,71,87,0.1)", border:"1px solid rgba(255,71,87,0.25)", borderRadius:7, padding:"5px 12px", color:"#ff4757", fontSize:12, fontWeight:600, cursor:"pointer" }}>
          清空
        </button>
      </div>
    );
  }

  return (
    <div
      onDrop={onDrop}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      style={{ border:`1px dashed ${drag?"rgba(30,144,255,0.6)":"rgba(255,255,255,0.1)"}`, borderRadius:10, padding:"16px", background:drag?"rgba(30,144,255,0.05)":"rgba(255,255,255,0.02)", transition:"all .2s", textAlign:"center" }}
    >
      <div style={{ fontSize:22, marginBottom:6, opacity:.35 }}>📂</div>
      <div style={{ fontSize:12, color:"#2a4060", marginBottom:8 }}>拖拽 JSON 文件到这里，或</div>
      <label style={{ display:"inline-block", fontSize:12, color:"#1e90ff", background:"rgba(30,144,255,0.1)", border:"1px solid rgba(30,144,255,0.25)", borderRadius:7, padding:"5px 14px", cursor:"pointer" }}>
        点击选择文件
        <input type="file" accept=".json,.txt" onChange={e => e.target.files[0] && readFile(e.target.files[0])} style={{ display:"none" }} />
      </label>
      <div style={{ fontSize:10, color:"#1a2e40", marginTop:8 }}>
        python stock.py → 输出 JSON 文件 → 拖入这里
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function App() {
  // 文件模式
  const [akData,       setAkData]       = useState("");
  const [fileName,     setFileName]     = useState("");
  const [fileMeta,     setFileMeta]     = useState(null);   // { stock_name, stock_code }
  const [priceStructure, setPriceStructure] = useState(null); // Python 精确算出的价格点位，防 AI 数字幻觉

  // 无文件模式
  const [query,     setQuery]     = useState("");
  const [looking,   setLooking]   = useState(false);  // 正在查找
  const [lookResult,setLookResult]= useState(null);   // { stock_name, stock_code, exchange }
  const [lookError, setLookError] = useState(null);

  // 分析
  const [loading,     setLoading]     = useState(false);
  const [msg,         setMsg]         = useState("");
  const [report,      setReport]      = useState(null);
  const [error,       setError]       = useState(null);
  const [userContext, setUserContext] = useState("");
  const [copyDone,    setCopyDone]    = useState(false);

  // 分析
  const handleAnalyze = async (stockName, stockCode) => {
    setLoading(true); setError(null); setReport(null);
    setMsg("深度思考中…");
    try {
      setReport(await fetchAnalysis(stockName, stockCode, akData, userContext, setMsg));
    } catch(e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const hasFile = !!fileName;

  // 处理文件载入
  const handleFile = useCallback((text, name) => {
    setAkData(text);
    setFileName(name);
    setReport(null); setError(null); setLookResult(null);
    try {
      const stripped = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
      // Python/pandas 生成的 JSON 可能含 NaN，不符合 JSON 规范，替换为 null
      const clean = stripped.replace(/:\s*NaN\b/g, ": null");
      const parsed = JSON.parse(clean);
      const meta = parsed?.meta;
      if (meta?.stock_name && meta?.stock_code) {
        setFileMeta({ stock_name: meta.stock_name, stock_code: meta.stock_code });
      } else {
        setFileMeta(null);
      }
      setPriceStructure(parsed?.price_structure || null);
    } catch {
      setFileMeta(null);
     
      setPriceStructure(null);
    }
  }, []);

  const clearFile = () => {
    setAkData(""); setFileName(""); setFileMeta(null);
    setReport(null); setError(null); setPriceStructure(null);
  };

  // 无文件模式：第一步查找
  const handleLookup = async () => {
    if (!query.trim() || looking) return;
    setLooking(true); setLookError(null); setLookResult(null); setReport(null); setError(null);
    try {
      const r = await lookupStock(query.trim());
      setLookResult(r);
    } catch(e) {
      setLookError(e.message);
    } finally {
      setLooking(false);
    }
  };

  const act = report ? (ACTION[report.action] || null) : null;
  const unknownAction = report && !ACTION[report.action];
  const changePos = report?.price_change_today &&
    !String(report.price_change_today).startsWith("-") &&
    report.price_change_today !== "暂无";
  // 预计算仓位建议：渲染卡片和复制报告都用同一份，避免重复运算
  const positionAdvice = report
    ? buildPositionAdvice(report.action, report.risk_level, priceStructure, report)
    : null;

  return (
    <div style={{ minHeight:"100vh", background:"#070c15", fontFamily:"'DM Sans','PingFang SC','Noto Sans SC',sans-serif", display:"flex", flexDirection:"column", alignItems:"center", padding:"36px 16px 72px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
        *{box-sizing:border-box} input,textarea{outline:none;font-family:inherit}
        input::placeholder{color:#1a2e40}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:#162030;border-radius:2px}
      `}</style>

      {/* Header */}
      <div style={{ textAlign:"center", marginBottom:32, animation:"fadeUp .5s ease" }}>
        <div style={{ display:"inline-flex", alignItems:"center", gap:7, background:"rgba(30,144,255,0.07)", border:"1px solid rgba(30,144,255,0.15)", borderRadius:20, padding:"4px 14px", marginBottom:14 }}>
          <span style={{ width:5, height:5, borderRadius:"50%", background:"#1e90ff", display:"inline-block", animation:"blink 2s infinite" }} />
          <span style={{ fontSize:10, color:"#1e90ff", fontWeight:700, letterSpacing:"0.1em" }}>SONNET 4.6 · EXTENDED THINKING · WEB SEARCH</span>
        </div>
        <h1 style={{ margin:0, fontSize:"clamp(22px,5vw,34px)", fontWeight:700, letterSpacing:"-0.02em", background:"linear-gradient(135deg,#dde8f8,#5a90c0)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>A股波段时机判断</h1>
        <p style={{ margin:"8px 0 0", color:"#253545", fontSize:13 }}>长线持股 · 只告诉你：该抛、该加仓、还是不动 · <span style={{ color:"#3a7aaa" }}>{new Date().toLocaleDateString("zh-CN",{year:"numeric",month:"long",day:"numeric"})}</span></p>
      </div>

      {/* ── 输入区 ── */}
      <div style={{ width:"100%", maxWidth:560, marginBottom:24, animation:"fadeUp .5s ease .05s both" }}>

        {/* 文件模式 */}
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11, color:"#2a4555", marginBottom:7, letterSpacing:"0.04em" }}>
            📊 上传 AKShare 数据（含技术指标+主力资金，精度更高）
          </div>
          <DropZone onFile={handleFile} fileName={fileName} onClear={clearFile} />
        </div>

        {/* 文件模式：显示读到的股票 + 分析按钮 */}
        {hasFile && (
          <div style={{ animation:"fadeUp .3s ease" }}>
            {fileMeta ? (
              <div style={{ background:"rgba(46,213,115,0.07)", border:"1px solid rgba(46,213,115,0.2)", borderRadius:12, padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:11, color:"#2a5040" }}>读取到股票</span>
                  <span style={{ fontSize:15, fontWeight:700, color:"#2ed573" }}>{fileMeta.stock_name}</span>
                  <span style={{ fontSize:11, fontFamily:"monospace", color:"#fff", background:"rgba(46,213,115,0.2)", border:"1px solid rgba(46,213,115,0.3)", borderRadius:5, padding:"1px 8px" }}>{fileMeta.stock_code}</span>
                </div>
                <button
                  onClick={() => handleAnalyze(fileMeta.stock_name, fileMeta.stock_code)}
                  disabled={loading}
                  style={{ background:loading?"rgba(30,144,255,.1)":"linear-gradient(135deg,#1e90ff,#0050bb)", border:"none", borderRadius:10, padding:"9px 20px", color:loading?"#1e90ff":"#fff", fontSize:13, fontWeight:600, cursor:loading?"default":"pointer", whiteSpace:"nowrap" }}
                >
                  {loading
                    ? <span style={{ display:"flex", alignItems:"center", gap:7 }}>
                        <span style={{ width:11, height:11, border:"2px solid #1e90ff", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin .7s linear infinite" }} />
                        分析中
                      </span>
                    : "开始分析"}
                </button>
              </div>
            ) : (
              <div style={{ background:"rgba(255,165,2,0.07)", border:"1px solid rgba(255,165,2,0.2)", borderRadius:12, padding:"10px 14px", fontSize:12, color:"#ffa502" }}>
                ⚠ 文件中未找到 meta.stock_name，请在下方手动输入股票名称
              </div>
            )}
          </div>
        )}

        {/* 无文件模式 或 文件没有meta时：手动输入 + 两步确认 */}
        {(!hasFile || !fileMeta) && (
          <div style={{ marginTop: hasFile ? 12 : 0, animation:"fadeUp .3s ease" }}>
            {!hasFile && <div style={{ fontSize:11, color:"#2a4555", marginBottom:7, letterSpacing:"0.04em" }}>🔍 或直接输入股票名称，AI 自动查找确认</div>}
            <div style={{ display:"flex", gap:10 }}>
              <input
                value={query}
                onChange={e => { setQuery(e.target.value); setLookResult(null); setLookError(null); }}
                onKeyDown={e => e.key==="Enter" && handleLookup()}
                placeholder="股票名称或代码，如：宁德时代"
                style={{ flex:1, background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:"13px 16px", color:"#a0c0d8", fontSize:14, transition:"border-color .2s" }}
                onFocus={e => e.target.style.borderColor="rgba(30,144,255,.4)"}
                onBlur={e  => e.target.style.borderColor="rgba(255,255,255,.08)"}
              />
              <button
                onClick={handleLookup}
                disabled={looking || !query.trim()}
                style={{ background:looking?"rgba(30,144,255,.1)":"rgba(30,144,255,0.15)", border:"1px solid rgba(30,144,255,0.3)", borderRadius:12, padding:"13px 20px", color:"#1e90ff", fontSize:14, fontWeight:600, cursor:looking||!query.trim()?"default":"pointer", opacity:!query.trim()&&!looking?.4:1, whiteSpace:"nowrap", transition:"all .2s" }}
              >
                {looking
                  ? <span style={{ display:"flex", alignItems:"center", gap:7 }}>
                      <span style={{ width:12, height:12, border:"2px solid #1e90ff", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin .7s linear infinite" }} />
                      查找中
                    </span>
                  : "查找"}
              </button>
            </div>

            {/* 查找错误 */}
            {lookError && (
              <div style={{ marginTop:10, background:"rgba(255,71,87,0.07)", border:"1px solid rgba(255,71,87,0.2)", borderRadius:10, padding:"10px 14px", fontSize:12, color:"#ff6070", animation:"fadeUp .3s ease" }}>
                {lookError}
              </div>
            )}

            {/* 确认卡片 */}
            {lookResult && !lookError && (
              <div style={{ marginTop:10, background:"rgba(46,213,115,0.07)", border:"1px solid rgba(46,213,115,0.22)", borderRadius:12, padding:"14px 16px", animation:"fadeUp .3s ease" }}>
                <div style={{ fontSize:11, color:"#2a5040", marginBottom:10 }}>找到以下股票，确认是这只吗？</div>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
                  <span style={{ fontSize:18, fontWeight:700, color:"#2ed573" }}>{lookResult.stock_name}</span>
                  <span style={{ fontSize:12, fontFamily:"monospace", color:"#fff", background:"rgba(46,213,115,0.2)", border:"1px solid rgba(46,213,115,0.3)", borderRadius:5, padding:"2px 10px" }}>{lookResult.stock_code}</span>
                  <span style={{ fontSize:11, color:"#2a5040" }}>{lookResult.exchange}</span>
                </div>
                <div style={{ display:"flex", gap:10 }}>
                  <button
                    onClick={() => handleAnalyze(lookResult.stock_name, lookResult.stock_code)}
                    disabled={loading}
                    style={{ flex:1, background:loading?"rgba(30,144,255,.1)":"linear-gradient(135deg,#1e90ff,#0050bb)", border:"none", borderRadius:10, padding:"10px", color:loading?"#1e90ff":"#fff", fontSize:13, fontWeight:600, cursor:loading?"default":"pointer" }}
                  >
                    {loading
                      ? <span style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:7 }}>
                          <span style={{ width:11, height:11, border:"2px solid #1e90ff", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin .7s linear infinite" }} />
                          分析中
                        </span>
                      : "✓ 确认，开始分析"}
                  </button>
                  <button
                    onClick={() => { setLookResult(null); setQuery(""); }}
                    style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"10px 16px", color:"#5a7080", fontSize:13, cursor:"pointer" }}
                  >
                    不对，重输
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {/* 当前情况输入（可选）*/}
        <div style={{ marginTop:14, background:"rgba(255,165,2,0.04)", border:"1px solid rgba(255,165,2,0.12)", borderRadius:12, padding:"12px 14px" }}>
          <div style={{ fontSize:11, color:"#b07820", fontWeight:700, marginBottom:6, letterSpacing:"0.04em" }}>
            💬 你的持仓情况 <span style={{ fontWeight:400, color:"#6a5020" }}>（选填，填了分析更准）</span>
          </div>
          <textarea
            value={userContext}
            onChange={e => setUserContext(e.target.value)}
            placeholder={"例：上周62块抛了一半，现在空仓等接回\n或：满仓持有，成本55，想知道要不要先减一减"}
            rows={2}
            style={{ width:"100%", background:"rgba(0,0,0,0.15)", border:"1px solid rgba(255,165,2,0.18)", borderRadius:8, padding:"10px 12px", color:"#c0a060", fontSize:13, lineHeight:1.6, resize:"vertical", transition:"border-color .2s" }}
            onFocus={e => e.target.style.borderColor="rgba(255,165,2,.5)"}
            onBlur={e  => e.target.style.borderColor="rgba(255,165,2,.18)"}
          />
        </div>
      </div>
      <div style={{ width:"100%", maxWidth:640 }}>

        {/* Loading */}
        {loading && (
          <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:16, padding:"22px 26px", animation:"fadeUp .3s ease" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:18, color:"#2a4050", fontSize:12 }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background:"#1e90ff", display:"inline-block", animation:"blink 1s infinite" }} />
              {msg}
            </div>
            {[100,70,90,55,80,60,45].map((w,i) => <Shimmer key={i} w={`${w}%`} />)}
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div style={{ background:"rgba(255,71,87,0.05)", border:"1px solid rgba(255,71,87,0.2)", borderRadius:14, padding:"16px 20px", color:"#ff6070", fontSize:13, animation:"fadeUp .3s ease", lineHeight:1.7 }}>
            <strong>分析失败</strong><br />{error}
          </div>
        )}

        {/* Report */}
        {report && !loading && (() => {
          return (
            <div style={{ animation:"fadeUp .4s ease" }}>

              {/* 股票确认条 */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, background:"rgba(30,144,255,0.06)", border:"1px solid rgba(30,144,255,0.18)", borderRadius:12, padding:"10px 16px", marginBottom:14 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:11, color:"#2a4a6a" }}>分析完成</span>
                  <span style={{ fontSize:15, fontWeight:700, color:"#5aafff" }}>{report.stock_name}</span>
                  <span style={{ fontSize:11, fontFamily:"monospace", color:"#fff", background:"rgba(30,144,255,0.2)", border:"1px solid rgba(30,144,255,0.3)", borderRadius:5, padding:"1px 8px" }}>{report.stock_code}</span>
                </div>
                <span style={{ fontSize:11, color:"#1e3050" }}>
                  {hasFile ? "📊 数据来自本地文件" : "🔍 数据来自 AI 搜索"}
                </span>
              </div>

              {/* ⚠ action 匹配失败警告——优先于一切显示 */}
              {unknownAction && (
                <div style={{ background:"rgba(255,71,87,0.12)", border:"2px solid rgba(255,71,87,0.6)", borderRadius:12, padding:"14px 18px", marginBottom:14, display:"flex", gap:12, alignItems:"flex-start" }}>
                  <span style={{ fontSize:20, lineHeight:1 }}>🚨</span>
                  <div>
                    <div style={{ fontSize:13, fontWeight:700, color:"#ff4757", marginBottom:4 }}>
                      AI 返回了未知的操作指令："{report.action}"
                    </div>
                    <div style={{ fontSize:12, color:"#cc3040", lineHeight:1.7 }}>
                      系统无法识别该指令，已拒绝自动解析。请检查 AI 原始输出，结合 action_summary 自行判断操作方向。<br />
                      <strong>切勿将此结果作为操作依据。</strong>
                    </div>
                  </div>
                </div>
              )}

              {/* 后续卡片仅在 action 可识别时渲染 */}
              {act && (<>

                {/* Long-term flag - 只在内容有意义时显示，过滤AI乱码 */}
                {report.long_term_flag &&
                 typeof report.long_term_flag === "string" &&
                 report.long_term_flag.length > 5 &&
                 !/[(){}\[\]]/.test(report.long_term_flag) && (
                  <div style={{ background:"rgba(255,71,87,0.07)", border:"1px solid rgba(255,71,87,0.28)", borderRadius:12, padding:"12px 16px", marginBottom:14, display:"flex", gap:10 }}>
                    <span style={{ fontSize:16 }}>🚨</span>
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, color:"#ff4757", marginBottom:3 }}>长线风险警示</div>
                      <div style={{ fontSize:12, color:"#cc5060", lineHeight:1.6 }}>{report.long_term_flag}</div>
                    </div>
                  </div>
                )}

              {/* Action card */}
              <div style={{ background:act.bg, border:`1px solid ${act.border}`, borderRadius:16, padding:"22px 26px", marginBottom:14 }}>
                <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:14, marginBottom:16 }}>
                  <div>
                    <div style={{ display:"flex", alignItems:"baseline", gap:10, flexWrap:"wrap", marginBottom:6 }}>
                      <span style={{ fontSize:21, fontWeight:700, color:"#b8d0e8" }}>{report.stock_name}</span>
                      <span style={{ fontSize:12, color:"#2a4060", fontFamily:"monospace" }}>{report.stock_code}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ fontSize:20, fontWeight:700, color:"#c8dff0", fontFamily:"monospace" }}>{report.current_price}</span>
                      <span style={{ fontSize:13, fontWeight:600, color:report.price_change_today==="暂无"?"#3a5070":changePos?"#2ed573":"#ff4757" }}>{report.price_change_today}</span>
                      {report.risk_level && <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:5, background:"rgba(255,255,255,0.06)", color:"#7a9ab0" }}>风险：{report.risk_level}</span>}
                    </div>
                  </div>
                  <div style={{ background:"rgba(0,0,0,0.2)", border:`1px solid ${act.border}`, borderRadius:14, padding:"12px 20px", textAlign:"center", minWidth:108 }}>
                    <div style={{ fontSize:26, color:act.color, lineHeight:1 }}>{act.icon}</div>
                    <div style={{ fontSize:14, fontWeight:700, color:act.color, margin:"4px 0 2px" }}>{act.label}</div>
                    <div style={{ fontSize:10, color:act.color, opacity:.65 }}>{act.sub}</div>
                  </div>
                </div>
                <div style={{ fontSize:13, color:act.color, background:"rgba(0,0,0,0.15)", borderRadius:8, padding:"10px 14px", lineHeight:1.65, marginBottom:report.price_levels?.order_note&&report.action!=="HOLD"?10:0 }}>
                  {report.action_summary}
                </div>
                {report.price_levels?.order_note && report.action !== "HOLD" && (
                  <div style={{ fontSize:12, color:"#5a8090", background:"rgba(0,0,0,0.1)", borderRadius:8, padding:"9px 14px", lineHeight:1.6 }}>
                    📌 {report.price_levels.order_note}
                  </div>
                )}
              </div>


              {/* Scores + levels */}
              <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:16, padding:"20px 24px", marginBottom:14 }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:18, marginBottom:18 }}>
                  {(() => {
                    const scoreMax = Math.max(report.sell_score||0, report.buy_score||0, 10);
                    return (<>
                      <ScoreBar value={report.sell_score||0} color="#ff4757" label="↓ 卖出压力" max={scoreMax} />
                      <ScoreBar value={report.buy_score||0}  color="#1e90ff" label="↑ 买入机会" max={scoreMax} />
                    </>);
                  })()}
                </div>
                <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                  {/* 优先使用 Python 精确算出的 priceStructure，防止 AI 数字幻觉 */}
                  {(() => {
                    const ps  = priceStructure;
                    const ai  = report.price_levels;
                    const sup = ps?.support    ?? ai?.support;
                    const res = ps?.resistance ?? ai?.resistance;
                    const sl  = ps?.stop_loss  ?? ai?.stop_loss;
                    const posState = report?.position_state || "D";
                    const isBuyAction  = ["BUY_ADD","WATCH_BUY"].includes(report.action);
                    const isSellAction = ["SELL_WAVE","WATCH_SELL"].includes(report.action);
                    // C类已清仓：Python的order_price可能是按卖出方向算的（高于现价），对用户无意义
                    // 无论AI把action升级成什么，只要order_price>现价就强制切换为接回参考价
                    const curPrice = parseFloat(ps?.current_price || report?.current_price || 0);
                    const rawOp = ps?.order_price ?? ai?.order_price;
                    const isClearSell = posState === "C" && (isSellAction || (rawOp != null && parseFloat(rawOp) > curPrice * 1.002));
                    let op = (!isClearSell && rawOp != null) ? rawOp : null;
                    if (op == null && ps) {
                      const approxAtr = ((ps.high_20d || 0) - (ps.low_20d || 0)) / 20;
                      if (isClearSell) {
                        // 已清仓等回调：接回参考价锚定支撑位
                        const base = parseFloat(sup);
                        if (base && approxAtr) {
                          const offset = Math.min(Math.max(approxAtr * 0.2, base * 0.002), base * 0.010);
                          op = Math.round((base - offset) * 100) / 100;
                        }
                      } else if (isBuyAction || isSellAction) {
                        const base = isBuyAction ? parseFloat(sup) : parseFloat(ps.current_price || res);
                        if (base && approxAtr) {
                          const offset = Math.min(Math.max(approxAtr * 0.3, base * 0.002), base * (isBuyAction ? 0.015 : 0.010));
                          op = Math.round((isSellAction ? base + offset : base - offset) * 100) / 100;
                        }
                      }
                    }
                    const src = ps ? "📊" : "🤖";
                    const opLabel = isClearSell ? `接回参考价 ${src}` : `建议挂单价 ${src}`;
                    const slLabel = posState === "C" ? `接回止损参考 ${src}` : `减仓止损参考 ${src}`;
                    return (<>
                      <PLevel label={`支撑位 ${src}`} value={sup} color="#2ed573" />
                      <PLevel label={`压力位 ${src}`} value={res} color="#ff4757" />
                      {report.action !== "HOLD" && <PLevel label={opLabel} value={op} color="#1e90ff" big />}
                      <PLevel label={slLabel} value={sl} color="#ffa502" />
                    </>);
                  })()}
                </div>
              </div>

              {/* Signals */}
              {report.key_signals?.length > 0 && (
                <div style={{ background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:16, padding:"18px 22px", marginBottom:14 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#2a4555", letterSpacing:"0.1em", marginBottom:12, textTransform:"uppercase" }}>技术信号明细</div>
                  {report.key_signals.map((s,i) => {
                    const w = s.weight ?? 1;
                    const dimmed = w < 1;
                    const trendFiltered = !!s.trend_filtered;
                    const weightTag = w === 0 ? "未计分" : w < 1 ? "半权重" : null;
                    const weightTagColor = w === 0 ? "#3a4a55" : "#5a6a40";
                    // detail 里的趋势过滤括号说明已由标签承载，渲染时去掉避免重复
                    const cleanDetail = (s.detail || "").replace(/（(强势上涨中|持续下跌中)[^）]*）/g, "").trim();
                    return (
                      <div key={i} style={{ display:"flex", gap:10, padding:"8px 0", alignItems:"flex-start", borderBottom:i<report.key_signals.length-1?"1px solid rgba(255,255,255,0.04)":"none", opacity:dimmed ? 0.4 + w*0.25 : 1 }}>
                        <div style={{ flexShrink:0, marginTop:3, fontSize:10, fontWeight:700, color:dimmed?"#4a5a60":LAYER_COLOR[s.layer]||"#7f8c8d", background:"rgba(255,255,255,0.05)", borderRadius:4, padding:"1px 6px", whiteSpace:"nowrap" }}>{s.layer}</div>
                        <div style={{ flexShrink:0, marginTop:3, width:16, height:16, borderRadius:4, background:dimmed?"rgba(255,255,255,0.05)":s.type==="sell"?"rgba(255,71,87,0.1)":s.type==="halt"?"rgba(255,159,67,0.1)":"rgba(30,144,255,0.1)", border:`1px solid ${dimmed?"rgba(255,255,255,0.1)":s.type==="sell"?"rgba(255,71,87,0.3)":s.type==="halt"?"rgba(255,159,67,0.3)":"rgba(30,144,255,0.3)"}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, color:dimmed?"#4a5a60":s.type==="sell"?"#ff4757":s.type==="halt"?"#ff9f43":"#1e90ff", fontWeight:700 }}>{s.type==="sell"?"↓":s.type==="halt"?"⊘":"↑"}</div>
                        <div style={{ flex:1 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                            <span style={{ fontSize:12, color:dimmed?"#3a4a50":s.type==="sell"?"#ff7a8a":s.type==="halt"?"#ff9f43":"#5aafff", fontWeight:600 }}>{s.factor}</span>
                            {weightTag && <span style={{ fontSize:9, color:weightTagColor, background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:3, padding:"0 5px", letterSpacing:"0.04em" }}>{weightTag}</span>}
                            {trendFiltered && <span style={{ fontSize:9, color:"#e17055", background:"rgba(225,112,85,0.08)", border:"1px solid rgba(225,112,85,0.25)", borderRadius:3, padding:"0 5px", letterSpacing:"0.04em" }}>趋势降权</span>}
                          </div>
                          <div style={{ fontSize:12, color:dimmed?"#3a4a50":"#5a7080", lineHeight:1.6 }}>{cleanDetail}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 板块共振 */}
              {report.sector_momentum?.concept && (
                <div style={{ background:"rgba(162,155,254,0.06)", border:"1px solid rgba(162,155,254,0.18)", borderRadius:12, padding:"13px 16px", marginBottom:14 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#a29bfe", letterSpacing:"0.08em", marginBottom:8 }}>板块共振</div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", marginBottom:6 }}>
                    <span style={{ fontSize:12, fontWeight:600, color:"#c8b8ff" }}>{report.sector_momentum.concept}</span>
                    {report.sector_momentum.trend && (
                      <span style={{ fontSize:11, padding:"2px 8px", borderRadius:5,
                        background: report.sector_momentum.trend==="升温"?"rgba(46,213,115,0.12)":report.sector_momentum.trend==="降温"?"rgba(255,71,87,0.12)":"rgba(255,255,255,0.05)",
                        color:       report.sector_momentum.trend==="升温"?"#2ed573":report.sector_momentum.trend==="降温"?"#ff6b7a":"#7090a0"
                      }}>板块{report.sector_momentum.trend}</span>
                    )}
                    {report.sector_momentum.stock_vs_sector && (
                      <span style={{ fontSize:11, color:"#6a8090" }}>个股：{report.sector_momentum.stock_vs_sector}</span>
                    )}
                  </div>
                  {report.sector_momentum.note && (
                    <div style={{ fontSize:12, color:"#6a7090", lineHeight:1.6 }}>{report.sector_momentum.note}</div>
                  )}
                </div>
              )}

              {/* Market + smart money */}
              {(report.market_context || report.smart_money_note) && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
                  {report.market_context && (
                    <div style={{ background:"rgba(253,121,168,0.06)", border:"1px solid rgba(253,121,168,0.15)", borderRadius:12, padding:"12px 14px" }}>
                      <div style={{ fontSize:10, color:"#fd79a8", fontWeight:700, marginBottom:6 }}>大盘环境</div>
                      <div style={{ fontSize:12, color:"#7a7090", lineHeight:1.6 }}>{report.market_context}</div>
                    </div>
                  )}
                  {report.smart_money_note && (
                    <div style={{ background:"rgba(0,206,201,0.06)", border:"1px solid rgba(0,206,201,0.15)", borderRadius:12, padding:"12px 14px" }}>
                      <div style={{ fontSize:10, color:"#00cec9", fontWeight:700, marginBottom:6 }}>主力资金</div>
                      <div style={{ fontSize:12, color:"#507070", lineHeight:1.6 }}>{report.smart_money_note}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Catalysts */}
              {report.recent_catalysts?.length > 0 && (
                <div style={{ background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:16, padding:"18px 22px", marginBottom:14 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#2a4555", letterSpacing:"0.1em", marginBottom:12, textTransform:"uppercase" }}>近期催化剂</div>
                  {report.recent_catalysts.map((n,i) => {
                    const stale = n.title && n.title.startsWith("⚠️");
                    return (
                      <div key={i} style={{ display:"flex", gap:10, padding:"8px 0", alignItems:"flex-start", borderBottom:i<report.recent_catalysts.length-1?"1px solid rgba(255,255,255,0.04)":"none", opacity:stale?0.45:1 }}>
                        <span style={{ width:5, height:5, borderRadius:"50%", background:stale?"#3a4550":IMPACT_DOT[n.impact]||"#3a5070", marginTop:6, flexShrink:0 }} />
                        <div>
                          <div style={{ fontSize:12, color:stale?"#3a4a55":"#8098b0", fontWeight:500 }}>{n.title}</div>
                          <div style={{ fontSize:11, color:stale?"#2a3840":"#3a5060", marginTop:2 }}>{n.note}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 仓位建议 */}
              {(() => {
                const adv = positionAdvice;
                if (!adv) return null;
                return (
                  <div style={{ background:adv.bg, border:`1px solid ${adv.border}`, borderRadius:12, padding:"14px 16px", marginBottom:14 }}>
                    <div style={{ fontSize:10, fontWeight:700, color:adv.color, letterSpacing:"0.08em", marginBottom:10, textTransform:"uppercase" }}>仓位操作建议</div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:8 }}>
                      <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 12px", flex:1, minWidth:140 }}>
                        <div style={{ fontSize:10, color:"#3a5570", marginBottom:3 }}>首批操作</div>
                        <div style={{ fontSize:14, fontWeight:700, color:adv.color }}>{adv.first}</div>
                      </div>
                      <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 12px", flex:1, minWidth:140 }}>
                        <div style={{ fontSize:10, color:"#3a5570", marginBottom:3 }}>后续操作</div>
                        <div style={{ fontSize:13, color:"#7090a0" }}>{adv.followup}</div>
                      </div>
                    </div>
                    <div style={{ fontSize:11, color:"#4a6070", lineHeight:1.6 }}>
                      {adv.stopNote}{adv.basis ? `  ·  ${adv.basis}` : ""}
                    </div>
                  </div>
                );
              })()}

              {/* 综合提示（针对用户具体情况） */}
              {report.note && (
                <div style={{ background:"rgba(90,175,255,0.06)", border:"1px solid rgba(90,175,255,0.22)", borderRadius:14, padding:"16px 20px", marginBottom:14 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#3a80b0", letterSpacing:"0.08em", marginBottom:8, textTransform:"uppercase" }}>📌 综合提示</div>
                  <div style={{ fontSize:14, color:"#8ac8f0", lineHeight:1.75 }}>{report.note}</div>
                </div>
              )}

              {/* 长线看法 */}
              {report.long_term_view && (
                <div style={{ background:"rgba(162,155,254,0.06)", border:"1px solid rgba(162,155,254,0.2)", borderRadius:14, padding:"16px 20px", marginBottom:14 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#a29bfe", letterSpacing:"0.08em", marginBottom:8, textTransform:"uppercase" }}>🔭 长线看法</div>
                  <div style={{ fontSize:13, color:"#c0b0ff", lineHeight:1.8 }}>{report.long_term_view}</div>
                </div>
              )}

              {/* Footer */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8, padding:"0 2px", marginBottom:10 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, flex:1, minWidth:180 }}>
                  <span style={{ fontSize:11, color:"#1e3040", whiteSpace:"nowrap" }}>分析置信度</span>
                  <div style={{ flex:1, height:4, background:"rgba(255,255,255,0.05)", borderRadius:2, overflow:"hidden" }}>
                    <div style={{ width:`${report.confidence||60}%`, height:"100%", borderRadius:2, transition:"width .8s ease", background:(report.confidence||60)>=70?"#2ed573":(report.confidence||60)>=50?"#ffa502":"#ff4757" }} />
                  </div>
                  <span style={{ fontSize:11, color:"#2a5060", fontFamily:"monospace" }}>{report.confidence||60}%</span>
                </div>
                <div style={{ fontSize:10, color:"#1a2e40" }}>
                  {report.data_source==="akshare"?"📊 AKShare本地":report.data_source==="mixed"?"📊+🔍 混合数据":"🔍 AI搜索"}
                </div>
              </div>

              {/* 导出按钮 */}
              {(() => {
                const ps  = priceStructure;
                const ai  = report.price_levels;
                const sup = ps?.support    ?? ai?.support    ?? "—";
                const res = ps?.resistance ?? ai?.resistance ?? "—";
                const sl  = ps?.stop_loss  ?? ai?.stop_loss  ?? "—";
                const posState2 = report?.position_state || "D";
                const isBuyAction2  = ["BUY_ADD","WATCH_BUY"].includes(report.action);
                const isSellAction2 = ["SELL_WAVE","WATCH_SELL"].includes(report.action);
                const curPrice2 = parseFloat(ps?.current_price || report?.current_price || 0);
                const rawOp2 = ps?.order_price ?? ai?.order_price;
                const isClearSell2 = posState2 === "C" && (isSellAction2 || (rawOp2 != null && parseFloat(rawOp2) > curPrice2 * 1.002));
                let op = (!isClearSell2 && rawOp2 != null) ? rawOp2 : null;
                if (op == null && ps) {
                  const approxAtr2 = ((ps.high_20d || 0) - (ps.low_20d || 0)) / 20;
                  if (isClearSell2) {
                    const base2 = parseFloat(sup);
                    if (base2 && approxAtr2) {
                      const offset2 = Math.min(Math.max(approxAtr2 * 0.2, base2 * 0.002), base2 * 0.010);
                      op = Math.round((base2 - offset2) * 100) / 100;
                    }
                  } else if (isBuyAction2 || isSellAction2) {
                    const base2 = isBuyAction2 ? parseFloat(sup) : parseFloat(ps.current_price || res);
                    if (base2 && approxAtr2) {
                      const offset2 = Math.min(Math.max(approxAtr2 * 0.3, base2 * 0.002), base2 * (isBuyAction2 ? 0.015 : 0.010));
                      op = Math.round((isBuyAction2 ? base2 - offset2 : base2 + offset2) * 100) / 100;
                    }
                  }
                }
                if (op == null) op = "—";
                const opLabel2  = isClearSell2 ? "接回参考价 📊" : "建议挂单价 📊";
                const slLabel2  = posState2 === "C" ? "接回止损参考 📊" : "减仓止损参考 📊";
                const adv = positionAdvice;
                const time = new Date().toLocaleString("zh-CN", {timeZone:"Asia/Shanghai"});

                const exportHTML = () => {
                  const act2 = ACTION[report.action] || ACTION.HOLD;
                  const IMPACT_COLOR = { positive:"#2ed573", negative:"#ff4757", neutral:"#6a8090" };
                  const LAYER_C = { "日线":"#7f8c8d","60min":"#a29bfe","大盘":"#fd79a8","资金":"#00cec9","个股公告":"#f9ca24","板块资讯":"#e17055","停板":"#ff9f43" };

                  const scoreMax = Math.max(report.sell_score||0, report.buy_score||0, 10);
                  const sellPct  = Math.min((report.sell_score||0)/scoreMax*100,100);
                  const buyPct   = Math.min((report.buy_score||0)/scoreMax*100,100);

                  const signalsHTML = (report.key_signals||[]).map(s => {
                    const cleanDetail = (s.detail||"").replace(/（(强势上涨中|持续下跌中)[^）]*）/g,"").trim();
                    const trendTag = s.trend_filtered ? `<span class="tag-trend">趋势降权</span>` : "";
                    const weightTag = s.weight===0 ? `<span class="tag-dim">未计分</span>` : s.weight<1 ? `<span class="tag-dim">半权重</span>` : "";
                    return `
                    <div class="signal-row">
                      <span class="tag" style="color:${LAYER_C[s.layer]||'#7f8c8d'}">${s.layer}</span>
                      <span class="dir ${s.type==="halt"?"halt":s.type}">${s.type==="sell"?"↓":s.type==="halt"?"⊘":"↑"}</span>
                      <div>
                        <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px">
                          <span class="sig-name ${s.type==="halt"?"halt":s.type}">${s.factor}</span>${weightTag}${trendTag}
                        </div>
                        <div class="sig-detail">${cleanDetail}</div>
                      </div>
                    </div>`;
                  }).join("");

                  const catalystsHTML = (report.recent_catalysts||[]).map(c => `
                    <div class="catalyst-row">
                      <span class="dot" style="background:${IMPACT_COLOR[c.impact]||'#6a8090'}"></span>
                      <div>
                        <div class="cat-title">${c.title}</div>
                        <div class="cat-note">${c.note}</div>
                      </div>
                    </div>`).join("");

                  const sm = report.sector_momentum;
                  const trendColor = sm?.trend==="升温"?"#2ed573":sm?.trend==="降温"?"#ff6b7a":"#7090a0";

                  const posAdvHTML = adv ? `
                    <div class="card pos-card" style="border-color:${adv.border};background:${adv.bg}">
                      <div class="card-label" style="color:${adv.color}">仓位操作建议</div>
                      <div class="pos-grid">
                        <div class="pos-cell"><div class="pos-sub">首批操作</div><div class="pos-val" style="color:${adv.color}">${adv.first}</div></div>
                        <div class="pos-cell"><div class="pos-sub">后续操作</div><div class="pos-val">${adv.followup}</div></div>
                      </div>
                      <div class="pos-note">${adv.stopNote}${adv.basis?" · "+adv.basis:""}</div>
                    </div>` : "";


                  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${report.stock_name}（${report.stock_code}）波段分析</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070c15;color:#c0d8e8;font-family:'PingFang SC','Noto Sans SC',sans-serif;padding:32px 16px 64px;min-height:100vh}
.wrap{max-width:600px;margin:0 auto}
h1{font-size:22px;font-weight:700;letter-spacing:-.02em;background:linear-gradient(135deg,#dde8f8,#5a90c0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.subtitle{font-size:12px;color:#253545;margin-bottom:24px}
.badge{display:inline-flex;align-items:center;gap:6px;background:rgba(30,144,255,.07);border:1px solid rgba(30,144,255,.15);border-radius:20px;padding:3px 12px;margin-bottom:14px;font-size:10px;color:#1e90ff;font-weight:700;letter-spacing:.1em}
.dot-blink{width:5px;height:5px;border-radius:50%;background:#1e90ff}
.card{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:18px 20px;margin-bottom:12px}
.card-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;color:#2a4555}
.action-card{border-radius:16px;padding:22px 26px;margin-bottom:12px}
.stock-name{font-size:20px;font-weight:700;color:#b8d0e8}
.stock-code{font-size:11px;color:#2a4060;font-family:monospace}
.price{font-size:19px;font-weight:700;color:#c8dff0;font-family:monospace}
.chg{font-size:13px;font-weight:600}
.risk-tag{font-size:10px;font-weight:700;padding:2px 8px;border-radius:5px;background:rgba(255,255,255,.06);color:#7a9ab0}
.action-box{background:rgba(0,0,0,.2);border-radius:12px;padding:12px 18px;text-align:center;min-width:100px}
.action-icon{font-size:24px;line-height:1}
.action-label{font-size:13px;font-weight:700;margin:4px 0 2px}
.action-sub{font-size:10px;opacity:.65}
.summary-box{border-radius:8px;padding:10px 14px;line-height:1.65;font-size:13px;margin-top:14px}
.order-note{border-radius:8px;padding:9px 14px;line-height:1.6;font-size:12px;color:#5a8090;margin-top:8px}
.score-section{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.score-label{font-size:10px;font-weight:700;letter-spacing:.07em;margin-bottom:6px}
.bar-track{height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden}
.bar-fill{height:100%;border-radius:2px;transition:width .8s}
.bar-val{font-size:11px;font-family:monospace;margin-top:4px}
.levels{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.level-cell{flex:1;min-width:80px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:9px 12px}
.level-label{font-size:10px;color:#283a50;margin-bottom:4px}
.level-val{font-size:13px;font-weight:700;font-family:monospace}
.signal-row{display:flex;gap:8px;padding:8px 0;align-items:flex-start;border-bottom:1px solid rgba(255,255,255,.04)}
.signal-row:last-child{border-bottom:none}
.tag{font-size:10px;font-weight:700;background:rgba(255,255,255,.05);border-radius:4px;padding:1px 5px;white-space:nowrap;margin-top:2px}
.dir{width:16px;height:16px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;margin-top:2px}
.dir.sell{background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);color:#ff4757}
.dir.buy{background:rgba(30,144,255,.1);border:1px solid rgba(30,144,255,.3);color:#1e90ff}
.dir.halt{background:rgba(255,159,67,.1);border:1px solid rgba(255,159,67,.3);color:#ff9f43}
.sig-name{font-size:12px;font-weight:600;margin-bottom:2px}
.sig-name.sell{color:#ff7a8a}.sig-name.buy{color:#5aafff}.sig-name.halt{color:#ff9f43}
.tag-trend{font-size:9px;color:#e17055;background:rgba(225,112,85,.08);border:1px solid rgba(225,112,85,.25);border-radius:3px;padding:0 5px;letter-spacing:.04em}
.tag-dim{font-size:9px;color:#5a6a40;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:3px;padding:0 5px;letter-spacing:.04em}
.sig-detail{font-size:11px;color:#5a7080;line-height:1.6}
.sector-card{background:rgba(162,155,254,.06);border:1px solid rgba(162,155,254,.18);border-radius:12px;padding:13px 16px;margin-bottom:12px}
.sector-label{font-size:10px;font-weight:700;color:#a29bfe;letter-spacing:.08em;margin-bottom:8px}
.sector-tags{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.sector-concept{font-size:12px;font-weight:600;color:#c8b8ff}
.sector-trend{font-size:11px;padding:2px 8px;border-radius:5px}
.sector-vs{font-size:11px;color:#6a8090}
.sector-note{font-size:12px;color:#6a7090;line-height:1.6}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.mini-card{border:1px solid;border-radius:12px;padding:12px 14px}
.mini-label{font-size:10px;font-weight:700;margin-bottom:6px;letter-spacing:.06em}
.mini-text{font-size:12px;line-height:1.6}
.catalyst-row{display:flex;gap:10px;padding:8px 0;align-items:flex-start;border-bottom:1px solid rgba(255,255,255,.04)}
.catalyst-row:last-child{border-bottom:none}
.dot{width:5px;height:5px;border-radius:50%;margin-top:6px;flex-shrink:0}
.cat-title{font-size:12px;color:#8098b0;font-weight:500}
.cat-note{font-size:11px;color:#3a5060;margin-top:2px}
.pos-card{border-radius:12px;padding:14px 16px;margin-bottom:12px}
.pos-grid{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.pos-cell{background:rgba(255,255,255,.04);border-radius:8px;padding:8px 12px;flex:1;min-width:120px}
.pos-sub{font-size:10px;color:#3a5570;margin-bottom:3px}
.pos-val{font-size:13px;font-weight:700}
.pos-note{font-size:11px;color:#4a6070;line-height:1.6}
.conf-row{display:flex;align-items:center;gap:8px;flex:1;min-width:180px}
.conf-label{font-size:11px;color:#1e3040;white-space:nowrap}
.conf-track{flex:1;height:4px;background:rgba(255,255,255,.05);border-radius:2px;overflow:hidden}
.conf-fill{height:100%;border-radius:2px}
.conf-val{font-size:11px;font-family:monospace;color:#2a5060}
.footer-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:0 2px;margin-bottom:10px}
.source-note{font-size:10px;color:#1a2e40}
.disclaimer{font-size:10px;color:#131e2a;text-align:center;margin-top:14px;line-height:1.7}
.long-flag{background:rgba(255,71,87,.07);border:1px solid rgba(255,71,87,.28);border-radius:12px;padding:12px 16px;margin-bottom:12px}
.long-flag-title{font-size:12px;font-weight:700;color:#ff4757;margin-bottom:3px}
.long-flag-text{font-size:12px;color:#cc5060;line-height:1.6}
.note-card{background:rgba(90,175,255,.06);border:1px solid rgba(90,175,255,.22);border-radius:14px;padding:16px 20px;margin-bottom:12px}
.note-card-label{font-size:10px;font-weight:700;color:#3a80b0;letter-spacing:.08em;margin-bottom:8px;text-transform:uppercase}
.note-card-text{font-size:14px;color:#8ac8f0;line-height:1.75}
.ltv-card{background:rgba(162,155,254,.06);border:1px solid rgba(162,155,254,.2);border-radius:14px;padding:16px 20px;margin-bottom:12px}
.ltv-label{font-size:10px;font-weight:700;color:#a29bfe;letter-spacing:.08em;margin-bottom:8px;text-transform:uppercase}
.ltv-text{font-size:13px;color:#c0b0ff;line-height:1.8}
</style></head><body>
<div class="wrap">
  <div class="badge"><span class="dot-blink"></span>WAVE ANALYZER · A股波段分析报告</div>
  <h1>A股波段时机判断</h1>
  <div class="subtitle">长线持股 · 只告诉你：该抛、该加仓、还是不动　　生成时间：${time}</div>

  ${report.long_term_flag ? `<div class="long-flag"><div class="long-flag-title">🚨 长线风险警示</div><div class="long-flag-text">${report.long_term_flag}</div></div>` : ""}

  <div class="action-card" style="background:${act2.bg};border:1px solid ${act2.border}">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px">
      <div>
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px">
          <span class="stock-name">${report.stock_name}</span>
          <span class="stock-code">${report.stock_code}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="price">${report.current_price}</span>
          <span class="chg" style="color:${report.price_change_today==="暂无"?"#3a5070":String(report.price_change_today).startsWith("-")?"#ff4757":"#2ed573"}">${report.price_change_today}</span>
          ${report.risk_level?`<span class="risk-tag">风险：${report.risk_level}</span>`:""}
        </div>
      </div>
      <div class="action-box" style="border:1px solid ${act2.border}">
        <div class="action-icon" style="color:${act2.color}">${act2.icon}</div>
        <div class="action-label" style="color:${act2.color}">${act2.label}</div>
        <div class="action-sub" style="color:${act2.color}">${act2.sub}</div>
      </div>
    </div>
    <div class="summary-box" style="background:rgba(0,0,0,.15);color:${act2.color}">${report.action_summary||""}</div>
    ${report.price_levels?.order_note&&report.action!=="HOLD"?`<div class="order-note">📌 ${report.price_levels.order_note}</div>`:""}
  </div>


  <div class="card">
    <div class="score-section">
      <div>
        <div class="score-label" style="color:#ff4757">↓ 卖出压力</div>
        <div class="bar-track"><div class="bar-fill" style="width:${sellPct}%;background:#ff4757"></div></div>
        <div class="bar-val" style="color:#ff4757">${report.sell_score||0}/${scoreMax}</div>
      </div>
      <div>
        <div class="score-label" style="color:#1e90ff">↑ 买入机会</div>
        <div class="bar-track"><div class="bar-fill" style="width:${buyPct}%;background:#1e90ff"></div></div>
        <div class="bar-val" style="color:#1e90ff">${report.buy_score||0}/${scoreMax}</div>
      </div>
    </div>
    <div class="levels">
      <div class="level-cell"><div class="level-label">支撑位 ${priceStructure?"📊":"🤖"}</div><div class="level-val" style="color:#2ed573">${sup}</div></div>
      <div class="level-cell"><div class="level-label">压力位 ${priceStructure?"📊":"🤖"}</div><div class="level-val" style="color:#ff4757">${res}</div></div>
      ${report.action!=="HOLD"?`<div class="level-cell"><div class="level-label">${opLabel2}</div><div class="level-val" style="color:#1e90ff">${op}</div></div>`:""}
      <div class="level-cell"><div class="level-label">${slLabel2}</div><div class="level-val" style="color:#ffa502">${sl}</div></div>
    </div>
  </div>

  ${signalsHTML?`<div class="card"><div class="card-label">技术信号明细</div>${signalsHTML}</div>`:""}

  ${sm?.concept?`<div class="sector-card"><div class="sector-label">板块共振</div>
    <div class="sector-tags">
      <span class="sector-concept">${sm.concept}</span>
      ${sm.trend?`<span class="sector-trend" style="background:${sm.trend==="升温"?"rgba(46,213,115,.12)":sm.trend==="降温"?"rgba(255,71,87,.12)":"rgba(255,255,255,.05)"};color:${trendColor}">板块${sm.trend}</span>`:""}
      ${sm.stock_vs_sector?`<span class="sector-vs">个股：${sm.stock_vs_sector}</span>`:""}
    </div>
    ${sm.note?`<div class="sector-note">${sm.note}</div>`:""}</div>`:""}

  ${(report.market_context||report.smart_money_note)?`<div class="grid2">
    ${report.market_context?`<div class="mini-card" style="background:rgba(253,121,168,.06);border-color:rgba(253,121,168,.15)"><div class="mini-label" style="color:#fd79a8">大盘环境</div><div class="mini-text" style="color:#7a7090">${report.market_context}</div></div>`:""}
    ${report.smart_money_note?`<div class="mini-card" style="background:rgba(0,206,201,.06);border-color:rgba(0,206,201,.15)"><div class="mini-label" style="color:#00cec9">主力资金</div><div class="mini-text" style="color:#507070">${report.smart_money_note}</div></div>`:""}
  </div>`:""}

  ${catalystsHTML?`<div class="card"><div class="card-label">近期催化剂</div>${catalystsHTML}</div>`:""}

  ${posAdvHTML}

  ${report.note?`<div class="note-card"><div class="note-card-label">📌 综合提示</div><div class="note-card-text">${report.note}</div></div>`:""}

  ${report.long_term_view?`<div class="ltv-card"><div class="ltv-label">🔭 长线看法</div><div class="ltv-text">${report.long_term_view}</div></div>`:""}

  <div class="footer-row">
    <div class="conf-row">
      <span class="conf-label">分析置信度</span>
      <div class="conf-track"><div class="conf-fill" style="width:${report.confidence||60}%;background:${(report.confidence||60)>=70?"#2ed573":(report.confidence||60)>=50?"#ffa502":"#ff4757"}"></div></div>
      <span class="conf-val">${report.confidence||60}%</span>
    </div>
    <div class="source-note">${report.data_source==="akshare"?"📊 AKShare本地":report.data_source==="mixed"?"📊+🔍 混合数据":"🔍 AI搜索"}</div>
  </div>
  <div class="disclaimer">以上分析仅反映当前技术面和资金面的风险倾向，不是对未来走势的预测，实际行情受多重因素影响。盈亏自负。</div>
</div></body></html>`;

                  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement("a");
                  a.href = url;
                  a.download = `${report.stock_name}_${report.stock_code}_波段分析.html`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  setCopyDone(true); setTimeout(() => setCopyDone(false), 2500);
                };

                return (
                  <button onClick={exportHTML} style={{ width:"100%", padding:"10px", background:copyDone?"rgba(46,213,115,0.08)":"rgba(255,255,255,0.03)", border:`1px solid ${copyDone?"rgba(46,213,115,0.3)":"rgba(255,255,255,0.08)"}`, borderRadius:10, color:copyDone?"#2ed573":"#3a6070", fontSize:12, cursor:"pointer", letterSpacing:"0.04em", transition:"all .2s" }}
                    onMouseEnter={e => { if(!copyDone) e.currentTarget.style.background="rgba(255,255,255,0.06)"; }}
                    onMouseLeave={e => { if(!copyDone) e.currentTarget.style.background="rgba(255,255,255,0.03)"; }}>
                    {copyDone ? "✓ 已保存 HTML 报告" : "📄 导出完整分析报告（HTML）"}
                  </button>
                );
              })()}
              <div style={{ fontSize:10, color:"#131e2a", textAlign:"center", marginTop:16, lineHeight:1.7 }}>
                以上分析仅反映当前技术面和资金面的风险倾向，不是对未来走势的预测，实际行情受多重因素影响。盈亏自负。
              </div>
            </>)}
            </div>
          );
        })()}

        {/* Empty state */}
        {!loading && !report && !error && !lookResult && (
          <div style={{ textAlign:"center", padding:"28px 0", animation:"fadeUp .5s ease .1s both" }}>
            <div style={{ fontSize:40, marginBottom:12, opacity:.2 }}>📈</div>
            <div style={{ fontSize:13, color:"#1e3040", marginBottom:6 }}>上传 data.json 或输入股票名称</div>
            <div style={{ fontSize:11, color:"#121c28", lineHeight:1.9 }}>
              有文件 → 自动读取股票信息，一键分析<br />
              无文件 → 输入名称，AI 先确认股票再分析
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
