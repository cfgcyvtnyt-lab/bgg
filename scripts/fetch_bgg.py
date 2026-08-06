"""
BGG XML API2에서 컬렉션과 게임 상세정보를 받아 data/bgg.json으로 저장한다.

collection 엔드포인트만으로는 썸네일/한글 이름/인원수를 알 수 없어서,
thing 엔드포인트를 20개씩 나눠 호출해 병합한다.

사용법: python scripts/fetch_bgg.py <BGG아이디> <출력.json>
환경변수 BGG_API_KEY 필요.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

BASE = "https://boardgamegeek.com/xmlapi2"
BATCH = 20          # thing 엔드포인트가 한 번에 받는 최대 id 수
RATE_DELAY = 1.0    # BGG 권장 레이트리밋(초당 2회)보다 여유 있게

HANGUL = re.compile(r"[가-힣]")


def request(url, api_key):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    return urllib.request.urlopen(req, timeout=60)


def fetch_xml(url, api_key, tries=10):
    """202(준비 중)를 폴링하고, 인증 오류는 즉시 중단한다."""
    for attempt in range(1, tries + 1):
        try:
            resp = request(url, api_key)
            status = resp.status
            body = resp.read()
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()

        if status == 200:
            return ET.fromstring(body)
        if status in (401, 403):
            raise SystemExit(f"인증 실패(HTTP {status}). BGG_API_KEY를 확인하세요.")
        print(f"  HTTP {status} — {attempt}/{tries}, 10초 후 재시도", flush=True)
        time.sleep(10)

    raise SystemExit(f"최종 실패: {url}")


def text_of(el, tag, cast=None):
    child = el.find(tag)
    if child is None or child.text is None:
        return None
    if cast is None:
        return child.text.strip()
    try:
        return cast(child.text)
    except (TypeError, ValueError):
        return None


def num(value, cast):
    try:
        return cast(value)
    except (TypeError, ValueError):
        return None


def fetch_collection(username, api_key):
    """소장/위시리스트 등 개인 상태와 내 평점을 가져온다."""
    url = f"{BASE}/collection?username={username}&subtype=boardgame&stats=1"
    print(f"컬렉션 요청: {username}")
    root = fetch_xml(url, api_key)

    games = {}
    for item in root.findall("item"):
        gid = num(item.get("objectid"), int)
        if gid is None:
            continue

        rating = None
        stats = item.find("stats")
        if stats is not None:
            rating_el = stats.find("rating")
            if rating_el is not None:
                rating = num(rating_el.get("value"), float)

        status = item.find("status")
        status = status.attrib if status is not None else {}

        games[gid] = {
            "id": gid,
            "name": text_of(item, "name") or "",
            "yearPublished": text_of(item, "yearpublished", int),
            "myRating": rating,
            "numPlays": text_of(item, "numplays", int) or 0,
            "own": status.get("own") == "1",
            "prevOwned": status.get("prevowned") == "1",
            "wishlist": status.get("wishlist") == "1",
            "preordered": status.get("preordered") == "1",
            "wantToPlay": status.get("wanttoplay") == "1",
            "bggUrl": f"https://boardgamegeek.com/boardgame/{gid}",
        }

    print(f"  {len(games)}개 수신")
    return games


def fetch_details(ids, api_key):
    """썸네일·인원수·플레이시간·무게·순위·다국어 이름을 가져온다."""
    details = {}
    total = (len(ids) + BATCH - 1) // BATCH

    for n, start in enumerate(range(0, len(ids), BATCH), 1):
        chunk = ids[start:start + BATCH]
        url = f"{BASE}/thing?id={','.join(str(i) for i in chunk)}&stats=1"
        print(f"상세 요청 {n}/{total} ({len(chunk)}개)")
        root = fetch_xml(url, api_key)

        for item in root.findall("item"):
            gid = num(item.get("id"), int)
            if gid is None:
                continue

            primary, alternates, korean = None, [], []
            for name_el in item.findall("name"):
                value = name_el.get("value") or ""
                if name_el.get("type") == "primary":
                    primary = value
                else:
                    alternates.append(value)
                if HANGUL.search(value):
                    korean.append(value)

            average = rank = None
            stats = item.find("statistics")
            if stats is not None:
                ratings = stats.find("ratings")
                if ratings is not None:
                    avg_el = ratings.find("average")
                    if avg_el is not None:
                        average = num(avg_el.get("value"), float)
                    for rank_el in ratings.iter("rank"):
                        if rank_el.get("name") == "boardgame":
                            rank = num(rank_el.get("value"), int)

            weight = None
            if stats is not None:
                ratings = stats.find("ratings")
                if ratings is not None:
                    w_el = ratings.find("averageweight")
                    if w_el is not None:
                        weight = num(w_el.get("value"), float)

            details[gid] = {
                "primaryName": primary,
                "koreanNames": korean,
                "alternateNames": alternates,
                "thumbnail": text_of(item, "thumbnail"),
                "image": text_of(item, "image"),
                "minPlayers": num(item.find("minplayers").get("value"), int)
                if item.find("minplayers") is not None else None,
                "maxPlayers": num(item.find("maxplayers").get("value"), int)
                if item.find("maxplayers") is not None else None,
                "playingTime": num(item.find("playingtime").get("value"), int)
                if item.find("playingtime") is not None else None,
                "weight": round(weight, 2) if weight else None,
                "bggRating": round(average, 2) if average else None,
                "bggRank": rank,
            }

        if n < total:
            time.sleep(RATE_DELAY)

    return details


def main():
    if len(sys.argv) != 3:
        print("사용법: python scripts/fetch_bgg.py <BGG아이디> <출력.json>")
        sys.exit(1)

    username, out_path = sys.argv[1], sys.argv[2]
    api_key = (os.environ.get("BGG_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("BGG_API_KEY 환경변수가 비어 있습니다.")

    collection = fetch_collection(username, api_key)
    details = fetch_details(sorted(collection), api_key)

    games = []
    for gid, game in collection.items():
        games.append({**game, **details.get(gid, {})})
    games.sort(key=lambda g: (g.get("primaryName") or g["name"]).lower())

    with_korean = sum(1 for g in games if g.get("koreanNames"))
    print(f"병합 완료: {len(games)}개 (한글 이름 보유 {with_korean}개)")

    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "username": username,
            "count": len(games),
            "games": games,
        }, f, ensure_ascii=False, indent=2)
    print(f"저장: {out_path}")


if __name__ == "__main__":
    main()
