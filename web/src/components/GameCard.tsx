import { Link } from "react-router-dom";
import type { CollectionEntry } from "../api/types";

interface Props {
  entry: CollectionEntry;
  playCount: number;
  view: "grid" | "list";
}

// 컬렉션 화면의 게임 카드 하나. 그리드/목록 뷰를 공유한다.
export default function GameCard({ entry, playCount, view }: Props) {
  const thumb = entry.thumbnail || entry.image;

  return (
    <Link to={`/game/${entry.game_id}`} className={`game-card game-card-${view}`}>
      <div className="game-card-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <div className="game-card-thumb-empty">?</div>}
      </div>
      <div className="game-card-body">
        <div className="game-card-name">{entry.game_name}</div>
        <div className="game-card-meta">
          <span className="game-card-status">{entry.status}</span>
          <span className="game-card-plays">플레이 {playCount}회</span>
          {entry.my_rating != null && (
            <span className="game-card-rating">★ {Math.round(entry.my_rating * 10) / 10}</span>
          )}
        </div>
      </div>
    </Link>
  );
}
