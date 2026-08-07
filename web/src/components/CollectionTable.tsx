import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { CollectionListEntry } from "../api/types";
import { ratingColor, weightColor } from "../utils/ratingTier";
import { RatingBadge } from "./StarRating";
import "../styles/CollectionTable.css";

const STATUS_OPTIONS = ["보유", "선주문", "위시리스트", "방출 예정", "방출 완료"];

type SortKey =
  | "name" | "status" | "price_paid" | "price_sold" | "tags"
  | "my_rating" | "play_count" | "weight" | "bgg_rating" | "note" | "want_to_play";

type EditingCell = { rowKey: string; field: "name" | "price_paid" | "price_sold" | "tags" | "note" } | null;

function rowKeyOf(e: CollectionListEntry): string {
  return e.id != null ? `c${e.id}` : `u${e.game_id}`;
}

export default function CollectionTable({ entries }: { entries: CollectionListEntry[] }) {
  // 로컬 낙관적 업데이트용 오버레이. 서버 재조회 없이 즉시 반영하고 실패 시 되돌린다.
  const [overrides, setOverrides] = useState<Record<string, Partial<CollectionListEntry>>>({});
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [editing, setEditing] = useState<EditingCell>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState("");
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  // 미소유 행에서 상태를 처음 지정하면 collection 행이 새로 생긴다. 부모가 재조회하기 전까지
  // game_id -> 새로 생긴 collection id 매핑을 들고 있어야 그 행이 계속 "소유"로 취급된다.
  const [createdIds, setCreatedIds] = useState<Record<number, number>>({});
  const selectAllRef = useRef<HTMLInputElement>(null);

  const rows = entries.map((e) => {
    const id = e.id ?? createdIds[e.game_id] ?? null;
    return { ...e, id, ...overrides[rowKeyOf({ ...e, id })] };
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortValue(e: CollectionListEntry, key: SortKey): string | number {
    switch (key) {
      case "name": return e.game_name || "";
      case "status": return e.status || "";
      case "price_paid": return e.price_paid ?? -Infinity;
      case "price_sold": return e.price_sold ?? -Infinity;
      case "tags": return (e.tags || []).join(",");
      case "my_rating": return e.my_rating ?? -Infinity;
      case "play_count": return e.play_count ?? 0;
      case "weight": return e.weight ?? -Infinity;
      case "bgg_rating": return e.bgg_rating ?? -Infinity;
      case "note": return e.note || "";
      case "want_to_play": return e.want_to_play ? 1 : 0;
      default: return "";
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "asc" ? cmp : -cmp;
  });

  async function patch(e: CollectionListEntry, body: Partial<CollectionListEntry>) {
    const key = rowKeyOf(e);
    if (e.id == null) return; // 미소유 행은 편집 불가
    const prev = overrides[key];
    setOverrides((o) => ({ ...o, [key]: { ...o[key], ...body } }));
    setSavingKeys((s) => new Set(s).add(key));
    try {
      await api.updateCollection(e.id, body as never);
    } catch (err) {
      // 실패 시 이전 상태로 되돌린다
      setOverrides((o) => ({ ...o, [key]: prev ?? {} }));
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSavingKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  // 이름/평점은 게임 단위(game_id) 데이터라 컬렉션 소유 여부(e.id)와 무관하게 편집 가능하다.
  async function patchName(e: CollectionListEntry, customName: string) {
    const key = rowKeyOf(e);
    const prev = overrides[key];
    setSavingKeys((s) => new Set(s).add(key));
    try {
      const updated = await api.updateGame(e.game_id, { custom_name: customName.trim() });
      setOverrides((o) => ({ ...o, [key]: { ...o[key], game_name: updated.name } }));
    } catch (err) {
      setOverrides((o) => ({ ...o, [key]: prev ?? {} }));
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSavingKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  async function patchRating(e: CollectionListEntry, rating: number | null) {
    const key = rowKeyOf(e);
    const prev = overrides[key];
    setOverrides((o) => ({ ...o, [key]: { ...o[key], my_rating: rating } }));
    setSavingKeys((s) => new Set(s).add(key));
    try {
      const { my_rating } = await api.setRating(e.game_id, rating);
      setOverrides((o) => ({ ...o, [key]: { ...o[key], my_rating } }));
    } catch (err) {
      setOverrides((o) => ({ ...o, [key]: prev ?? {} }));
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSavingKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  // 플레이 희망은 평점과 같이 사용자별 값이라 collection이 아니라 game_rating을 고친다.
  async function patchWantToPlay(e: CollectionListEntry, want: boolean) {
    const key = rowKeyOf(e);
    const prev = overrides[key];
    setOverrides((o) => ({ ...o, [key]: { ...o[key], want_to_play: want ? 1 : 0 } }));
    setSavingKeys((s) => new Set(s).add(key));
    try {
      const { want_to_play } = await api.setWantToPlay(e.game_id, want);
      setOverrides((o) => ({ ...o, [key]: { ...o[key], want_to_play } }));
    } catch (err) {
      setOverrides((o) => ({ ...o, [key]: prev ?? {} }));
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSavingKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  // 미소유 행에서 상태를 처음 지정하면 collection 행을 새로 만든다. 그 뒤로는 patch()가 담당한다.
  async function createAndPatch(e: CollectionListEntry, status: string) {
    const key = rowKeyOf(e); // 아직 미소유라 u{game_id} 형태
    setSavingKeys((s) => new Set(s).add(key));
    try {
      const created = await api.addCollection({ game_id: e.game_id, status });
      setCreatedIds((m) => ({ ...m, [e.game_id]: created.id }));
      // status를 override에도 심어둔다 - 안 하면 새 id로 select에 매칭되는 빈 옵션이 없어서
      // 브라우저가 첫 옵션("보유")을 멋대로 보여주는 것처럼 보인다.
      setOverrides((o) => ({ ...o, [`c${created.id}`]: { status: created.status } }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSavingKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  function toggleSelect(key: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 소유 여부와 무관하게 전체 선택. 하나라도 선택돼 있으면 전부 해제한다.
  function toggleSelectAll() {
    if (selected.size > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sorted.map(rowKeyOf)));
    }
  }

  useEffect(() => {
    if (!selectAllRef.current) return;
    const allSelected = sorted.length > 0 && sorted.every((e) => selected.has(rowKeyOf(e)));
    selectAllRef.current.indeterminate = selected.size > 0 && !allSelected;
  }, [selected, sorted]);

  async function applyBulkStatus() {
    if (!bulkStatus || selected.size === 0) return;
    const targets = sorted.filter((e) => selected.has(rowKeyOf(e)));
    await Promise.all(
      targets.map((e) => (e.id != null ? patch(e, { status: bulkStatus }) : createAndPatch(e, bulkStatus)))
    );
    setBulkStatus("");
    setSelected(new Set());
  }

  function caret(key: SortKey) {
    if (sortKey !== key) return null;
    return <span className="ct-caret">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  return (
    <div className="collection-table-wrap">
      {selected.size > 0 && (
        <div className="ct-bulk-bar">
          <span>{selected.size}개 선택됨</span>
          <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
            <option value="">상태 일괄 변경...</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button disabled={!bulkStatus} onClick={applyBulkStatus}>적용</button>
        </div>
      )}
      <div className="collection-table-scroll">
        <table className="collection-table">
          <thead>
            <tr>
              <th className="ct-checkbox-col">
                <input
                  type="checkbox"
                  ref={selectAllRef}
                  checked={sorted.length > 0 && sorted.every((e) => selected.has(rowKeyOf(e)))}
                  onChange={toggleSelectAll}
                  title={selected.size > 0 ? "모두 해제" : "전체 선택"}
                />
              </th>
              <th onClick={() => toggleSort("name")}>이름{caret("name")}</th>
              <th onClick={() => toggleSort("status")}>상태{caret("status")}</th>
              <th onClick={() => toggleSort("price_paid")}>구매가{caret("price_paid")}</th>
              <th onClick={() => toggleSort("price_sold")}>판매가{caret("price_sold")}</th>
              <th onClick={() => toggleSort("tags")}>용도{caret("tags")}</th>
              <th onClick={() => toggleSort("my_rating")}>내 평점{caret("my_rating")}</th>
              <th onClick={() => toggleSort("want_to_play")}>플레이 희망{caret("want_to_play")}</th>
              <th onClick={() => toggleSort("play_count")}>플레이 수{caret("play_count")}</th>
              <th onClick={() => toggleSort("weight")}>웨이트{caret("weight")}</th>
              <th onClick={() => toggleSort("bgg_rating")}>긱 평점{caret("bgg_rating")}</th>
              <th onClick={() => toggleSort("note")}>메모{caret("note")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => {
              const key = rowKeyOf(e);
              const editable = e.id != null;
              const saving = savingKeys.has(key);
              return (
                <tr key={key} className={saving ? "ct-row-saving" : ""}>
                  <td className="ct-checkbox-col">
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggleSelect(key)}
                    />
                  </td>
                  <EditableCell
                    editable
                    active={editing?.rowKey === key && editing.field === "name"}
                    display={e.game_name || ""}
                    value={e.game_name || ""}
                    type="text"
                    className="ct-name-col"
                    onStart={() => setEditing({ rowKey: key, field: "name" })}
                    onCommit={(v) => {
                      setEditing(null);
                      if (v !== (e.game_name || "")) patchName(e, v);
                    }}
                  />
                  <td>
                    <select
                      value={e.status || ""}
                      onChange={(ev) => {
                        const status = ev.target.value;
                        // 미소유 행에서 상태를 처음 고르면 collection 행을 새로 만든다.
                        if (editable) patch(e, { status });
                        else createAndPatch(e, status);
                      }}
                    >
                      {!editable && <option value="" disabled>미소유</option>}
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <EditableCell
                    editable={editable}
                    active={editing?.rowKey === key && editing.field === "price_paid"}
                    display={e.price_paid != null ? e.price_paid.toLocaleString() : ""}
                    value={e.price_paid != null ? String(e.price_paid) : ""}
                    type="number"
                    onStart={() => editable && setEditing({ rowKey: key, field: "price_paid" })}
                    onCommit={(v) => {
                      setEditing(null);
                      const num = v.trim() === "" ? null : Number(v);
                      if (num !== e.price_paid) patch(e, { price_paid: num });
                    }}
                  />
                  <EditableCell
                    editable={editable}
                    active={editing?.rowKey === key && editing.field === "price_sold"}
                    display={e.price_sold != null ? e.price_sold.toLocaleString() : ""}
                    value={e.price_sold != null ? String(e.price_sold) : ""}
                    type="number"
                    onStart={() => editable && setEditing({ rowKey: key, field: "price_sold" })}
                    onCommit={(v) => {
                      setEditing(null);
                      const num = v.trim() === "" ? null : Number(v);
                      if (num !== e.price_sold) patch(e, { price_sold: num });
                    }}
                  />
                  <EditableCell
                    editable={editable}
                    active={editing?.rowKey === key && editing.field === "tags"}
                    display={(e.tags || []).join(", ")}
                    value={(e.tags || []).join(", ")}
                    type="text"
                    onStart={() => editable && setEditing({ rowKey: key, field: "tags" })}
                    onCommit={(v) => {
                      setEditing(null);
                      const tags = v.split(",").map((t) => t.trim()).filter(Boolean);
                      patch(e, { tags });
                    }}
                  />
                  {/* 표에서는 별 10개가 너무 넓다. 긱 평점처럼 색 있는 숫자 하나로 줄이고,
                      누르면 StarRating과 같은 조절 창이 뜬다. */}
                  <td className="ct-rating-col">
                    <RatingBadge value={e.my_rating ?? null} onChange={(v) => patchRating(e, v)} />
                  </td>
                  <td className="ct-want-col">
                    <button
                      type="button"
                      className={`ct-want-icon${e.want_to_play ? " active" : ""}`}
                      onClick={() => patchWantToPlay(e, !e.want_to_play)}
                      title={e.want_to_play ? "플레이 희망 해제" : "플레이 희망으로 표시"}
                      aria-pressed={!!e.want_to_play}
                    >
                      ▶
                    </button>
                  </td>
                  <td className="ct-readonly">{e.play_count}</td>
                  <td className="ct-readonly" style={{ color: weightColor(e.weight) }}>{e.weight ?? ""}</td>
                  <td className="ct-readonly" style={{ color: ratingColor(e.bgg_rating) }}>{e.bgg_rating ?? ""}</td>
                  <EditableCell
                    editable={editable}
                    active={editing?.rowKey === key && editing.field === "note"}
                    display={e.note || ""}
                    value={e.note || ""}
                    type="text"
                    onStart={() => editable && setEditing({ rowKey: key, field: "note" })}
                    onCommit={(v) => {
                      setEditing(null);
                      if (v !== (e.note || "")) patch(e, { note: v || null });
                    }}
                  />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditableCell({
  editable, active, display, value, type, onStart, onCommit, className,
}: {
  editable: boolean;
  active: boolean;
  display: string;
  value: string;
  type: "text" | "number";
  onStart: () => void;
  onCommit: (v: string) => void;
  className?: string;
}) {
  if (!editable) {
    return <td className="ct-readonly" />;
  }
  if (active) {
    return (
      <td className={`ct-editing${className ? ` ${className}` : ""}`}>
        <input
          type={type}
          autoFocus
          defaultValue={value}
          onBlur={(ev) => onCommit(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
            if (ev.key === "Escape") onCommit(value);
          }}
        />
      </td>
    );
  }
  return (
    <td className={`ct-editable${className ? ` ${className}` : ""}`} onClick={onStart}>
      {display || <span className="muted">-</span>}
    </td>
  );
}
