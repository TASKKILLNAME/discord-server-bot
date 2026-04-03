require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const CHANNEL_ID = '1462735967075962920';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  const channel = await client.channels.fetch(CHANNEL_ID);

  const embed = new EmbedBuilder()
    .setTitle('📋 서버 업데이트 내역')
    .setColor(0x5865F2)
    .setTimestamp()
    .addFields(
      {
        name: '🎮 게임 카테고리 구조 개편',
        value: [
          '각 게임마다 전용 카테고리 생성',
          '해당 게임 역할이 없으면 채널이 보이지 않습니다',
          '',
          '🎮 **LOL** → 💬lol-채팅 / 📝패치노트 / 🔊음성채널 / 🏆lck-알림 / 🤖매칭정보',
          '🎮 **VALORANT** → 💬발로란트-채팅 / 📝패치노트 / 🔊음성채널',
          '🎮 **APEX** → 💬apex-채팅 / 📝패치노트 / 🔊음성채널',
          '🎮 **PUBG** → 💬pubg-채팅 / 📝패치노트 / 🔊음성채널',
          '🎮 **RAINBOW6** → 💬rainbow6-채팅 / 📝패치노트 / 🔊음성채널',
          '🔫 **TARKOV** → 💬tarkov-채팅 / 📝tarkov-뉴스 / 🔊음성채널',
        ].join('\n'),
      },
      {
        name: '👑 방장 역할 추가',
        value: [
          'LOL / 발로란트 / apex / pubg / rainbow6 / tarkov 방장 역할 생성',
          '게임별 색상 구분 · 멤버 목록 상단 별도 표시',
        ].join('\n'),
      },
      {
        name: '🔒 방장 권한 조정',
        value: [
          '서버 전체 권한은 없으며, 자기 게임 카테고리 음성채널 안에서만 아래 권한 사용 가능',
          '',
          '✅ 음소거(Mute) — 자기 게임 음성채널에서만',
          '✅ 귀막기(Deafen) — 자기 게임 음성채널에서만',
          '✅ 방 이동(Move) — 자기 게임 음성채널에서만',
          '',
          '⚠️ 관리자 역할 보유자에게는 적용 불가 (역할 계층으로 자동 보호)',
        ].join('\n'),
      },
      {
        name: '🎯 Tarkov 신규 추가',
        value: [
          'tarkov 역할 · tarkov 방장 역할 생성',
          'tarkov 음성채널 · 📝tarkov-뉴스 텍스트채널 추가',
        ].join('\n'),
      }
    );

  await channel.send({ embeds: [embed] });
  console.log('✅ 공지 전송 완료');
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
