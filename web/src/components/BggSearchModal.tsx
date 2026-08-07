import { useState } from "react";
import { api } from "../api/client";
import Modal from "./Modal";
import type { BggSearchResult } from "../api/types";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

// BGG 검색 -> 결과 선택 -> 컬렉션에 추가하는 모달.
// BGG search API가 주는 id가 game 테이블 id(=BGG objectid)와 같다는 전제로 바로 game_id에 넣는다.
// 서버가 모르는 게임(동기화 전)이면 POST가 400을 주므로 그 경우 안내만 한다.
export default function BggSearchModal({ onClose, onAdded }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<BggSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<number | null>(null);

  async function doSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.search(q.trim());
      setResults(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "검색 실패");
    } finally {
      setLoading(false);
    }
  }

  async function addToCollection(item: BggSearchResult) {
    setAddingId(item.id);
    setError(null);
    try {
      await api.addCollection({ game_id: item.id, status: "보유" });
      setResults((prev) => prev.map((r) => (r.id === item.id ? { ...r, inCollection: true } : r)));
      onAdded();
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} (게임 데이터가 아직 동기화되지 않았을 수 있습니다)`
          : "추가 실패",
      );
    } finally {
      setAddingId(null);
    }
  }

  return (
    <Modal title="BGG에서 게임 검색" onClose={onClose}>
        <form onSubmit={doSearch} className="modal-search-form">
          <input
            autoFocus
            placeholder="게임 이름 (한글/영문)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className="btn-primary">검색</button>
        </form>
        {loading && <p className="muted">검색 중...</p>}
        {error && <p className="error-text">{error}</p>}
        <ul className="search-result-list">
          {results.map((r) => (
            <li key={r.id} className="search-result-item">
              <div className="search-result-name">
                {r.name}
                {r.yearPublished ? <span className="muted"> ({r.yearPublished})</span> : null}
              </div>
              {r.inCollection ? (
                <span className="search-result-badge">✓ 컬렉션에 있음</span>
              ) : (
                <button
                  className="btn-small"
                  disabled={addingId === r.id}
                  onClick={() => addToCollection(r)}
                >
                  {addingId === r.id ? "추가 중..." : "+ 추가"}
                </button>
              )}
            </li>
          ))}
          {!loading && results.length === 0 && q && <p className="muted">검색 결과가 없습니다.</p>}
        </ul>
    </Modal>
  );
}
