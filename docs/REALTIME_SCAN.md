# /전적 실시간 — 아군 스캔

## 변경 범위

수동 `/전적 실시간 소환사명:이름 태그:태그`는 조회한 계정을 제외한 같은 팀 최대 4명을 Embed 하나에 표시한다. 상대팀과 조회한 계정의 개인 전적·랭크는 요청하지 않는다. 해당 계정의 PUUID가 현재 경기에서 유일하게 확인되지 않으면 분석을 중단한다.

이 명령은 LLM을 호출하지 않는다. 게임 중이 아니면 그 사실만 안내하며, 최근 경기 AI 분석으로 전환하지 않는다. 현재 게임은 소환사의 협곡(mapId 11)에서 지원한다. 자유랭크·일반 게임에서도 개인 통계의 기준은 최근 솔랭임을 표시한다.

자동 게임 감지 알림의 기존 AI 분석, `/전적 최근전적`, `/전적 승부예측`의 기존 첩자 예측은 별도 기능으로 유지한다. 이번 첩자 **개인 위험도**와 승부예측의 **과거 아군 부진 인원 분포**는 다른 계산이다.

## 파일과 재사용

| 파일 | 역할 |
|---|---|
| `src/commands/lol.js` | 기존 slash command 입력을 유지하고 아군 스캔·단일 Embed 연결 |
| `src/commands/help.js` | 변경된 명령 설명 |
| `src/services/riotService.js` | 기존 Account-V1, Spectator-V5, League-V4, Match-V5, rate-limit 큐 재사용; 취소 signal과 엄격한 rank 조회 추가 |
| `src/constants/realtimeAnalysis.js` | 표본·신뢰도·시간 제한과 포지션 순서 |
| `src/services/playerAnalysisService.js` | 실제 유효 전적 수, 승패, 주챔 2개, 포지션 분포, 연패 집계 |
| `src/services/roleAnalyzer.js` | 팀 전체 포지션 배정과 라인 꼬임 판정 |
| `src/services/spyAnalyzer.js` | 외부 호출 없는 deterministic 점수 계산 |
| `src/services/realtimeService.js` | 본인 식별, 아군만 조회, 캐시, 시간 제한과 오류 격리 |
| `src/services/realtimeLayoutService.js` | 한 사람당 최대 6줄, 근거 태그 최대 3개, 단일 Embed |
| `src/utils/asyncCache.js` | 크기·TTL 제한, 동시 요청 공유, 호출별 취소 격리 |
| `tests/realtime-*.test.js`, `tests/helpers/realtime-fixture.js` | 분석·조회·캐시·표시 테스트와 가상 경기 데이터 |
| `tests/no-credits.test.js` | 실시간에 AI를 기대하던 기존 회귀 테스트 수정 |
| `tests/commands-smoke.test.js` | source 검사 범위를 현재 checkout의 src/dashboard/scripts로 제한 |
| `README.md` | 아군 스캔 사용법과 문서 링크 |
| `docs/REALTIME_SCAN.md` | 구현·공식·호출량·검증·한계 설명 |
| `docs/realtime-example.txt` | 실제 formatter가 만든 가상 경기 출력 |

기존 `assets/lolps-champions.json`의 포지션별 챔피언 목록을 약한 추정 근거로 재사용한다. 이 스냅샷은 2026-04-10 자료이며 최신 패치 통계로 취급하지 않는다. 기존 `lolAnalyzer`는 자동 알림 등 다른 소비자가 있어 삭제하지 않는다.

## 통계와 현재 라인

- Match-V5 목록에서 `queue=420`, `count=20`을 요청한다. 중복 matchId, 다른 queue, 5분 미만 경기를 제외하고 실제 유효 표본 수를 표시한다. 제외된 경기를 채우기 위해 추가 페이지를 조회하지 않는다.
- 주챔은 해당 표본에서 플레이 횟수가 많은 상위 2개다. 동률은 가장 최근 경기, championId 순으로 결정한다. Mastery 누적 점수는 사용하지 않는다.
- 포지션은 Match-V5 `teamPosition`을 사용한다. `MIDDLE→MID`, `BOTTOM→ADC`, `UTILITY→SUPPORT`로 정규화한다. 빈 값·UNKNOWN은 포지션 분모에서 제외한다. 공동 1위는 주 포지션 미확정이다.
- 본인을 포함한 팀의 포지션을 중복 없이 배정한다. 5명이면 120개 배치를 비교한다. 점수 근거는 현재 챔피언의 포지션 목록, 그 챔피언의 최근 포지션, 전체 최근 포지션, Smite다. Smite가 하나이면 정글의 강한 근거다. 본인의 최근 전적을 이 목적으로 추가 조회하지 않는다.
- 최적 배치와 해당 플레이어의 라인이 다른 차선 배치의 점수 차이, 근거의 강도를 함께 사용해 confidence를 정한다. 이는 검증된 확률이 아니다. 0.75 미만은 `(추정)`으로 표시하고 첩자 분석을 보류한다.

## 라인 꼬임 판정

다음 조건을 모두 충족해야 한다.

```text
실제 최근 경기 수 >= 10
유효 포지션 표본 수 >= 10
현재 라인 confidence >= 0.75
유일한 주 포지션 != 현재 추정 포지션
주 포지션 경기 수 / 유효 포지션 표본 수 >= 0.50
현재 포지션 경기 수 / 유효 포지션 표본 수 <= 0.25
```

Riot가 제공한 Autofill 여부가 아니다. UI에는 `라인 꼬임 의심`으로 표시한다.

## 첩자 점수

