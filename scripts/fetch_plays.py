"""
BGG의 플레이 기록 전체를 페이지 단위로 받아 data/plays.json으로 저장한다.

BGStats로 쌓아온 기록이 BGG에 그대로 있어서(플레이어별 점수·승패 포함)
통계·승률·헤드투헤드를 여기서 다 계산할 수 있다.

사용법: python scripts/fetch_plays.py <BGG아이디> <출력.json>
환경변수 BGG_API_KEY 필요.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

BASE = "https://boardgamegeek.com/xmlapi2/plays"
PAGE_SIZE = 100     # BGG가 한 페이지에 주는 최대 건수
RATE_DELAY = 1.0


def fetch_page(username, page, api_key, tries=10):
    url = f"{BASE}?username={username}&page={page}"
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
            resp = urllib.request.urlopen(req, timeout=60)
            return ET.fromstring(resp.read())
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(f"인증 실패(HTTP {e.code}). BGG_API_KEY를 확인하세요.")
            print(f"  HTTP {e.code} — {attempt}/{tries}, 10초 후 재시도", flush=True)
            time.sleep(10)
    raise SystemExit(f"최종 실패: {url}")


def num(value, cast, default=None):
    try:
        return cast(value)
    except (TypeError, ValueError):
        return default


def parse_play(play):
    item = play.find("item")
    players = []
    for p in play.findall("./players/player"):
        players.append({
            "name": p.get("name") or None,
            "username": p.get("username") or None,
            "score": num(p.get("score"), float),
            "win": p.get("win") == "1",
            "new": p.get("new") == "1",
            "color": p.get("color") or None,
            "startPosition": p.get("startposition") or None,
        })

    comments = play.find("comments")
    return {
        "id": num(play.get("id"), int),
        "date": play.get("date"),
        "quantity": num(play.get("quantity"), int, 1),
        "length": num(play.get("length"), int, 0),      # 분 단위, 0이면 미기록
        "incomplete": play.get("incomplete") == "1",
        "location": play.get("location") or None,
        "gameId": num(item.get("objectid"), int) if item is not None else None,
        "gameName": item.get("name") if item is not None else None,
        "comment": (comments.text or "").strip() if comments is not None else None,
        "players": players,
    }


def main():
    if len(sys.argv) != 3:
        print("사용법: python scripts/fetch_plays.py <BGG아이디> <출력.json>")
        sys.exit(1)

    username, out_path = sys.argv[1], sys.argv[2]
    api_key = (os.environ.get("BGG_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("BGG_API_KEY 환경변수가 비어 있습니다.")

    root = fetch_page(username, 1, api_key)
    total = num(root.get("total"), int, 0)
    pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    print(f"플레이 기록 {total}건 · {pages}페이지")

    plays = [parse_play(p) for p in root.findall("play")]
    for page in range(2, pages + 1):
        time.sleep(RATE_DELAY)
        print(f"  페이지 {page}/{pages}")
        plays.extend(parse_play(p) for p in fetch_page(username, page, api_key).findall("play"))

    plays.sort(key=lambda p: (p["date"] or "", p["id"] or 0), reverse=True)
    print(f"수집 완료: {len(plays)}건")

    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "username": username,
            "total": total,
            "count": len(plays),
            "plays": plays,
        }, f, ensure_ascii=False, indent=2)
    print(f"저장: {out_path}")


if __name__ == "__main__":
    main()
