/**
 * 주기적 청소. NAS 도커에 올려두고 몇 달씩 손 안 대도 용량이 새지 않게 한다.
 *
 * 실측(2026-08): 이미지 캐시 423개 100MB 중 108개 53.6MB가 아무 게임도 참조하지 않는
 * 고아였다. 대체 이미지 모달이 버전 썸네일을 잔뜩 받아오는데 그중 하나만 고르기 때문이다.
 * 캐시라서 지워도 다음에 필요하면 다시 받는다 - 지우는 쪽이 항상 안전하다.
 *
 * DB 본체는 문제가 아니다. 판 1,908개에 2MB고 월 90판 페이스면 10년 써도 15MB다.
 * 그래서 여기서 DB에 하는 일은 사용자 데이터 삭제가 아니라 WAL 정리와 빈 페이지 회수뿐이다.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";

// 이 시간 안에 만들어진 파일은 건드리지 않는다 - 지금 막 받아서 아직 DB에 안 들어간
// 이미지를 지워버리는 사고를 막는다.
const GRACE_MS = 60 * 60 * 1000;

// /api/image가 쓰는 것과 같은 규칙으로 캐시 파일명을 만든다(URL sha256 + 확장자).
function cacheNameFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return createHash("sha256").update(url).digest("hex") + (extname(parsed.pathname) || ".img");
}

/**
 * 화면에서 안 쓰는 캐시 이미지를 지운다.
 *
 * game.image(긱 원본)는 일부러 뺐다. 박스아트를 그리는 자리가 110x110뿐이라 앱이 원본을
 * 요청하지 않는데, 파일은 장당 700KB~5MB나 된다(실측 63개 43.7MB). 남겨둘 이유가 없다.
 * custom_image(사용자가 고른 대체 이미지)는 실제로 화면에 쓰이므로 살려둔다.
 */
function cleanImageCache(db, dir, { dryRun }) {
  if (!existsSync(dir)) return { removed: 0, freedBytes: 0 };

  const keep = new Set();
  for (const r of db.prepare("SELECT thumbnail, custom_image FROM game").all()) {
    for (const url of [r.thumbnail, r.custom_image]) {
      if (!url) continue;
      const name = cacheNameFor(url);
      if (name) keep.add(name);
    }
  }

  const cutoff = Date.now() - GRACE_MS;
  let removed = 0;
  let freedBytes = 0;
  for (const file of readdirSync(dir)) {
    if (keep.has(file)) continue;
    const path = join(dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
    freedBytes += stat.size;
    removed++;
    if (!dryRun) {
      try { unlinkSync(path); } catch { /* 이미 없으면 무시 */ }
    }
  }
  return { removed, freedBytes };
}

/**
 * DB에 행이 없는 사진 파일을 지운다.
 *
 * 반대 방향(행은 있는데 파일이 없는 경우)은 건드리지 않는다 - 캡션 같은 정보가 행에 남아
 * 있고, 파일만 복구하면 되살아나기 때문이다. 사용자 데이터는 지우지 않는 게 원칙이다.
 */
function cleanOrphanPhotos(db, dir, { dryRun }) {
  if (!existsSync(dir)) return { removed: 0, freedBytes: 0 };

  const keep = new Set(db.prepare("SELECT filename FROM photo").all().map((r) => r.filename));
  const cutoff = Date.now() - GRACE_MS;
  let removed = 0;
  let freedBytes = 0;
  for (const file of readdirSync(dir)) {
    if (keep.has(file)) continue;
    const path = join(dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
    freedBytes += stat.size;
    removed++;
    if (!dryRun) {
      try { unlinkSync(path); } catch { /* 이미 없으면 무시 */ }
    }
  }
  return { removed, freedBytes };
}

/** 지금 쓰는 프로필을 뺀 나머지 아바타 파일. 새로 올릴 때마다 예전 파일이 남는다. */
function cleanOldAvatars(db, dir, { dryRun }) {
  if (!existsSync(dir)) return { removed: 0, freedBytes: 0 };

  const keep = new Set(
    db.prepare("SELECT avatar FROM user WHERE avatar IS NOT NULL").all().map((r) => r.avatar)
  );
  const cutoff = Date.now() - GRACE_MS;
  let removed = 0;
  let freedBytes = 0;
  for (const file of readdirSync(dir)) {
    if (keep.has(file)) continue;
    const path = join(dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
    freedBytes += stat.size;
    removed++;
    if (!dryRun) {
      try { unlinkSync(path); } catch { /* 이미 없으면 무시 */ }
    }
  }
  return { removed, freedBytes };
}

/**
 * WAL을 본체로 접고 빈 페이지를 회수한다.
 *
 * WAL은 한 번 커지면 저절로 줄지 않는다(재사용만 한다). 실측으로 본체 2MB에 WAL 4MB였다.
 * VACUUM은 파일을 통째로 다시 쓰므로 자주 할 일은 아니지만, 몇 달에 한 번이면 부담이 없다.
 */
function compactDb(db, { dryRun }) {
  const before = db.prepare("PRAGMA page_count").get().page_count;
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  const freelist = db.prepare("PRAGMA freelist_count").get().freelist_count;
  if (!dryRun) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  }
  const after = dryRun ? before : db.prepare("PRAGMA page_count").get().page_count;
  return { freedBytes: Math.max(0, (before - after) * pageSize), freelistPages: freelist };
}

/**
 * 청소 한 번. dryRun이면 아무것도 지우지 않고 "지웠다면 얼마나 줄었을지"만 센다.
 */
export function runCleanup(db, paths, { dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  const images = cleanImageCache(db, paths.imageCacheDir, { dryRun });
  const photos = cleanOrphanPhotos(db, paths.photoDir, { dryRun });
  const avatars = cleanOldAvatars(db, paths.avatarDir, { dryRun });
  // 파일을 지운 뒤에 접어야 이번 회차 결과가 반영된다
  const database = compactDb(db, { dryRun });

  const freedBytes = images.freedBytes + photos.freedBytes + avatars.freedBytes + database.freedBytes;
  return { startedAt, dryRun, images, photos, avatars, database, freedBytes };
}
