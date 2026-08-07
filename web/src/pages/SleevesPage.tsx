import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Sleeve } from "../api/types";
import "../styles/Sleeves.css";

// 신규 행 입력용 빈 폼 값. size 외엔 전부 선택 입력이라 빈 문자열로 시작해도 된다.
const EMPTY_FORM = { size: "", maker: "", kind: "", thickness: "", quantity: "0", note: "" };

export default function SleevesPage() {
  const navigate = useNavigate();
  const [sleeves, setSleeves] = useState<Sleeve[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setSleeves(await api.sleeves());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // PC에서는 컬렉션 표 모드와 같은 방식으로 폭을 넓힌다. 모바일은 뷰포트가 좁아 실질적으로
  // 영향이 없으므로(최대폭 제한만 풀림) 화면 크기와 무관하게 켜둬도 안전하다.
  useEffect(() => {
    document.body.classList.add("wide-mode");
    return () => document.body.classList.remove("wide-mode");
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sleeves;
    return sleeves.filter((s) => s.size.toLowerCase().includes(q));
  }, [sleeves, query]);

  // 수량 직접 입력. 목록을 다시 불러오지 않고 서버 응답으로 로컬 상태만 갱신한다 (빠른 반영 우선).
  async function setQuantity(s: Sleeve, next: number) {
    const clamped = Math.max(0, Math.floor(next) || 0);
    if (clamped === s.quantity) return;
    const updated = await api.updateSleeve(s.id, { quantity: clamped });
    setSleeves((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
  }

  function startEdit(s: Sleeve) {
    setEditingId(s.id);
    setEditForm({
      size: s.size,
      maker: s.maker ?? "",
      kind: s.kind ?? "",
      thickness: s.thickness ?? "",
      quantity: String(s.quantity),
      note: s.note ?? "",
    });
  }

  async function saveEdit(id: number) {
    if (!editForm.size.trim()) return;
    setBusy(true);
    try {
      const updated = await api.updateSleeve(id, {
        size: editForm.size.trim(),
        maker: editForm.maker.trim() || null,
        kind: editForm.kind.trim() || null,
        thickness: editForm.thickness.trim() || null,
        quantity: Number(editForm.quantity) || 0,
        note: editForm.note.trim() || null,
      });
      setSleeves((prev) => prev.map((x) => (x.id === id ? updated : x)));
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  }

  async function removeSleeve(id: number) {
    if (!window.confirm("이 슬리브 항목을 삭제할까요?")) return;
    setBusy(true);
    try {
      await api.deleteSleeve(id);
      setSleeves((prev) => prev.filter((x) => x.id !== id));
    } finally {
      setBusy(false);
    }
  }

  async function submitAdd() {
    if (!addForm.size.trim()) return;
    setBusy(true);
    try {
      const created = await api.addSleeve({
        size: addForm.size.trim(),
        maker: addForm.maker.trim() || null,
        kind: addForm.kind.trim() || null,
        thickness: addForm.thickness.trim() || null,
        quantity: Number(addForm.quantity) || 0,
        note: addForm.note.trim() || null,
      });
      setSleeves((prev) => [...prev, created]);
      setAddForm(EMPTY_FORM);
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page sleeves-page">
      <div className="detail-topbar">
        <button className="back-btn" onClick={() => navigate(-1)}>← 뒤로</button>
        <h1>슬리브 재고</h1>
        <button className="icon-btn" onClick={() => setAdding((v) => !v)}>{adding ? "✕" : "＋"}</button>
      </div>

      <input
        className="search-input"
        placeholder="사이즈 검색 (예: 63.5x88)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {adding && (
        <div className="card sleeve-form">
          <div className="field">
            <label>사이즈 *</label>
            <input value={addForm.size} onChange={(e) => setAddForm({ ...addForm, size: e.target.value })} placeholder="예: 64x89" autoFocus />
          </div>
          <div className="field">
            <label>제조사</label>
            <input value={addForm.maker} onChange={(e) => setAddForm({ ...addForm, maker: e.target.value })} />
          </div>
          <div className="field">
            <label>종류</label>
            <input value={addForm.kind} onChange={(e) => setAddForm({ ...addForm, kind: e.target.value })} />
          </div>
          <div className="field">
            <label>두께(mm)</label>
            <input value={addForm.thickness} onChange={(e) => setAddForm({ ...addForm, thickness: e.target.value })} />
          </div>
          <div className="field">
            <label>수량(장)</label>
            <input type="number" value={addForm.quantity} onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label>메모</label>
            <input value={addForm.note} onChange={(e) => setAddForm({ ...addForm, note: e.target.value })} />
          </div>
          <button className="btn-primary" disabled={busy || !addForm.size.trim()} onClick={submitAdd}>추가</button>
        </div>
      )}

      {loading && <p className="muted empty-hint">불러오는 중...</p>}
      {!loading && filtered.length === 0 && <p className="muted empty-hint">항목이 없습니다.</p>}

      {!loading && filtered.length > 0 && (
        <div className="sleeve-table-wrap">
          <table className="sleeve-table">
            <colgroup>
              <col className="col-size" />
              <col className="col-maker" />
              <col className="col-thickness" />
              <col className="col-qty" />
              <col className="col-note" />
              <col className="col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>사이즈</th>
                <th>제조사/종류</th>
                <th>두께</th>
                <th>수량</th>
                <th>메모</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                editingId === s.id ? (
                  <tr key={s.id} className="sleeve-row-editing">
                    <td colSpan={6}>
                      <div className="sleeve-edit-form">
                        <input value={editForm.size} onChange={(e) => setEditForm({ ...editForm, size: e.target.value })} placeholder="사이즈" />
                        <input value={editForm.maker} onChange={(e) => setEditForm({ ...editForm, maker: e.target.value })} placeholder="제조사" />
                        <input value={editForm.kind} onChange={(e) => setEditForm({ ...editForm, kind: e.target.value })} placeholder="종류" />
                        <input value={editForm.thickness} onChange={(e) => setEditForm({ ...editForm, thickness: e.target.value })} placeholder="두께(mm)" />
                        <input type="number" value={editForm.quantity} onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })} placeholder="수량" />
                        <input value={editForm.note} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} placeholder="메모" />
                        <div className="sleeve-edit-actions">
                          <button className="btn-small" disabled={busy} onClick={() => saveEdit(s.id)}>저장</button>
                          <button className="btn-small" disabled={busy} onClick={() => setEditingId(null)}>취소</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={s.id}>
                    <td>{s.size}</td>
                    <td>
                      <div className="sleeve-maker-cell">
                        <span>{s.maker || "-"}</span>
                        {s.kind && <span className="muted sleeve-kind-tag">{s.kind}</span>}
                      </div>
                    </td>
                    <td className="muted">{s.thickness || "-"}</td>
                    <td className="sleeve-qty-cell">
                      <input
                        type="number"
                        className="qty-input"
                        min={0}
                        defaultValue={s.quantity}
                        key={s.quantity}
                        onBlur={(e) => setQuantity(s, Number(e.target.value))}
                      />
                    </td>
                    <td className="sleeve-note-cell">{s.note || "-"}</td>
                    <td>
                      <div className="sleeve-actions-cell">
                        <button className="btn-small" onClick={() => startEdit(s)}>수정</button>
                        <button className="btn-small" onClick={() => removeSleeve(s.id)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
