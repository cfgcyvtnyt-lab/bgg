"""
구글시트에서 내보낸 컬렉션 CSV를 읽어 개인 데이터(구매가·상태·용도·2인 평점 등)를
구조화된 JSON으로 바꾸고, BGG 게임과 한글 이름으로 매칭한다.

BGG가 주지 못하는 정보(가격, 방출 여부, 용도 분류, 두 사람의 개별 평점)가
시트에만 있으므로 이 둘을 합쳐야 컬렉션 관리가 완성된다.

사용법: python scripts/import_sheet.py <시트.csv> <bgg.json> <출력.json>
"""
import csv
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

OWNERS = {"ㅇ", "ㅃ"}

# 매칭용 정규화: 공백/문장부호/괄호주석을 지워 "브라스: 버밍엄" == "브라스 버밍엄" 이 되도록.
STRIP_RE = re.compile(r"[\s:·,\-–—_'\"!?~/\\()\[\]]+")
PAREN_RE = re.compile(r"\([^)]*\)")


def normalize(name):
    if not name:
        return ""
    text = unicodedata.normalize("NFKC", name).lower()
    text = PAREN_RE.sub("", text)
    return STRIP_RE.sub("", text)


def parse_money(value):
    """'₩173,000' -> 173000"""
    if not value:
        return None
    digits = re.sub(r"[^\d]", "", value)
    return int(digits) if digits else None


