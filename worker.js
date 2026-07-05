/**
 * 보물모아 웹사이트 Worker
 *  - 정적 자산 서빙 (public/)
 *  - GET  /api/prices  : 고철·비철 시세 (gomulprice.com 스크래핑, 1시간 캐시)
 *  - POST /api/contact : 입점 문의 → Slack 실시간 전달
 *
 * 필요한 시크릿 (Cloudflare 대시보드 → Worker → Settings → Variables):
 *  - SLACK_BOT_TOKEN  : xoxb-... (bomulmoa 봇 토큰 재사용)
 *  - SLACK_CHANNEL_ID : 문의를 받을 채널 ID (예: C0B11MHV66N)
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/prices" && request.method === "GET") {
      return handlePrices(request, ctx);
    }
    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleContact(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ── 시세 API ─────────────────────────────────────────── */

const PRICE_CACHE_KEY = "https://bomulmoa.com/__cache/prices-v1";
const PRICE_TTL = 3600; // 1시간

async function handlePrices(request, ctx) {
  const cache = caches.default;
  const cached = await cache.match(PRICE_CACHE_KEY);
  if (cached) return cached;

  let payload;
  try {
    const items = await scrapeGomulPrice();
    payload = { updated: new Date().toISOString(), source: "gomulprice.com", items };
  } catch (e) {
    payload = { updated: null, source: null, items: [], error: "scrape_failed" };
  }

  const res = new Response(JSON.stringify(payload), {
    headers: { ...JSON_HEADERS, "Cache-Control": `public, max-age=${PRICE_TTL}` },
  });
  if (payload.items.length) ctx.waitUntil(cache.put(PRICE_CACHE_KEY, res.clone()));
  return res;
}

/** 문자열에서 원/kg 숫자만 추출 ("18,800원" → 18800) */
function parseKRW(s) {
  const n = Number(String(s).replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 품목명 → 고물상 표준 카테고리 분류 */
function categorize(item) {
  if (/생철|중량|경량|잡철|고철/.test(item)) return "고철";
  if (/신주/.test(item)) return "신주";
  if (/스텐|스테인/.test(item)) return "스테인리스";
  if (/샤시|샷시|알루|캔/.test(item)) return "알루미늄";
  if (/동|구리|꽈베기/.test(item)) return "구리";
  if (/폐지|신문|박스|파지/.test(item)) return "폐지";
  return "기타 비철";
}

/** HTML 태그 제거 */
function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * gomulprice.com 시세 테이블 스크래핑 (bomulmoa-agent 의 로직을 의존성 없이 이식).
 * <tr> 단위로 셀을 뽑아 [품목명, 가격] 패턴을 찾는다.
 */
async function scrapeGomulPrice() {
  const res = await fetch("https://gomulprice.com/", {
    headers: { "User-Agent": "Mozilla/5.0 (BomulmoaBot; +https://bomulmoa.com)" },
    cf: { cacheTtl: 600 },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const html = await res.text();

  const out = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const tr of rows) {
    const cells = (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? []).map(stripTags);
    if (cells.length < 2) continue;

    // 가격 셀: '원' 또는 콤마 포함 + 10~999,999 (8자리 날짜 자동 제외)
    let priceIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (!/[,원]/.test(cells[i])) continue;
      const n = parseKRW(cells[i]);
      if (n >= 10 && n <= 999999) { priceIdx = i; break; }
    }
    if (priceIdx <= 0) continue;

    const item = cells[priceIdx - 1];
    if (!item || !/[가-힣]/.test(item) || item.length > 20) continue;

    out.push({ category: categorize(item), item, price: parseKRW(cells[priceIdx]) });
    if (out.length >= 30) break;
  }
  if (!out.length) throw new Error("no rows parsed");
  return out;
}

/* ── 문의 API → Slack ─────────────────────────────────── */

async function handleContact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json");
  }

  // 허니팟: 봇이 채운 폼은 조용히 성공 처리
  if (body.company) return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });

  const name = clip(body.name, 60);
  const phone = clip(body.phone, 20);
  const region = clip(body.region, 40);
  const message = clip(body.message, 1000);
  if (!name || !phone || !message) return jsonError(400, "missing_fields");

  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL_ID) {
    return jsonError(503, "slack_not_configured");
  }

  const text = [
    ":inbox_tray: *새 입점 문의가 도착했습니다*",
    `• *상호/성함:* ${name}`,
    `• *연락처:* ${phone}`,
    region ? `• *지역:* ${region}` : null,
    `• *내용:* ${message}`,
    `_bomulmoa.com 문의폼 · ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}_`,
  ].filter(Boolean).join("\n");

  const slack = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text, unfurl_links: false }),
  });
  const result = await slack.json();
  if (!result.ok) return jsonError(502, `slack_error:${result.error}`);

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}

function clip(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function jsonError(status, code) {
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: JSON_HEADERS });
}
