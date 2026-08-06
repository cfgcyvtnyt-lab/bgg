"""
BGG 공식 XML API2 (/xmlapi2/collection) 응답을 읽어서
티스토리 스킨에서 바로 fetch해서 쓸 수 있는 가벼운 JSON으로 변환한다.

사용법: python xml_to_json.py collection.xml docs/collection.json
"""
import json
import os
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def convert(xml_path, json_path):
    tree = ET.parse(xml_path)
    root = tree.getroot()

    games = []
    for item in root.findall("item"):
        game_id = to_int(item.get("objectid"))

        name_el = item.find("name")
        name = (name_el.text or "").strip() if name_el is not None else ""
        if not name:
            continue

        year_el = item.find("yearpublished")
        numplays_el = item.find("numplays")
        status_el = item.find("status")

        rating = None
        stats_el = item.find("stats")
        if stats_el is not None:
            rating_el = stats_el.find("rating")
            if rating_el is not None:
                rating = to_float(rating_el.get("value"))

        games.append({
            "id": game_id,
            "name": name,
            "yearPublished": to_int(year_el.text) if year_el is not None else None,
            "myRating": rating,
            "numPlays": to_int(numplays_el.text) if numplays_el is not None else 0,
            "own": status_el is not None and status_el.get("own") == "1",
            "wishlist": status_el is not None and status_el.get("wishlist") == "1",
            "bggUrl": f"https://boardgamegeek.com/boardgame/{game_id}" if game_id else None,
        })

    # 이름 기준 오름차순 정렬 — 스킨 쪽에서 태그 이름과 매칭하기 쉽도록
    games.sort(key=lambda g: g["name"].lower())

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(games),
        "games": games,
    }

    out_dir = os.path.dirname(json_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"{len(games)}개 게임 -> {json_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("사용법: python xml_to_json.py <입력.xml> <출력.json>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