`calculateSpyScore(player)`는 입력을 변경하거나 API·LLM을 호출하지 않는 순수 함수다. 티어는 공식에 포함하지 않는다.

| 항목 | 배점 |
|---|---|
| A. 라인 불일치, 최대 35 | 주 포지션과 같음 0; 다른 포지션이지만 현재 포지션 비율 40% 이상 10; 나머지 불일치 20; 위 꼬임 조건 충족 35 |
| B. 현재 챔피언 경험, 최대 20 | 5판 이상 0; 3~4판 5; 2판 10; 1판 15; 0판 20 |
| C. 최근 승률, 최대 20 | 50% 초과 0; 45% 초과~50% 5; 40% 초과~45% 10; 30% 초과~40% 15; 30% 이하 20 |
| D. 연패, 최대 10 | 0~1연패 0; 2연패 3; 3연패 6; 4연패 이상 10 |
| E. 현재 포지션 경험, 최대 15 | 5판 이상 0; 3~4판 5; 1~2판 10; 0판 15 |

총점은 A+B+C+D+E다. 반올림 전 승률을 계산에 사용한다. 화면 구간은 0~24 초록, 25~49 노랑, 50~69 주황, 70~100 빨강이며, 고위험 인원은 70점 이상을 센다. confidence는 현재 포지션 신뢰도·최근 표본/20·유효 포지션 표본/20의 최솟값이다.

유효 경기나 포지션 표본이 10개 미만, 주 포지션 미확정, 현재 포지션 근거 부족, 전적 조회 실패, 비공개 참가자는 `score: null`이다. 누락 항목을 0점이나 최대 점수로 채우거나 남은 항목을 100점으로 재환산하지 않는다. 랭크 조회 실패는 위험도와 독립이다.

전체 계산 근거와 항목별 점수는 결과에 보관하고 화면에는 최대 3개 이유만 표시한다. Footer는 항상 다음과 같다.

> 첩자 %는 실제 고의 패배 확률이 아닌 재미용 위험도 지표입니다.

## API 호출량과 캐시

재시도·Data Dragon 요청을 제외한 성공 경로의 계산이다. 기존 수동 실시간은 Account 1 + Spectator 1 + rank 최대 10 = 최대 12회의 Riot 호출과 LLM 1회였다.

개편 후 캐시가 비어 있고 공개 아군이 4명일 때 Account 1 + Spectator 1 + rank 4 + match 목록 4 + 서로 다른 match 상세 최대 80 = **최대 90회**, LLM 0회다. 실제 요청 수는 공유 경기 수, 비공개 참가자와 표본 수에 따라 줄어든다. 전부 유효한 캐시이면 추가 Riot 호출은 0회다. Spectator 캐시만 만료되면 1회다.

| 캐시 | TTL | 최대 항목 |
|---|---|---|
| Riot ID → account | 1시간 | 500 |
| PUUID → 현재 게임 | 10초 | 500 |
| PUUID → 최근 솔랭 | 3분 | 500 |
| matchId → 완료 경기 상세 | 6시간 | 2,000 |
| PUUID → Solo/Duo rank | 5분 | 500 |

동일 key의 진행 중 요청도 공유한다. 한 사용자의 timeout이 다른 사용자가 기다리는 요청을 취소하지 않는다. 대기자가 모두 취소되면 해당 공유 작업도 취소한다. 실패는 캐시하지 않는다. 전체 스캔은 60초 제한이며, 팀 식별 이후 시간 초과는 수집된 정보만 표시하고 불완전한 전적의 첩자 점수는 보류한다.

기존 Riot 요청 큐, 응답 헤더의 rate-limit, 429 Retry-After, 재시도를 그대로 사용한다. API 한도는 이 명령만의 전용 할당이 아니므로 다른 봇 기능과 함께 소모된다. [Riot API rate limits](https://developer.riotgames.com/docs/portal)

## 검증 및 출력 예시

```text
node --test tests/realtime-analysis.test.js tests/realtime-service.test.js tests/realtime-api.test.js
npm test
```

테스트는 실제 Riot API·Discord·DB 없이 실행한다. [realtime-example.txt](realtime-example.txt)는 가상 경기 데이터를 실제 서비스·Embed formatter에 통과시킨 결과다. Discord에 전송한 메시지나 실제 사용자 전적이 아니다.

2026-09-27 검증 결과: 전체 168개 통과, 실패 0개. 새 아군 스캔 테스트 34개가 포함된다. 기존 `[KNOWN DEFECT]` 테스트는 알려진 결함의 재현을 확인하므로 전체 통과가 기존 결함의 해결을 의미하지는 않는다. `git diff --check`도 통과했다.

## 데이터 한계

현재 라인은 추정이며 공식 배정 포지션이나 Autofill 판정이 아니다. 최근 최대 20개의 솔랭 목록에서 얻은 표본만 사용하므로 챔피언 0판은 생애 경험 없음이 아니다. 주 포지션 비율은 유효 포지션 데이터만의 비율이다. 역할 목록 스냅샷과 heuristic confidence는 최신 메타에서 정확도를 검증하지 않았다.

Riot ID 또는 PUUID가 비어 있는 참가자는 개인 전적을 조회하지 않는다. Riot ID를 과거 경기나 별도 API로 복원하지 않는다. [Riot의 숨겨진 플레이어 식별·분석 금지 정책](https://developer.riotgames.com/docs/lol)

라이브 API 응답·MacBook 실행·Discord 모바일/데스크톱 실제 화면 검증 및 배포는 이 작업에서 수행하지 않는다.
