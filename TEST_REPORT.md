# Discord Server Bot 테스트 결과

## 2026-09-10 패치 알림 누락 수정 검증

시작 시 무알림 동기화를 제거하고, `patch_deliveries` 채널별 전송 기록을 사용하는 자동 전송 경로로 교체했다. 기존 crawler의 `checkForNewPatch()`/수동 최신 조회가 쓰는 `patch_state`는 자동 전송 완료 판단에 사용하지 않는다.

기존 테스트 83개와 새 배달 회귀 테스트 10개가 통과했다. 시작 시 새 패치 전송, 재검사 중복 차단, URL 정규화, 중간 전송 실패 후 재개, Discord 성공 후 DB 쓰기 실패 복구, DB 읽기 오류 시 전송 보류, 동시 요청 잠금, 기존 게시 이력 인식, 타인 메시지 배제, 채널별 실패 격리, 이력 조회 권한 오류와 원문 링크 자동 미리보기를 검증했다.

아래는 9월 3일의 기존 진단 기록이다. 당시 scheduler 시작 누락 및 2차 중복 방지 결함은 이번 변경으로 수정됐다. legacy crawler 단독 characterization tests와 요약 품질 등 다른 결함을 재현하는 테스트도 통과 수에 포함되므로, 통과 수가 프로젝트 전체의 무결함을 뜻하지 않는다.

- 실행일: 2026-09-03 (Asia/Seoul)
- 실행 환경: Windows, Node.js v24.13.0
- 기본 명령: `npm test`
- 패치노트 집중 명령: `npm run test:patch`

## 결론

전체 자동화 테스트는 **83개 실행, 83개 runner PASS, 예상하지 못한 실패 0개**다.
하지만 이 수치에는 현재의 잘못된 동작을 재현하도록 작성한 characterization test가 포함되어 있다.

| 판정 | 개수 | 의미 |
|---|---:|---|
| 정상 동작 확인 | 47 | 요구한 정상 결과가 나옴 |
| 현재 결함 재현 | 36 | `[KNOWN DEFECT]` 또는 `현재 결함 재현` 테스트가 잘못된 동작을 실제로 재현함 |
| 예상하지 못한 실패 | 0 | 테스트 자체의 실패나 새 회귀 없음 |

따라서 `83 PASS`를 “버그 없음”으로 해석하면 안 된다. 현재 확인된 결함이 있으며, 특히 패치노트 중복·누락·요약 검증 문제가 재현됐다.

## 기능별 결과

| 기능 영역 | 테스트한 내용 | 결과 |
|---|---|---|
| Command 등록 | 24개 command module 로드, Discord payload 직렬화, 이름 중복 | 정상 |
| 서버 템플릿 | 게임/스터디/프로젝트/커뮤니티/비즈니스 5종 기본 구조 | 정상 |
| LoL 분석 유틸 | stat 정규화, champion pool, match/death parser, rank 표시, layout parser | 정상 |
| 레벨 | XP 지급, cooldown, level 계산 | 정상 |
| Credit 기본 사용 | row lock, 차감, history, commit/rollback | service 단독 동작은 정상 |
| Membership 결제 | 충전/history 원자성, 중복 승인 | 결함 재현 |
| Event | 생성 직후 reminder | 결함 재현 |
| Patch crawler | 동일 URL 차단, HTML 본문 파싱 | 정상 조건에서는 정상 |
| Patch 중복 방지 | DB 읽기/쓰기 실패, 동시 실행, URL 변형, force 조회, scheduler 2차 방어 | 결함 재현 |
| Patch 레이아웃 | 정상 section 변환, 1,024자 제한, 25개 field 분할, AI 실패 표시 | 정상 |
| Patch 요약 준수 | header 누락, 장문/원문형 AI 응답 검증 | 결함 재현 |
| Dashboard | 401/403 접근 차단, loopback bind | 정상 |
| Dashboard Patch API | 수동 실행, 상태 조회 | 결함 재현 |
| Chzzk/LCK | 동일 방송을 구독한 여러 guild 알림 | 결함 재현 |
| Discord kick/ban 권한 | `Administrator` 전용 검사 | 수정 후 정상 |
| Discord LoL 계정 권한 | 다른 사용자의 LoL 계정 변경 | 결함 재현 |
| Welcome/Game role/Vote/Temp voice | template 치환, role 교체, vote 상태, staff 판정 | mock 기준 정상 |
| Project Moon/Limbus | RSS parsing, profile SQL parameter 전달 | mock 기준 정상 |
| 이미지 생성 | browser 재사용, page 정리, 사용자 field escape | 정상 |
| 이미지 안전성 | AI HTML 삽입, 동일 시각 파일명 충돌 | 결함 재현 |
| Emoji 확대 | handler 자체 동작, bot event 연결 | handler는 정상이나 실제 bot에 연결되지 않음 |
| 로컬 실행 준비 | 환경변수 검사 | `DATABASE_URL` 누락으로 E2E 시작 불가 |

