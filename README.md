# 🤖 Discord Server Manager Bot

디스코드 서버를 원하는대로 자동 구성해주는 봇입니다.

## ✨ 기능

### 🛠️ 서버 자동 구성 (`/서버구성`)
5가지 프리셋 템플릿으로 서버를 원클릭 구성:
- 🎮 **게임 커뮤니티** - 롤, 발로란트, 마크 등 게임 채널 + 음성방
- 📚 **스터디 그룹** - 자료공유, TIL, 스터디룸
- 🏢 **프로젝트 팀** - 백엔드/프론트 채널, 스크럼, Git 로그
- 🎵 **커뮤니티** - 취미/관심사 커뮤니티
- 🏪 **비즈니스** - 쇼핑몰/브랜드 커뮤니티 (직원 전용 채널 포함)

### 📝 채널 관리 (`/채널`)
- 생성 (텍스트/음성/카테고리/공지/포럼)
- 삭제, 이동, 잠금/잠금해제
- **대량 생성** - 쉼표로 구분하여 한번에 여러 채널 생성

### 👤 역할 관리 (`/역할`)
- 생성 (이름, 색상, 분리표시)
- 삭제, 부여, 제거
- 목록 확인, 색상 변경
- **전체 부여** - 모든 멤버에게 한번에 역할 부여

### 👥 멤버 관리 (`/멤버`)
- 정보 확인, 킥, 밴/언밴
- 타임아웃 (1분~1주)
- 닉네임 변경

### ⚙️ 서버 설정 (`/서버설정`)
- 서버 정보 확인
- 이름 변경, 인증 레벨, 알림 필터

---

## 🚀 설치 방법

### 1. Discord Bot 생성

1. [Discord Developer Portal](https://discord.com/developers/applications) 접속
2. **New Application** 클릭 → 이름 입력 → 생성
3. 왼쪽 메뉴 **Bot** 클릭
4. **Reset Token** → 토큰 복사 (한번만 보임!)
5. **Privileged Gateway Intents** 에서 아래 3개 모두 ON:
   - ✅ PRESENCE INTENT
   - ✅ SERVER MEMBERS INTENT
   - ✅ MESSAGE CONTENT INTENT

### 2. Bot 서버 초대

1. 왼쪽 메뉴 **OAuth2** → **URL Generator**
2. SCOPES에서 `bot`, `applications.commands` 체크
3. BOT PERMISSIONS에서 `Administrator` 체크
4. 생성된 URL로 접속하여 서버에 봇 초대

### 3. 프로젝트 설정

```bash
# 프로젝트 폴더로 이동
cd discord-server-bot

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
```

`.env` 파일 편집:
```env
DISCORD_TOKEN=여기에_봇_토큰_입력
CLIENT_ID=여기에_애플리케이션_ID_입력
GUILD_ID=여기에_테스트_서버_ID_입력    # 선택사항
```

> 💡 **CLIENT_ID**: Developer Portal → General Information → Application ID
> 💡 **GUILD_ID**: 디스코드에서 서버 우클릭 → 서버 ID 복사 (개발자 모드 필요)

### 4. 명령어 등록 & 봇 시작

```bash
# 슬래시 명령어 등록 (처음 1번만)
npm run deploy-commands

# 봇 시작
npm start

# 개발 모드 (자동 재시작)
npm run dev
```

---

## 📁 프로젝트 구조

```
discord-server-bot/
├── src/
│   ├── index.js              # 메인 봇 엔트리
│   ├── deploy-commands.js     # 슬래시 명령어 등록
│   ├── commands/
│   │   ├── setup.js           # /서버구성 - 템플릿 자동 구성
│   │   ├── channel.js         # /채널 - 채널 관리
│   │   ├── role.js            # /역할 - 역할 관리
│   │   ├── member.js          # /멤버 - 멤버 관리
│   │   ├── serverSettings.js  # /서버설정 - 서버 설정
│   │   └── help.js            # /도움말
│   ├── templates/
│   │   └── serverTemplates.js # 서버 구성 템플릿 정의
│   ├── utils/
│   │   └── serverSetup.js     # 서버 구성 유틸리티
│   └── events/                # (확장용)
├── .env.example
├── package.json
└── README.md
```

---

## 💡 사용 예시

### 서버 자동 구성
1. `/서버구성` 입력
2. 원하는 템플릿 선택 (게임/스터디/프로젝트 등)
3. 미리보기 확인
4. **"✅ 구성 시작"** 또는 **"🗑️ 초기화 후 구성"** 선택
5. 자동으로 역할 + 카테고리 + 채널 생성!

### 채널 대량 생성
```
/채널 대량생성 이름들: 일반, 공지, 자유, 질문 종류: 텍스트
```
→ 4개 텍스트 채널 한번에 생성

### 역할 전체 부여
```
/역할 전체부여 역할: @멤버
```
→ 모든 멤버에게 역할 부여

---

## ⚠️ 주의사항

- 봇에 **Administrator** 권한이 필요합니다
- "초기화 후 구성"은 **기존 채널을 모두 삭제**합니다 (되돌릴 수 없음!)
- Discord Rate Limit으로 인해 대량 작업 시 약간의 딜레이가 있습니다
- GUILD_ID 없이 명령어를 등록하면 글로벌 등록 (반영까지 최대 1시간)

---

## 🔧 커스터마이징

### 새 템플릿 추가
`src/templates/serverTemplates.js`에 새 템플릿을 추가할 수 있습니다:

```javascript
myTemplate: {
  name: '🎯 내 템플릿',
  description: '커스텀 서버 구성',
  roles: [
    { name: '역할이름', color: '#FF0000', hoist: true, permissions: [] }
  ],
  categories: [
    {
      name: '카테고리이름',
      channels: [
        { name: '채널이름', type: ChannelType.GuildText },
        { name: '음성채널', type: ChannelType.GuildVoice },
      ]
    }
  ]
}
```

---

Made with ❤️ by LEE
