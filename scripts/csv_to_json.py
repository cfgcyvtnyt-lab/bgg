"""
BGG 컬렉션 CSV(geekcollection.php export)를 읽어서
티스토리 스킨에서 바로 fetch해서 쓸 수 있는 가벼운 JSON으로 변환한다.

사용법: python csv_to_json.py collection.csv docs/collection.json
"""
import csv
import json
import os
import sys
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


def to_bool(value):
    return str(value).strip() == "1"


def convert(csv_path, json_path):
    games = []
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            game_id = to_int(row.get("objectid"))
            name = (row.get("objectname") or "").strip()
            if not name:
                continue

            games.append({
                "id": game_id,
                "name": name,
                "yearPublished": to_int(row.get("yearpublished")),
                "myRating": to_float(row.get("rating")),
                "numPlays": to_int(row.get("numplays")) or 0,
                "own": to_bool(row.get("own")),
                "wishlist": to_bool(row.get("wishlist")),
                "weight": to_float(row.get("avgweight") or row.get("weight")),
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
        print("사용법: python csv_to_json.py <입력.csv> <출력.json>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
