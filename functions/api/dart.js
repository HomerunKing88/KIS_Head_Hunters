/**
 * Cloudflare Pages Function — DART OpenAPI 프록시
 *
 * 역할
 *  1. DART OpenAPI 인증키(DART_API_KEY)를 서버에서 주입 → 프론트엔드에 키 노출 방지
 *  2. 부서 공용 비밀번호(APP_PASSWORD)를 X-App-Pass 헤더로 검증 → 외부 무단 사용 차단
 *  3. 허용된 엔드포인트만 중계 (allowlist) → DART API 오남용/한도 보호
 *
 * 환경변수 (Cloudflare Pages → Settings → Environment variables, 설정 후 재배포 필수)
 *  - DART_API_KEY : DART OpenAPI 인증키
 *  - APP_PASSWORD : 부서 공용 비밀번호
 *
 * 호출 형태
 *  GET /api/dart?endpoint=<name>&<dart params...>
 *  Header: X-App-Pass: <비밀번호>
 */

const DART_BASE = "https://opendart.fss.or.kr/api";

// 프론트엔드가 호출할 수 있는 DART 엔드포인트 화이트리스트.
// auth 는 비밀번호 검증 전용(가상 엔드포인트)으로 DART 를 호출하지 않는다.
const ALLOWED = {
  exctvSttus: "exctvSttus.json",       // 임원현황
  company: "company.json",             // 기업개황
  fnlttSinglAcnt: "fnlttSinglAcnt.json", // 단일회사 주요계정(자산총계 등)
  empSttus: "empSttus.json",           // 직원현황
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({ status: "405", message: "GET만 허용됩니다." }, 405);
  }

  const url = new URL(request.url);
  const endpoint = url.searchParams.get("endpoint") || "";

  // --- 1. 비밀번호 검증 ---
  const pass = request.headers.get("X-App-Pass") || "";
  if (!env.APP_PASSWORD) {
    return json({ status: "500", message: "서버에 APP_PASSWORD가 설정되지 않았습니다." }, 500);
  }
  if (pass !== env.APP_PASSWORD) {
    return json({ status: "401", message: "인증 실패" }, 401);
  }

  // auth 엔드포인트: 비밀번호만 검증하고 종료
  if (endpoint === "auth") {
    return json({ status: "000", message: "인증 성공" });
  }

  // --- 2. 엔드포인트 화이트리스트 검증 ---
  const dartPath = ALLOWED[endpoint];
  if (!dartPath) {
    return json({ status: "400", message: `허용되지 않은 endpoint: ${endpoint}` }, 400);
  }

  if (!env.DART_API_KEY) {
    return json({ status: "500", message: "서버에 DART_API_KEY가 설정되지 않았습니다." }, 500);
  }

  // --- 3. DART 호출 파라미터 구성 (endpoint 제외, 인증키 주입) ---
  const params = new URLSearchParams();
  params.set("crtfc_key", env.DART_API_KEY);
  for (const [k, v] of url.searchParams) {
    if (k === "endpoint") continue;
    params.set(k, v);
  }

  const target = `${DART_BASE}/${dartPath}?${params.toString()}`;
  // 오류 메시지에 인증키가 새어나가지 않도록 마스킹
  const safe = m => String(m || "").replace(/crtfc_key=[^&\s]+/gi, "crtfc_key=***");

  try {
    const r = await fetch(target, {
      // 정상 User-Agent가 없으면 DART 방화벽이 오류페이지(error1.html)로 리다이렉트하므로 명시한다.
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KISHeadHunters/1.0)",
        "Accept": "application/json,text/plain,*/*",
      },
      // 리다이렉트를 따라가지 않는다 — 따라가면 error1.html 루프로 "Too many redirects" 발생.
      redirect: "manual",
      // DART 응답은 작고 변동성이 있어 엣지 캐시는 사용하지 않는다(앱이 localStorage 캐시 담당).
      cf: { cacheTtl: 0 },
    });

    // DART가 오류페이지로 리다이렉트하면 키 미승인/차단/제한 가능성 (redirect:manual → status 0 또는 3xx)
    if (r.status === 0 || (r.status >= 300 && r.status < 400)) {
      return json({ status: "900", message: "DART가 요청을 오류페이지로 리다이렉트했습니다. DART 키 승인 상태 또는 호출 제한을 확인하세요." }, 502);
    }

    const text = await r.text();
    // DART 는 JSON 을 반환하지만, 점검/오류 시 비-JSON 이 올 수 있으므로 방어적으로 파싱.
    try {
      JSON.parse(text);
      return new Response(text, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch (_) {
      return json({ status: "900", message: "DART 응답이 JSON이 아닙니다(점검/오류 페이지 가능성).", raw: safe(text).slice(0, 160) }, 502);
    }
  } catch (e) {
    return json({ status: "900", message: "DART 연결 실패: " + safe(e && e.message) }, 502);
  }
}
