const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('도움말')
    .setDescription('봇의 모든 명령어를 확인합니다'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('🤖 Server Manager Bot - 명령어 도움말')
      .setDescription('서버를 자동으로 구성하고 관리하는 봇입니다.')
      .addFields(
        {
          name: '🛠️ 서버 관리',
          value: [
            '`/서버구성` — 템플릿으로 서버 자동 구성 (게임/스터디/프로젝트 등)',
            '`/서버설정 정보|이름변경|인증레벨|알림필터` — 서버 설정 관리',
          ].join('\n'),
        },
        {
          name: '📝 채널 관리',
          value: [
            '`/채널 생성|삭제|이동|잠금|잠금해제` — 채널 관리',
            '`/채널 대량생성` — 여러 채널 한번에 생성',
          ].join('\n'),
        },
        {
          name: '👤 역할 관리',
          value: [
            '`/역할 생성|삭제|부여|제거|목록` — 역할 관리',
            '`/역할 색상변경|전체부여` — 색상 변경, 전체 부여',
          ].join('\n'),
        },
        {
          name: '👥 멤버 관리',
          value: '`/멤버 정보|킥|밴|언밴|타임아웃|닉네임` — 멤버 관리',
        },
        {
          name: '👋 환영 시스템',
          value: '`/환영 설정|테스트|상태|끄기` — 환영 메시지 + 게임 역할 선택',
        },
        {
          name: '📊 레벨 시스템',
          value: '`/레벨 내정보|순위|정보` — 경험치, 레벨, 순위 확인',
        },
        {
          name: '🎮 롤 전적/트래커',
          value: [
            '`/전적 등록|해제|목록` — 롤 계정 등록/관리',
            '`/전적 채널설정` — 게임 자동 감지 알림 채널 설정',
            '`/전적 실시간|최근전적` — AI 게임 분석',
          ].join('\n'),
        },
        {
          name: '🧠 AI 코칭',
          value: [
            '`/분석` — 최근 게임 의사결정 AI 심층 분석 (1크레딧)',
            '`/메타` — 50게임 기반 플레이스타일 진단 + 코칭 (2크레딧)',
            '`/멤버십 구매|정보` — AI 분석 크레딧 관리',
          ].join('\n'),
        },
        {
          name: '📢 알림 시스템',
          value: [
            '`/패치노트 최신|설정|해제|상태` — 롤 패치노트 AI 요약 알림',
            '`/발로란트패치노트` — 발로란트 패치노트 알림',
            '`/tft패치노트` — TFT 패치노트 알림',
            '`/lck알림 설정|해제|상태` — LCK 경기 시작 알림',
          ].join('\n'),
        },
        {
          name: '🗓️ 이벤트',
          value: '`/이벤트 생성|목록|삭제` — 서버 이벤트 관리 + 자동 리마인더',
        },
      )
      .setColor('#5865F2')
      .setFooter({ text: '💡 일부 명령어는 관리자 권한이 필요합니다' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
