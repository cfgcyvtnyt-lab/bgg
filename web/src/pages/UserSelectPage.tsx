import { useUser } from "../context/UserContext";
import "../styles/UserSelect.css";

export default function UserSelectPage() {
  const { users, setCurrentUser } = useUser();

  return (
    <div className="user-select">
      <h1>보드게임 컬렉션</h1>
      <p className="user-select-sub">사용할 계정을 선택하세요</p>
      <div className="user-select-list">
        {users.length === 0 && <p className="muted">사용자를 불러올 수 없습니다. 서버가 켜져 있는지 확인하세요.</p>}
        {users.map((u) => (
          <button key={u.id} className="user-select-btn" onClick={() => setCurrentUser(u)}>
            {u.name}
          </button>
        ))}
      </div>
    </div>
  );
}
