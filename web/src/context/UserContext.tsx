import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import type { User } from "../api/types";
import { api } from "../api/client";
import { clearListCache } from "../utils/listCache";

const STORAGE_KEY = "bgg_user_id";
const STORAGE_NAME_KEY = "bgg_user_name";

interface UserContextValue {
  users: User[];
  currentUser: User | null;
  setCurrentUser: (u: User) => void;
  loading: boolean;
}

const UserContext = createContext<UserContextValue | null>(null);

export function UserProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.users().then((list) => {
      setUsers(list);
      const savedId = localStorage.getItem(STORAGE_KEY);
      if (savedId) {
        const found = list.find((u) => String(u.id) === savedId);
        if (found) setCurrentUserState(found);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const setCurrentUser = useCallback((u: User) => {
    localStorage.setItem(STORAGE_KEY, String(u.id));
    localStorage.setItem(STORAGE_NAME_KEY, u.name);
    // 목록 캐시는 계정 구분 없이 담겨 있어서, 전환하면 비워야 남의 기록이 안 보인다
    clearListCache();
    try { sessionStorage.removeItem("bgg_feed_count"); } catch { /* 무시 */ }
    setCurrentUserState(u);
  }, []);

  return (
    <UserContext.Provider value={{ users, currentUser, setCurrentUser, loading }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser는 UserProvider 안에서만 사용할 수 있습니다");
  return ctx;
}
