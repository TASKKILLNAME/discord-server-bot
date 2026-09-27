# macOS 로컬 운영

패치노트 편집·게시 기준은 [PATCH_POSTING.md](PATCH_POSTING.md)를 따릅니다.

작업 폴더: `/Users/idongjun/server-migration/discord-server-bot-transfer`

## 이 Mac에서 준비된 항목

- npm 의존성 설치 및 macOS 네이티브 모듈 확인
- Homebrew PostgreSQL 16 서비스 시작 및 로그인 자동 시작 등록
- `.env`의 계정에 맞는 로컬 DB 생성 및 테이블 초기화
- 대시보드는 `127.0.0.1:3000`에서만 접근
- Windows 실행 명령을 유지하면서 macOS launchd 제어 추가

전송된 JSON 파일은 유지했습니다. PostgreSQL 백업은 발견되지 않아 DB는 빈 상태로 초기화했습니다. 기존 레벨, 멤버십, DB 기반 설정을 이어 쓰려면 Windows DB를 백업하여 복원해야 합니다.

## 수동 실행

이전 Windows/클라우드 인스턴스를 중지하고, 필요한 DB 복원을 마친 후 실행하세요. 시작 즉시 자동 알림 스케줄러가 작동할 수 있습니다.

```sh
cd ~/server-migration/discord-server-bot-transfer
npm run local:check
npm start
```

종료는 Ctrl+C입니다. 호스트 이전만 하는 경우 명령어 재등록은 필요 없습니다.
대시보드 주소는 `http://localhost:3000`이며, Discord OAuth2 Redirects에 `http://localhost:3000/auth/discord/callback`이 등록되어 있어야 로그인할 수 있습니다.

## 백그라운드 및 로그인 자동 시작

```sh
npm run local:install
npm run local:start
npm run local:status
```

`local:install`은 LaunchAgent 파일을 작성하고 다음 로그인부터 자동 시작하도록 설정합니다. 현재 세션에서는 `local:start`로 시작합니다. 예기치 않은 종료 시 launchd가 재시작합니다.

```sh
npm run local:stop
npm run local:uninstall
```

`local:stop`은 현재 세션의 서비스를 중지합니다. 다음 로그인 자동 시작까지 해제하려면 `local:uninstall`을 사용합니다. 로그는 `logs/bot-YYYY-MM-DD.log`와 `logs/launchd.stderr.log`에 기록됩니다. Mac이 꺼져 있거나 잠자기 상태이면 봇도 동작하지 않습니다.

2026-09-23: 사용자 요청으로 봇 백그라운드 실행 및 로그인 자동 시작을 등록했습니다. PostgreSQL과 봇 모두 실행 중이며, 기존 Discord 게임별 패치 채널 3개를 확인하여 로컬 DB에 등록했습니다.

---

# Windows 로컬 운영

이 구성은 Windows에 로그인해 있는 동안 봇을 실행하고, 예상치 못하게 종료되면 1분 후 다시 시작합니다. PC가 꺼지거나 절전 상태이면 봇도 오프라인입니다.

## 1. 로컬 PostgreSQL 준비

관리자 승인 창이 뜨면 `예`를 누릅니다.

```powershell
npm run local:db:install
```

이 명령은 PostgreSQL 16을 Windows 자동 시작 서비스로 설치하고, 외부에서는 접속할 수 없도록 `127.0.0.1:5432`에만 연결합니다. 봇 전용 database와 role을 만든 뒤 `.env`의 `DATABASE_URL`도 자동으로 설정합니다.

기존 DB의 기록을 새 DB에 복원하지 않았다면 레벨, 멤버십, 패치 알림 상태 등 DB 데이터는 빈 상태에서 시작합니다. `data/*.json`에 남아 있는 이벤트 및 알림 상태는 그대로 사용합니다.

## 2. 로컬 설정 점검

```powershell
Set-Location C:\Users\dongj\Desktop\discord-server-bot
npm ci
npm run local:check
```

`.env`에는 최소한 `DISCORD_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `DATABASE_URL`, `SESSION_SECRET`이 필요합니다. 새로 만들 때는 `.env.example`을 복사해서 실제 값을 입력합니다.

`DASHBOARD_URL=http://localhost:3000`이면 대시보드와 대시보드 링크는 이 PC에서만 열립니다. Discord bot 자체에는 포트 포워딩이나 Windows Firewall 인바운드 허용이 필요하지 않습니다.

대시보드 로그인을 사용한다면 Discord Developer Portal의 **OAuth2 → Redirects**에 아래 주소를 정확히 추가합니다.

```text
http://localhost:3000/auth/discord/callback
```

## 3. 한 번 직접 확인

기존 DigitalOcean/Railway 봇을 먼저 중지한 뒤 실행합니다. 같은 token의 봇 두 개를 동시에 실행하면 명령 응답과 자동 알림이 중복될 수 있습니다.

```powershell
npm start
```

콘솔에 봇 온라인, DB 초기화 완료, 대시보드 주소가 표시되는지 확인한 다음 `Ctrl+C`로 종료합니다. 호스트만 옮기는 경우 `npm run deploy-commands`는 다시 실행할 필요가 없습니다.

## 4. 로그인 자동 시작

예약 작업은 창이 없는 `BackgroundBotLauncher.exe`를 통해 Node.js를 실행합니다. 실행 중 PowerShell 프로세스를 유지하지 않습니다. PowerShell은 아래 등록·시작·중지 명령을 처리할 때만 잠시 사용합니다. 전용 실행 파일은 등록 시 `.local-runtime`에 빌드됩니다.

```powershell
npm run local:install
npm run local:start
```

이후 Windows 로그인 후 최대 30초 안에 자동으로 시작됩니다. 실행 상태와 로그는 다음 명령으로 확인합니다.

```powershell
npm run local:status
Get-Content .\logs\bot-*.log -Tail 100
```

중지하거나 자동 시작 등록을 제거할 때는 다음 명령을 사용합니다.

```powershell
npm run local:stop
npm run local:uninstall
```

Windows 전원 설정에서 사용 시간 동안 절전 진입을 막아야 봇이 계속 온라인입니다. 이벤트/라이브 알림은 중단 중 누락될 수 있습니다.

패치노트는 시작 시에도 최신 패치를 확인합니다. 채널별 `patch_deliveries`에 실제 전송 완료와 메시지 진행 위치를 저장하며, 실패하면 다음 검사에서 이어 보냅니다. 기존 `patch_state`는 전송 완료 판단에 사용하지 않습니다. 최초 전환 시 bot의 원문 링크 게시 이력을 확인해 이미 게시된 패치는 건너뜁니다. 메시지 기록 읽기 권한이 없거나 최근 2,000개 메시지로 이력을 확인할 수 없으면 중복 방지를 위해 전송을 보류하고 로그에 오류를 남깁니다.
