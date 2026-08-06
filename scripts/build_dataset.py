"""
BGG 데이터(bgg.json)와 시트에서 이관한 개인 데이터(sheet.json)를 합쳐
앱이 쓸 데이터셋과 티스토리가 fetch할 공개 JSON을 만든다.

원본 구분:
  - BGG가 원본  : 소유 상태, 내 평점, 플레이 횟수, 썸네일, 인원수, 순위
  - 내 DB가 원본 : 구매가/판매가, 용도, 메모, 세분화된 상태(방출 예정/확정)

사용법: python scripts/build_dataset.py <bgg.json> <sheet.json> <앱용.json> <공개용.json>
"""
import json
import os
import sys
from datetime import datetime, timezone


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write(path, payload):
    out_dir = os.path.dirname(path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def display_name(game):
    """한글 이름이 있으면 그걸 우선 보여준다."""
    korean = game.get("koreanNames") or []
    return korean[0] if korean else (game.get("primaryName") or game.get("name"))


def main():
    if len(sys.argv) != 5:
        print("사용법: python scripts/build_dataset.py <bgg.json> <sheet.json> "
              "<앱용.json> <공개용.json>")
        sys.exit(1)

    bgg_path, sheet_path, app_path, public_path = sys.argv[1:5]
    bgg = load(bgg_path)
    # 시트는 개인 데이터라 저장소에 없다(.gitignore). GitHub Actions에서는 BGG 데이터만으로
    # 공개용 JSON을 만들 수 있어야 하므로 없으면 빈 것으로 취급한다.
    if os.path.exists(sheet_path):
        sheet = load(sheet_path)
    else:
        print(f"시트 없음({sheet_path}) — BGG 데이터만으로 생성합니다.")
        sheet = {"entries": []}

    # 같은 게임을 팔았다가 다시 사기도 하므로(버건디의 성 등) 한 게임에 취득 이력이
    # 여러 건 붙을 수 있다. 덮어쓰지 않고 목록으로 쌓는다.
    personal = {}
    orphans = []
    for entry in sheet["entries"]:
        gid = entry.get("bggId")
        record = {
            "sheetName": entry["sheetName"],
            "status": entry["status"],
            "note": entry["note"],
            "pricePaid": entry["pricePaid"],
            "priceSold": entry["priceSold"],
            "tags": entry["tags"],
            "played": entry["played"],
            "plannedToPlay": entry["plannedToPlay"],
            # 두 사람 평점은 하나로 합친다 (사용자 결정: 소유자 구분 안 함).
            "myRatingSheet": entry["ratingAvg"] or entry["ratingO"] or entry["ratingBB"],
        }
        if gid:
            personal.setdefault(gid, []).append(record)
        else:
            orphans.append(record)

    # 현재 상태는 방출되지 않은 이력을 우선한다.
    STATUS_ORDER = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"]

    def current(records):
        return sorted(
            records,
            key=lambda r: STATUS_ORDER.index(r["status"]) if r["status"] in STATUS_ORDER
            else len(STATUS_ORDER),
        )[0]

    games = []
    for game in bgg["games"]:
        records = personal.get(game["id"], [])
        head = current(records) if records else {}
        games.append({
            **game,
            "displayName": display_name(game),
            "status": head.get("status"),
            "note": head.get("note"),
            "pricePaid": head.get("pricePaid"),
            "priceSold": head.get("priceSold"),
            "tags": head.get("tags") or [],
            "plannedToPlay": head.get("plannedToPlay", False),
            "inSheet": bool(records),
            # 재구매 이력까지 보존해 지출 합계가 어긋나지 않게 한다.
            "acquisitions": records,
        })

    linked = sum(1 for g in games if g["inSheet"])
    rows = sum(len(g["acquisitions"]) for g in games)
    owned = [g for g in games if g["own"]]
    spent = sum(r["pricePaid"] or 0 for g in games for r in g["acquisitions"])
    earned = sum(r["priceSold"] or 0 for g in games for r in g["acquisitions"])

    print(f"게임 {len(games)}개 (보유 {len(owned)}) · 시트 연결 {linked}개 게임/{rows}행 · "
          f"시트에만 있는 항목 {len(orphans)}")
    print(f"구매 합계 {spent:,}원 · 판매 합계 {earned:,}원 · 순지출 {spent - earned:,}원")

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # 앱용: 전부 담는다.
    write(app_path, {
        "generatedAt": generated,
        "count": len(games),
        "games": games,
        # BGG에 없는 시트 항목(선주문·위시리스트 등)은 따로 보존해 나중에 검색으로 연결한다.
        "unlinkedSheetEntries": orphans,
    })
    print(f"앱용 저장: {app_path}")

    # 공개용: 티스토리 카드에 필요한 것만. 가격·메모 같은 사적인 값은 뺀다.
    public = [{
        "id": g["id"],
        "name": g["displayName"],
        "nameEn": g.get("primaryName"),
        "aliases": (g.get("koreanNames") or []),
        "thumbnail": g.get("thumbnail"),
        "yearPublished": g.get("yearPublished"),
        "minPlayers": g.get("minPlayers"),
        "maxPlayers": g.get("maxPlayers"),
        "playingTime": g.get("playingTime"),
        "weight": g.get("weight"),
        "bggRating": g.get("bggRating"),
        "bggRank": g.get("bggRank"),
        "myRating": g.get("myRating"),
        "numPlays": g.get("numPlays"),
        "own": g.get("own"),
        "wishlist": g.get("wishlist"),
        "bggUrl": g.get("bggUrl"),
    } for g in games if g["own"] or g["numPlays"] or g["myRating"]]

    write(public_path, {
        "generatedAt": generated,
        "count": len(public),
        "games": public,
    })
    print(f"공개용 저장: {public_path} ({len(public)}개)")


if __name__ == "__main__":
    main()
