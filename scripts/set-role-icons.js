require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits } = require('discord.js');

const GUILD_ID = '1268523142897209405';

// 역할별 유니코드 이모지 아이콘 매핑
const ROLE_ICONS = {
  // 게임 역할
  'LOL':         '⚔️',
  'valorant':    '🎯',
  'apex':        '🦅',
  'pubg':        '🪖',
  'rainbow6':    '🛡️',
  'tarkov':      '🎒',
  '림버스':      '🔥',
  // 방장 역할
  'LOL 방장':       '👑',
  '발로란트 방장':  '👑',
  'apex 방장':      '👑',
  'pubg 방장':      '👑',
  'rainbow6 방장':  '👑',
  'tarkov 방장':    '👑',
  '림버스 방장':    '👑',
  // 기타
  '후원자':         '💎',
  '관리자':         '🛠️',
  '부 관리자':      '🔧',
  'VIP':            '⭐',
  '🎮 LOL 트래커':  '🎮',
  '디즈니+':        '🎬',
};

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN);

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.roles.fetch();

  console.log(`\n🎨 역할 아이콘 설정 시작 (${Object.keys(ROLE_ICONS).length}개)\n`);

  let success = 0;
  let failed = 0;

  for (const [roleName, emoji] of Object.entries(ROLE_ICONS)) {
    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (!role) {
      console.log(`⚠️  역할 없음: ${roleName}`);
      failed++;
      continue;
    }

    try {
      await role.edit({ unicodeEmoji: emoji });
      console.log(`✅ ${roleName} → ${emoji}`);
      success++;
    } catch (err) {
      console.log(`❌ ${roleName}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n🎉 완료! 성공: ${success}, 실패: ${failed}`);
  await client.destroy();
}

main().catch(console.error);
