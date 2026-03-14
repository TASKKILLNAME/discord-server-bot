require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { REST, Routes, ChannelType } = require('discord.js');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const GUILD_ID         = '1268523142897209405';
const VOICE_CATEGORY   = '1268523142897209407'; // 음성 채널
const GAME_CATEGORY    = '1477302927260647535'; // 게임관련
const EVERYONE_ROLE    = '1268523142897209405'; // @everyone

// Move Members + Mute Members + Deafen Members
const LEADER_PERMS = String(16777216 + 4194304 + 8388608);

async function main() {
  console.log('🔫 Tarkov 관련 역할 & 채널 생성 중...\n');

  // ── 1. tarkov 게임 역할 ──────────────────────────────
  const tarkovRole = await rest.post(Routes.guildRoles(GUILD_ID), {
    body: {
      name: 'tarkov',
      color: 0,
      colors: { primary_color: 0x7B8C5E, secondary_color: 0x3D4A2E }, // 밀리터리 올리브 그라데이션
      hoist: true,
      mentionable: false,
      permissions: '0',
    },
  });
  console.log(`✅ 역할 생성: tarkov (${tarkovRole.id})`);

  // ── 2. tarkov 방장 역할 ───────────────────────────────
  const tarkovLeaderRole = await rest.post(Routes.guildRoles(GUILD_ID), {
    body: {
      name: 'tarkov 방장',
      color: 0,
      colors: { primary_color: 0xC8A96E, secondary_color: 0x7B5E2A }, // 금빛 모래 그라데이션
      hoist: true,
      mentionable: false,
      permissions: LEADER_PERMS,
    },
  });
  console.log(`✅ 역할 생성: tarkov 방장 (${tarkovLeaderRole.id})`);

  // ── 3. 포지션 조정 ────────────────────────────────────
  // tarkov → 기존 apex(9) 아래에 삽입
  // tarkov 방장 → 기존 방장들 사이
  await rest.patch(Routes.guildRoles(GUILD_ID), {
    body: [
      { id: tarkovRole.id,       position: 8 },
      { id: tarkovLeaderRole.id, position: 9 },
    ],
  }).catch(e => console.warn('⚠️ 포지션 조정 실패 (수동으로 드래그):', e.message));
  console.log('✅ 포지션 조정 완료');

  // ── 4. 음성 채널: tarkov ─────────────────────────────
  const voiceCh = await rest.post(Routes.guildChannels(GUILD_ID), {
    body: {
      name: 'tarkov',
      type: ChannelType.GuildVoice,
      parent_id: VOICE_CATEGORY,
      bitrate: 64000,
      permission_overwrites: [
        { id: EVERYONE_ROLE,    type: 0, deny: '1049600', allow: '0' },
        { id: tarkovRole.id,    type: 0, allow: '1049600', deny: '0' },
      ],
    },
  });
  console.log(`✅ 음성 채널 생성: tarkov (${voiceCh.id})`);

  // ── 5. 텍스트 채널: 게임관련 ─────────────────────────
  const textCh = await rest.post(Routes.guildChannels(GUILD_ID), {
    body: {
      name: '📝tarkov-뉴스',
      type: ChannelType.GuildText,
      parent_id: GAME_CATEGORY,
      permission_overwrites: [
        { id: EVERYONE_ROLE,    type: 0, deny: '1024', allow: '0' },
        { id: tarkovRole.id,    type: 0, allow: '1024', deny: '0' },
      ],
    },
  });
  console.log(`✅ 텍스트 채널 생성: 📝tarkov-뉴스 (${textCh.id})`);

  console.log(`
🎉 Tarkov 세팅 완료!
  - 역할: tarkov
  - 역할: tarkov 방장
  - 음성: tarkov (음성 채널 카테고리)
  - 텍스트: 📝tarkov-뉴스 (게임관련 카테고리)
  `);
}

main().catch(console.error);
