# BGG 컬렉션 자동 동기화

매일 자동으로 BGG 컬렉션을 받아와서 JSON으로 변환해 GitHub Pages에 올려두는 저장소입니다.
티스토리 스킨은 이 JSON 파일 주소만 fetch하면 되고, BGG를 직접 호출하지 않습니다.

## 처음 설정할 것 (한 번만)

1. **새 GitHub 저장소 만들기** (Public이어야 GitHub Pages 무료로 씀). 이 폴더 안의 파일들을
   (`.github/workflows/update-bgg-collection.yml`, `scripts/csv_to_json.py`) 그대로 업로드/커밋.

2. **본인 BGG 아이디 등록**
   저장소 `Settings` → `Secrets and variables` → `Actions` → `Variables` 탭 →
   `New repository variable` → 이름 `BGG_USERNAME`, 값에 본인 BGG 아이디(`luckily2027`) 입력.

3. **GitHub Pages 켜기**
   저장소 `Settings` → `Pages` → `Source`를 `Deploy from a branch`로,
   브랜치는 `main`, 폴더는 `/docs`로 지정 → 저장.

4. **한 번 수동 실행해서 첫 데이터 만들기**
   저장소 `Actions` 탭 → `Update BGG collection` 워크플로 선택 → `Run workflow` 버튼 클릭.
   1~2분 후 `docs/collection.json`이 생기고 커밋됩니다.

5. 완료되면 아래 주소에서 JSON이 보여야 합니다 (몇 분 정도 걸릴 수 있음):
   `https://<본인GitHub아이디>.github.io/<저장소이름>/collection.json`

이후로는 매일 정해진 시간(워크플로 파일의 cron 부분, 기본값 한국시간 오전 6시)에
자동으로 갱신됩니다. 시간 바꾸고 싶으면 `update-bgg-collection.yml`의 `cron` 값만 수정하면 돼요.

## 다음 단계

주소가 잘 뜨는 거 확인되면, 그 주소를 스킨의 `script.js`에서 fetch해서
태그로 언급된 게임 이름과 매칭 → 평점/플레이횟수 자동으로 카드에 표시하는 부분을 이어서 만들면 됩니다.
