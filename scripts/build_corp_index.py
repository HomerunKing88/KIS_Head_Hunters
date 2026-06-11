#!/usr/bin/env python3
"""
build_corp_index.py — DART 전체 공시기업 인덱스(corp_index.json) 생성

DART OpenAPI 의 corpCode.xml(zip) 을 내려받아
프론트엔드 검색·프리셋 매칭에 필요한 최소 필드만 추출한다.

출력 형식 (프로젝트 루트의 corp_index.json):
    [{"c": corp_code, "n": 회사명, "s": 종목코드}, ...]
    - c: DART 고유 8자리 기업코드
    - n: 정식 회사명(corp_name)
    - s: 상장 종목코드(6자리). 비상장이면 "" (빈 문자열)

사용:
    python3 build_corp_index.py <DART_API_KEY>
    python3 build_corp_index.py <DART_API_KEY> --out ../corp_index.json

분기에 한 번 정도 재실행해 신규 공시기업·사명 변경을 반영하는 것을 권장한다.
표준 라이브러리만 사용하므로 별도 설치가 필요 없다.
"""

import argparse
import io
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from urllib.request import urlopen, Request

CORPCODE_URL = "https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key={key}"


def download_corpcode_zip(api_key: str) -> bytes:
    url = CORPCODE_URL.format(key=api_key)
    req = Request(url, headers={"User-Agent": "exec-scope-build/1.0"})
    with urlopen(req, timeout=60) as resp:
        data = resp.read()
    # DART 는 키 오류 등일 때 zip 대신 JSON 에러를 반환한다.
    if data[:2] != b"PK":
        try:
            err = json.loads(data.decode("utf-8", "replace"))
            raise SystemExit(
                f"[오류] DART 가 zip 대신 응답을 반환했습니다: "
                f"status={err.get('status')} message={err.get('message')}"
            )
        except json.JSONDecodeError:
            raise SystemExit(
                "[오류] 예상치 못한 응답입니다(앞부분): "
                + data[:200].decode("utf-8", "replace")
            )
    return data


def parse_corpcode(zip_bytes: bytes) -> list:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        # 보통 CORPCODE.xml 단일 파일
        xml_name = next((n for n in zf.namelist() if n.lower().endswith(".xml")), None)
        if not xml_name:
            raise SystemExit("[오류] zip 안에 XML 파일이 없습니다.")
        xml_bytes = zf.read(xml_name)

    root = ET.fromstring(xml_bytes)
    out = []
    for el in root.iter("list"):
        corp_code = (el.findtext("corp_code") or "").strip()
        corp_name = (el.findtext("corp_name") or "").strip()
        stock_code = (el.findtext("stock_code") or "").strip()
        if not corp_code or not corp_name:
            continue
        out.append({"c": corp_code, "n": corp_name, "s": stock_code})
    return out


def main():
    ap = argparse.ArgumentParser(description="DART corp_index.json 생성")
    ap.add_argument("api_key", help="DART OpenAPI 인증키")
    default_out = os.path.join(os.path.dirname(__file__), "..", "corp_index.json")
    ap.add_argument("--out", default=default_out, help="출력 경로 (기본: 프로젝트 루트/corp_index.json)")
    args = ap.parse_args()

    print("[1/3] corpCode.xml 다운로드 중...")
    zip_bytes = download_corpcode_zip(args.api_key)

    print("[2/3] XML 파싱 중...")
    rows = parse_corpcode(zip_bytes)
    listed = sum(1 for r in rows if r["s"])

    out_path = os.path.abspath(args.out)
    print(f"[3/3] 저장 중: {out_path}")
    with open(out_path, "w", encoding="utf-8") as f:
        # 용량 절약을 위해 공백 없는 compact JSON 으로 저장
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1e6
    print(
        f"\n완료: 총 {len(rows):,}개사 (상장 {listed:,} / 비상장 {len(rows) - listed:,}) "
        f"· {size_mb:.1f} MB"
    )


if __name__ == "__main__":
    main()