## 패치노트 집중 결과

`npm run test:patch`: **32개 실행, runner PASS 32, 예상하지 못한 실패 0**. 의미상 정상 확인 10개, 결함 재현 22개다.

확인된 정상 동작:

- PostgreSQL이 정상이고 저장 URL이 완전히 같으면 LoL/Valorant/TFT 모두 자동 재게시하지 않는다.
- 정상적인 `## section` 형식의 요약은 Discord field로 변환되고, field 길이와 개수 제한도 처리한다.
- `ANTHROPIC_API_KEY`가 없거나 요약이 실패하면 원문을 요약처럼 그대로 게시하지 않고 실패 안내와 원문 링크를 보낸다.

재현된 중복 게시 경로:

1. `patch_state` 저장 실패를 crawler가 외부로 전달하지 않아 같은 패치가 다음 검사에서도 다시 반환된다.
2. `patch_state` 조회 실패를 “기존 기록 없음”으로 처리해 이미 올린 패치를 새 패치로 판단한다.
3. checker가 동시에 두 번 실행되면 둘 다 이전 상태를 읽고 같은 패치를 반환한다. DB lock이나 atomic claim이 없다.
4. 같은 URL도 trailing slash 차이가 있으면 새 패치로 판단한다.
5. crawler가 같은 patch를 반환했을 때 scheduler에는 별도의 중복 차단이 없다.
6. 수동 `forceGetLatestPatch`는 기존 게시 여부와 무관하게 매번 반환하므로 명령을 반복하면 재게시된다.

정확한 제한: **정상 DB + 단일 실행 + 완전히 같은 URL**에서는 중복 차단이 된다. 즉 항상 중복 게시되는 것은 아니며, 위 조건에서 방어가 깨진다.

로컬 운영에서 재현된 누락 경로:

- bot 시작 시 `syncCurrentPatch`가 최신 URL을 알림 없이 `patch_state`에 저장한다. PC가 꺼져 있던 사이 패치가 올라오면 다음 부팅에서 그 패치를 게시하지 않고 처리 완료 상태로 만든다.

요약/레이아웃 결함:

1. prompt에는 각 항목을 1~2줄로 요약하라고 적혀 있지만, formatter는 실제 줄 수·길이·필수 section·원문 복사 여부를 검증하지 않는다.
2. 모델 응답이 `## ` header 아래에 장문 원문을 넣으면 최대 1,024자까지 그대로 게시한다.
3. 모델이 `## ` header를 생략하면 모든 내용이 버려져 field가 0개인 결과가 된다.

이는 **검증 로직 결함을 mock 응답으로 재현한 결과**다. 실제 Anthropic API를 호출해 현재 모델의 요약 품질이나 사실성을 평가한 것은 아니다.

## 그 외 확인된 결함

2026-09-03에 `/멤버 킥`, `/멤버 밴`은 `Administrator`만 실행하도록 수정했다. `ModerateMembers`, `KickMembers`, `BanMembers`를 모두 가지고 있어도 `Administrator`가 없으면 ephemeral 오류로 차단되며 실제 kick/ban은 호출되지 않는 회귀 테스트를 통과했다.

