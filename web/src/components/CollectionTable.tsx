import { useState } from "react";
import { api } from "../api/client";
import type { CollectionListEntry } from "../api/types";
import { ratingColor, weightColor } from "../utils/ratingTier";
import "../styles/CollectionTable.css";

const STATUS_OPTIONS = ["보유", "선주문", "위시리스트", "방출 예정", "방출 확정", "방출 완료"];

type SortKey =
  | "name" | "status" | "price_paid" | "price_sold" | "tags"
  | "my_rating" | "play_count" | "weight" | "bgg_rating" | "note";

type EditingCell = { rowKey: string; field: "price_paid" | "price_sold" | "tags" | "note" } | null;

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

  const rows = entries.map((e) => ({ ...e, ...overrides[rowKeyOf(e)] }));

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

  function toggleSelect(key: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAll() {
    const editable = sorted.filter((e) => e.id != null);
    const allSelected = editable.length > 0 && editable.every((e) => selected.has(rowKeyOf(e)));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(editable.map(rowKeyOf)));
    }
  }

  async function applyBulkStatus() {
    if (!bulkStatus || selected.size === 0) return;
    const targets = sorted.filter((e) => selected.has(rowKeyOf(e)) && e.id != null);
    await Promise.all(targets.map((e) => patch(e, { status: bulkStatus })));
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
                  checked={sorted.length > 0 && sorted.filter((e) => e.id != null).every((e) => selected.has(rowKeyOf(e))) && sorted.some((e) => e.id != null)}
                  onChange={toggleSelectAll}
                />
              </th>
              <th onClick={() => toggleSort("name")}>이름{caret("name")}</th>
              <th onClick={() => toggleSort("status")}>상태{caret("status")}</th>
              <th onClick={() => toggleSort("price_paid")}>구매가{caret("price_paid")}</th>
              <th onClick={() => toggleSort("price_sold")}>판매가{caret("price_sold")}</th>
              <th onClick={() => toggleSort("tags")}>용도{caret("tags")}</th>
              <th onClick={() => toggleSort("my_rating")}>내 평점{caret("my_rating")}</th>
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
                      disabled={!editable}
                      checked={selected.has(key)}
                      onChange={() => toggleSelect(key)}
                    />
                  </td>
                  <td className="ct-name-col">{e.game_name}</td>
                  <td>
                    {editable ? (
                      <select
                        value={e.status || ""}
                        onChange={(ev) => patch(e, { status: ev.target.value })}
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">미소유</span>
                    )}
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
                  <td className="ct-readonly">{e.my_rating ?? ""}</td>
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
  editable, active, display, value, type, onStart, onCommit,
}: {
  editable: boolean;
  active: boolean;
  display: string;
  value: string;
  type: "text" | "number";
  onStart: () => void;
  onCommit: (v: string) => void;
}) {
  if (!editable) {
    return <td className="ct-readonly" />;
  }
  if (active) {
    return (
      <td className="ct-editing">
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
    <td className="ct-editable" onClick={onStart}>
      {display || <span className="muted">-</span>}
    </td>
  );
}
