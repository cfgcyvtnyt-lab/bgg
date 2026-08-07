// 목록 화면에서 받아온 것을 메모리에 잠깐 들고 있는다.
//
// 게임 하나를 눌러 봤다가 뒤로 오면 목록이 통째로 사라졌다가 다시 받아온다.
// 그동안 화면이 비니 스크롤도 되돌릴 수 없고, 돌아올 때마다 잠깐 깜빡인다.
// 받아둔 걸 그대로 다시 쓰면 첫 그림부터 목록이 완성돼 있어서 바로 보던 자리에 있게 된다.
//
// 탭을 새로 고치면 사라지는 메모리 캐시다. 파일이나 sessionStorage에 담지 않는다 -
// 기록을 추가·수정하면 곧바로 낡은 값이 되기 때문에 오래 들고 있을 물건이 아니다.
const store = new Map<string, { at: number; value: unknown }>();

// 이 시간이 지난 것은 버린다. 다른 기기에서 기록을 넣었을 수도 있으니 무한정 믿지 않는다.
const TTL_MS = 5 * 60 * 1000;

export function getCached<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function setCached<T>(key: string, value: T) {
  store.set(key, { at: Date.now(), value });
}

/**
 * 목록을 바꾸는 동작(기록 추가·수정·삭제, 컬렉션 변경) 뒤에 부른다.
 * 안 부르면 뒤로 갔을 때 낡은 목록이 보인다.
 */
export function clearListCache() {
  store.clear();
}