| 중요도 | 결함 | 재현 결과 |
|---|---|---|
| 높음 | `/전적 등록`, `/전적 해제`에서 다른 멤버를 지정할 때 별도 관리자 권한 검사 없음 | 권한 0인 actor가 target 계정을 등록·해제함 |
| 높음 | Membership 승인 idempotency 없음 | 같은 승인 interaction을 두 번 처리하면 두 번 충전됨 |
| 높음 | Membership 충전과 history 기록이 transaction이 아님 | history 실패 시 credit만 반영되는 부분 성공 가능 |
| 높음 | Credit 확인과 사용이 분리됨 | credit 1인 상태의 동시 AI 요청 2개가 모두 결과를 받음 |
| 중간 | `/분석`, `/메타` 안내와 구현 불일치 | 도움말은 credit 사용을 안내하지만 command에는 확인·차감 코드가 없음 |
| 중간 | AI fallback도 성공으로 취급 | 실제 분석 실패 후 fallback 결과에도 credit 차감 |
| 중간 | 신규 Event reminder 데이터 이름 불일치 | 생성은 `attendees`, scheduler는 `participants`를 순회해 `TypeError` |
| 중간 | Chzzk 다중 guild 알림 상태가 channel 전역 | 같은 Chzzk 채널을 구독한 두 guild 중 첫 guild에만 전송 |
| 중간 | Dashboard 수동 Patch API import 오류 | 없는 `src/services/patchScheduler`를 require하여 500 |
| 중간 | Dashboard Patch 상태 비동기 처리 오류 | `loadLastPatch()`를 await하지 않아 응답 field가 빠짐 |
| 낮음 | Emoji 확대 기능 미연결 | handler 단독 테스트는 되지만 `src/index.js`에서 import/call하지 않음 |
| 낮음 | 이미지 template에 AI text를 HTML escape 없이 삽입 | 임의 HTML이 그대로 들어감 |
| 낮음 | 이미지 파일명이 `Date.now()`만 사용 | 같은 millisecond의 두 요청이 같은 output path를 사용함 |

## 공식 패치 페이지 실연동 점검

운영 DB와 Discord에는 접근하지 않고 공식 공개 페이지만 읽었다.

| 게임 | 최신 문서 탐색 | 상세 제목/본문 추출 | 관찰 |
|---|---|---|---|
| LoL | 성공 | `26.17 패치 노트`, 15,013자 | 본문 상한에서 잘림 |
| Valorant | 성공 | `발로란트 13.05 패치 노트`, 3,110자 | 정상 추출 |
| TFT | 성공 | `전략적 팀 전투 18.1 패치`, 15,013자 | 본문 상한에서 잘림 |

세 게임 모두 목록 카드의 `title`에는 category/date/description이 붙은 긴 문자열이 들어왔다. 상세 페이지의 `h1`은 정상인데, 저장할 때 `latest.title`을 우선해 Dashboard 상태 등에 지저분한 제목이 남을 수 있다.

확인한 공식 문서:

- [LoL 26.17 패치 노트](https://www.leagueoflegends.com/ko-kr/news/game-updates/league-of-legends-patch-26-17-notes)
- [Valorant 13.05 패치 노트](https://playvalorant.com/ko-kr/news/game-updates/valorant-patch-notes-13-05)
- [TFT 18.1 패치](https://teamfighttactics.leagueoflegends.com/ko-kr/news/game-updates/teamfight-tactics-patch-18-1)

## 테스트하지 못한 범위

`.env`에 `DATABASE_URL`이 없어 실제 bot E2E를 시작하지 않았다. 따라서 실제 Discord guild mutation, PostgreSQL migration/query, OAuth callback, Riot/Chzzk/YouTube 장애·rate limit, 실제 Puppeteer rendering, Windows Task Scheduler 자동 시작은 검증하지 않았다. 운영 Discord 메시지 전송이나 Membership 변경도 수행하지 않았다.

AI는 formatter와 실패 처리만 mock으로 검증했다. 실제 API 호출 비용과 운영 메시지 위험 때문에 Anthropic live 요약은 실행하지 않았다.

## 추가된 테스트 파일

- `tests/commands-smoke.test.js`: command 등록/정적 local import
- `tests/core-utils.test.js`: 분석·parser·template
- `tests/service-behavior.test.js`: 주요 service 정상 동작
- `tests/patch-duplicate.test.js`: LoL/Valorant/TFT 중복 방지 matrix
- `tests/patch-layout.test.js`: crawler·요약 layout·scheduler
- `tests/credits-regressions.test.js`: credit/membership 회귀
- `tests/dashboard.test.js`: Dashboard route/상태
- `tests/feature-regressions.test.js`: Event/Chzzk/권한/wiring 회귀
- `tests/image-service.test.js`: Puppeteer lifecycle/template 안전성
