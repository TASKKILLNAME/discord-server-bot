/**
 * fix-leader-perms.js
 * 방장 역할에서 음소거(Mute Members) / 귀막기(Deafen Members) 권한 제거
 * 방 이동(Move Members) 권한만 유지
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

const GUILD_ID = '1268523142897209405';

const LEADER_ROLE_NAMES = [
  'LOL 방장',
  '발로란트 방장',
  'apex 방장',
  'pubg 방장',
  'rainbow6 방장',
  'tarkov 방장',
];

// 유지할 권한: Move Members만
const KEEP_PERMS = PermissionsBitField.Flags.MoveMembers;

// 제거할 권한
const REMOVE_PERMS =
  PermissionsBitField.Flags.MuteMembers |
  PermissionsBitField.Flags.DeafenMembers;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ 봇 로그인: ${client.user.tag}\n`);

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.roles.fetch(); // 역할 캐시 로드

  for (const roleName of LEADER_ROLE_NAMES) {
    const role = guild.roles.cache.find(r => r.name === roleName);

    if (!role) {
      console.log(`⚠️  역할을 찾을 수 없음: ${roleName}`);
      continue;
    }

    const current = role.permissions.bitfield;
    const hasMute   = role.permissions.has(PermissionsBitField.Flags.MuteMembers);
    const hasDeafen = role.permissions.has(PermissionsBitField.Flags.DeafenMembers);

    if (!hasMute && !hasDeafen) {
      console.log(`✅ ${roleName} — 이미 음소거/귀막기 없음 (스킵)`);
      continue;
    }

    // 음소거 + 귀막기 제거
    const newPerms = (current & ~REMOVE_PERMS).toString();

    try {
      await role.setPermissions(newPerms, '방장 권한 제한: 음소거/귀막기 제거');
      console.log(`🔧 ${roleName} (${role.id})`);
      console.log(`   제거: MuteMembers=${hasMute}, DeafenMembers=${hasDeafen}`);
      console.log(`   유지: MoveMembers=${role.permissions.has(KEEP_PERMS)}`);
    } catch (err) {
      console.error(`❌ ${roleName} 업데이트 실패:`, err.message);
    }
  }

  console.log('\n🎉 완료!');
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
