# 보물모아 (Bomulmoa) — bomulmoa.com

고물상 무인 매입 키오스크 **파트너 모집** 웹사이트.
Cloudflare Worker(정적 자산 + API)로 배포됩니다.

## 구조
```
public/           정적 사이트 (index.html, robots.txt, sitemap.xml, favicon.svg)
worker.js         Worker — 자산 서빙 + API
wrangler.jsonc    Cloudflare 설정
```

## API
| 경로 | 설명 |
|------|------|
| `GET /api/prices` | 고철·비철 시세 (gomulprice.com 스크래핑, 1시간 캐시) |
| `POST /api/contact` | 입점 문의 → Slack 채널로 실시간 전달 |

## 배포
GitHub `main` 브랜치에 push → Cloudflare Workers Builds 가 자동 빌드·배포.

## Slack 문의 연동에 필요한 시크릿
Cloudflare 대시보드 → Workers & Pages → `bomulmoa` → Settings → Variables and Secrets:

| 이름 | 값 |
|------|-----|
| `SLACK_BOT_TOKEN` | `xoxb-...` (bomulmoa 봇 토큰) — **Secret** 타입 |
| `SLACK_CHANNEL_ID` | 문의 받을 채널 ID (예: `C0B11MHV66N`) |

시크릿이 없으면 문의폼은 503을 반환하고, 시세 위젯은 정상 동작합니다.