def parse_float(value):
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def parse_int(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def parse_owners(value):
    """'ㅇ, ㅃ' -> ['ㅇ','ㅃ']. 방출 완료 행에는 숫자가 들어 있어 그대로 못 쓴다."""
    if not value:
        return [], None
    tokens = [t.strip() for t in value.split(",")]
    owners = [t for t in tokens if t in OWNERS]
    raw = value.strip() if not owners else None
    return owners, raw


def parse_tags(value):
    """'필러 (Filler), 신작 (New)' -> ['필러','신작']"""
    if not value:
        return []
    return [PAREN_RE.sub("", t).strip() for t in value.split(",") if t.strip()]


def load_sheet(csv_path):
    entries = []
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            name = (row.get("게임 이름") or "").strip()
            if not name:
                continue

            owners, owner_raw = parse_owners(row.get("소유"))
            entries.append({
                "sheetName": name,
                "owners": owners,
                "ownerRaw": owner_raw,          # 숫자 등 해석 불가한 원본값 보존
                "played": (row.get("플레이 여부") or "").strip().upper() == "TRUE",
                "plannedToPlay": bool((row.get("플레이 예정") or "").strip()),
                "yearPublished": parse_int(row.get("출시")),
                "weight": parse_float(row.get("웨이트")),
                "ratingO": parse_float(row.get("ㅇ")),
                "ratingBB": parse_float(row.get("ㅃ")),
                "ratingAvg": parse_float(row.get("평균")),
                "bggRatingSheet": parse_float(row.get("긱")),
                "status": (row.get("상태") or "").strip() or None,
                "note": (row.get("특이 사항 및 메모") or "").strip() or None,
                "pricePaid": parse_money(row.get("구매가")),
                "priceSold": parse_money(row.get("판매가")),
                "tags": parse_tags(row.get("용도")),
            })
    return entries


def build_index(bgg_games):
    """정규화된 한글/영문/별칭 이름 -> BGG id"""
    index = {}
    for game in bgg_games:
        names = [game.get("primaryName"), game.get("name")]
        names += game.get("koreanNames") or []
        names += game.get("alternateNames") or []
        for name in names:
            key = normalize(name)
            # 먼저 등록된 쪽을 유지해 흔한 이름이 덮어쓰이지 않게 한다.
            if key and key not in index:
                index[key] = game["id"]
    return index


def match_by_containment(entry, games, taken):
    """'포세일' 이 BGG의 '투자왕 포세일' 안에 들어 있는 경우처럼 부분 일치로 건진다."""
    key = normalize(entry["sheetName"])
    if len(key) < 3:
        return None
    for game in games:
        if game["id"] in taken:
            continue
        for name in (game.get("koreanNames") or []) + [game.get("primaryName")]:
            other = normalize(name)
            if other and (key in other or other in key):
                return game["id"]
    return None


def match_by_fingerprint(entry, games, taken):
    """시트의 출시연도·웨이트는 BGG에서 복사해 온 값이라 지문으로 쓸 수 있다."""
    year, weight = entry.get("yearPublished"), entry.get("weight")
    if year is None or weight is None:
        return None

    candidates = [
        g for g in games
        if g["id"] not in taken
        and g.get("yearPublished") == year
        and g.get("weight") is not None
        and abs(g["weight"] - weight) < 0.05
    ]
    # 후보가 둘 이상이면 어느 쪽인지 단정할 수 없으므로 포기한다.
    return candidates[0]["id"] if len(candidates) == 1 else None


def load_aliases(path):
    """{"배틀라인": 760} 형태의 수동 보정 파일. 없으면 무시한다."""
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return {normalize(k): v for k, v in json.load(f).items()}


def main():
    if len(sys.argv) not in (4, 5):
        print("사용법: python scripts/import_sheet.py <시트.csv> <bgg.json> <출력.json> [aliases.json]")
        sys.exit(1)

    csv_path, bgg_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    alias_path = sys.argv[4] if len(sys.argv) == 5 else "data/aliases.json"

    with open(bgg_path, encoding="utf-8") as f:
        bgg = json.load(f)
    games = bgg["games"]
    index = build_index(games)
    aliases = load_aliases(alias_path)
    by_id = {g["id"]: g for g in games}

    entries = load_sheet(csv_path)
    taken = set()
    stats = {"alias": 0, "name": 0, "containment": 0, "fingerprint": 0}

    # 정확도가 높은 방법부터 차례로 적용하고, 이미 쓰인 BGG 게임은 재사용하지 않는다.
    for entry in entries:
        key = normalize(entry["sheetName"])
        gid, how = None, None
        if key in aliases:
            gid, how = aliases[key], "alias"
        elif key in index:
            gid, how = index[key], "name"
        if gid is not None:
            entry["bggId"], entry["matchedBy"] = gid, how
            stats[how] += 1
            taken.add(gid)
        else:
            entry["bggId"] = entry["matchedBy"] = None

    # 부분일치·지문 매칭은 오답률이 높다(연도와 웨이트가 우연히 겹치는 다른 게임을 집는다).
    # 그래서 자동 적용하지 않고 사람이 확인할 제안 목록으로만 내보낸다.
    suggestions = []
    for entry in entries:
        if entry["bggId"]:
            continue
        for pass_name, matcher in (("containment", match_by_containment),
                                   ("fingerprint", match_by_fingerprint)):
            gid = matcher(entry, games, taken)
            if gid:
                suggestions.append({
                    "sheetName": entry["sheetName"],
                    "status": entry["status"],
                    "suggestedId": gid,
                    "suggestedName": by_id[gid].get("primaryName"),
                    "suggestedKorean": by_id[gid].get("koreanNames") or [],
                    "how": pass_name,
                    "sheetYear": entry["yearPublished"],
                    "sheetWeight": entry["weight"],
                    "bggYear": by_id[gid].get("yearPublished"),
                    "bggWeight": by_id[gid].get("weight"),
                })
                break

    for entry in entries:
        gid = entry["bggId"]
        entry["bggName"] = by_id[gid].get("primaryName") if gid else None

    matched = sum(1 for e in entries if e["bggId"])
    unmatched = len(entries) - matched
    detail = " · ".join(f"{k} {v}" for k, v in stats.items() if v)
    print(f"시트 {len(entries)}행 · 매칭 {matched} ({detail}) · 실패 {unmatched}")

    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "count": len(entries),
            "matched": matched,
            "matchStats": stats,
            "entries": entries,
        }, f, ensure_ascii=False, indent=2)
    print(f"저장: {out_path}")

    # 콘솔이 cp949라 한글 이름을 직접 찍으면 깨지므로 파일로 남긴다.
    data_dir = os.path.dirname(out_path) or "."
    if suggestions:
        path = os.path.join(data_dir, "suggestions.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(suggestions, f, ensure_ascii=False, indent=2)
        print(f"확인 필요한 매칭 제안 {len(suggestions)}건: {path}")

    if unmatched:
        report = os.path.join(data_dir, "unmatched.txt")
        with open(report, "w", encoding="utf-8") as f:
            f.write("BGG와 연결되지 않은 시트 항목\n")
            f.write("aliases.json 형식: {\"시트이름\": BGG숫자ID}\n\n")
            for entry in entries:
                if not entry["bggId"]:
                    f.write(f"{entry['sheetName']}\t[{entry['status']}]\t"
                            f"{entry['yearPublished']}년\t웨이트 {entry['weight']}\n")
        print(f"미연결 {unmatched}건 목록: {report}")


if __name__ == "__main__":
    main()
