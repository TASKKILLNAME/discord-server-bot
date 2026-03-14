require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { REST, Routes } = require('discord.js');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const GUILD_ID = '1268523142897209405';

// Move Members(16777216) + Mute Members(4194304) + Deafen Members(8388608)
const LEADER_PERMS = String(16777216 + 4194304 + 8388608);

const LEADER_ROLES = [
  {
    name: 'LOL 방장',
    color: 0,
    colors: { primary_color: 0x00E5FF, secondary_color: 0x0055FF },
    hoist: true, mentionable: false, permissions: LEADER_PERMS,
  },
  {
    name: '발로란트 방장',
    color: 0,
    colors: { primary_color: 0xFF4655, secondary_color: 0xBB1122 },
    hoist: true, mentionable: false, permissions: LEADER_PERMS,
  },
  {
    name: 'apex 방장',
    color: 0,
    colors: { primary_color: 0xFF6B35, secondary_color: 0xCC2200 },
    hoist: true, mentionable: false, permissions: LEADER_PERMS,
  },
  {
    name: 'pubg 방장',
    color: 0,
    colors: { primary_color: 0xF0C040, secondary_color: 0xCC7700 },
    hoist: true, mentionable: false, permissions: LEADER_PERMS,
  },
  {
    name: 'rainbow6 방장',
    color: 0,
    colors: { primary_color: 0x7BAEFF, secondary_color: 0x0033CC },
    hoist: true, mentionable: false, permissions: LEADER_PERMS,
  },
];

const TARGET_POSITIONS = {
  'LOL 방장':      13,
  '발로란트 방장': 12,
  'apex 방장':     11,
  'pubg 방장':     10,
  'rainbow6 방장':  9,
};

async function main() {
  console.log('🚀 방장 역할 생성 시작...\n');

  const createdIds = {};

  for (const role of LEADER_ROLES) {
    try {
      const created = await rest.post(Routes.guildRoles(GUILD_ID), { body: role });
      createdIds[role.name] = created.id;
      console.log(`✅ 생성: ${role.name} (id: ${created.id})`);
    } catch (err) {
      console.error(`❌ 실패: ${role.name} - ${err.message}`);
    }
  }

  console.log('\n📐 포지션 조정 중...');
  const positionUpdates = Object.entries(createdIds).map(([name, id]) => ({
    id,
    position: TARGET_POSITIONS[name],
  }));

  try {
    await rest.patch(Routes.guildRoles(GUILD_ID), { body: positionUpdates });
    console.log('✅ 포지션 조정 완료!');
  } catch (err) {
    console.error('⚠️ 포지션 조정 실패 (수동으로 드래그해주세요):', err.message);
  }

  console.log('\n🎉 완료! 생성된 역할:');
  Object.entries(createdIds).forEach(([name, id]) => {
    console.log(`  - ${name}: <@&${id}>`);
  });
}

main().catch(console.error);
