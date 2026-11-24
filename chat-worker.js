// ===== KBBA AI 聊天后端（加到你现有的 Cloudflare Worker 里）=====
// 1) 在 Cloudflare 后台 → 你的 Worker → Settings → Variables and Secrets
//    新增 Secret：ANTHROPIC_API_KEY（到 console.anthropic.com 申请）
// 1b) 创建活动存放处：Cloudflare 后台 → Storage & Databases → KV → Create namespace（名字随意，如 kbba-data）
//     再到 Worker → Settings → Bindings → Add → KV namespace，Variable name 填 KBBA_KV，选刚建的 namespace。
//     然后在该 namespace 里新增一条：Key = events，Value = 活动内容（见下方格式示例）。
//     以后有新活动，只要改这条 events 的内容，AI 马上就会按新内容回答，不用改代码。
//
//     events 内容示例（直接写文字就行，中英马来文都可以）：
//       - 2026年12月20日 上午8点｜KBBA 首次团体跑步｜地点：怡保湖滨公园｜免费，欢迎会员及家人参加｜报名：WhatsApp 011-5771 7543
//       - 2027年1月15日｜冰浴（ICE BATH）体验日｜地点待定｜名额 20 人，会员优先
//
// 2) 本文件已经是完整的 Worker 入口（见文件最底部的 export default）。
//    如果你的 Worker 里已经有别的代码，就只把 handleChat 等函数复制过去，
//    并在你自己的 fetch() 里加这一行：
//      if (new URL(request.url).pathname === "/api/chat") return handleChat(request, env);

const SYSTEM_PROMPT = `你是 KELAB BINA BADAN ADAPTIF（KBBA，适应性健美俱乐部）官方网站的 AI 助手。
规则：
- 用访客提问所用的语言回答（中文、English 或 Bahasa Melayu）。
- 说话风格要随性、轻松、像朋友聊天，不要官腔，不要写成公告或长篇大论。一般 1-3 句话就够，可以偶尔用一个表情符号。访客用口语或马来西亚式的说法（如 manglish、广东话、马来口语），你也可以自然地用相近的口吻回应。
- 关于俱乐部、活动、会员的事，只根据下面的资料回答，不要编造。资料里没有的内容（例如具体比赛日期、报名截止日），就随口说不确定，然后请对方 WhatsApp 或致电 011-5771 7543。
- 访客随口问别的话题（打招呼、聊健身、聊天），可以轻松地陪聊几句，再顺势带回俱乐部。
- 不提供医疗建议；有关身体状况或训练伤病的问题，建议咨询医生或专业教练。

【俱乐部资料】
- 名称：KELAB BINA BADAN ADAPTIF（KBBA），口号 Adaptive. Natural. Excellence.
- 成立：2026年9月17日，马来西亚。创办人：Wilson Siao（来自霹雳州，脑性麻痹 Cerebral Palsy 的自然健美运动员）。
- 使命：为马来西亚 OKU（残障人士）创造参与健美及竞技比赛的机会，推动 Adaptive Bodybuilding 与 Natural Bodybuilding，帮助会员了解赛事资讯、参赛方向，并争取资源与赞助。
- 愿景：成为马来西亚有影响力的 Adaptive Bodybuilding 体育组织。
- 核心价值：包容、平等、机会、自律、卓越。
- 未来活动：冰浴（ICE BATH）体验、跑步及其他适合不同身体能力人士的运动。
- Wilson 经历：2018开始健身；2022年7月参与 Mr. Perak 嘉宾展示；2023年6月首次参加 Mr. Perak；2024年参加 WNBF Macau、WNBF Malaysia、NPC Natural Regional Malaysia；2025年10月受邀参加 WNBF Australia，获 Adaptive Bodybuilding Special Award 及 Junior Men's Physique 第3名；2026年获 WNBF Malaysia 委任为 Head, Para & Adaptive Department。
- 理事会：主席、副主席、秘书、财政。
- 会员：18岁或以上可申请，须经俱乐部审核批准。2026年至2027年2月会员费全免。
  OKU 会员：永久会员 RM600，或年费 RM60。普通会员（爱好者/支持者）：RM600，或年费 RM60。
  经济困难的 OKU 会员或家庭，可申请免费会员，需经审核。
- 联络：WhatsApp / 电话 011-5771 7543；Instagram @kelab_bina_badan_adaptif。`;

const CORS = {
  "Access-Control-Allow-Origin": "*", // 上线后可改成你的网站域名
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function handleChat(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }

  // 只保留最近 10 条，限制每条长度，防止被滥用
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1000) }));

  if (!messages.length || messages[messages.length - 1].role !== "user")
    return json({ error: "no question" }, 400);

  // 读取最新活动资料（存在 Cloudflare KV 里，key 叫 "events"，随时可在后台修改）
  let events = "";
  try { events = (await env.KBBA_KV.get("events")) || ""; } catch {}
  const today = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "long", year: "numeric" });
  const system = SYSTEM_PROMPT +
    `\n\n【今天日期】${today}（马来西亚时间）。已过去的活动请说"已结束"，不要当成未来活动。` +
    `\n\n【最新活动与公告】\n` + (events.trim() || "目前没有公布的活动。如访客询问，请请他们关注 Instagram @kelab_bina_badan_adaptif 或 WhatsApp 011-5771 7543。");

  if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key" }, 500);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 500,
        system,
        messages,
      }),
    });
  } catch (e) {
    return json({ error: "cannot_reach_ai" }, 502);
  }

  if (!res.ok) {
    // 把 AI 服务返回的状态码和原因带回去，方便排查（不包含密钥）
    let detail = "";
    try { detail = ((await res.json()).error || {}).message || ""; } catch {}
    return json({ error: "ai_error", upstream: res.status, detail: String(detail).slice(0, 120) }, 502);
  }
  const data = await res.json();
  const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return json({ reply });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

// ===== Worker 入口 =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") return handleChat(request, env);
    // 其余请求（网页、图片）交给静态资源；没有静态资源绑定时返回 404
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
