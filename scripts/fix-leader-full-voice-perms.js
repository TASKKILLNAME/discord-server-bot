/**
 * fix-leader-full-voice-perms.js
 *
 * 각 방장 역할에게 자기 게임 카테고리 음성채널에서
 * 음소거(MuteMembers) + 귀막기(DeafenMembers) + 방이동(MoveMembers) 허용
 *
 * ※ 관리자 보호: Discord 역할 계층 상 관리자 역할이 방장보다 높으면
 *    방장은 관리자 멤버에게 이 권한들을 행사할 수 없음 (자동 보호)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require('discord.js');

const GUILD_ID = '1268523142897209405';

const LEADER_CATEGORY_MAP = [
  { roleName: 'LOL 방장',      categoryKeyword: 'LOL'      },
  { roleName: '발로란트 방장', categoryKeyword: 'VALORANT' },
  { roleName: 'apex 방장',     categoryKeyword: 'APEX'     },
  { roleName: 'pubg 방장',     categoryKeyword: 'PUBG'     },
  { roleName: 'rainbow6 방장', categoryKeyword: 'RAINBOW6' },
  { roleName: 'tarkov 방장',   categoryKeyword: 'TARKOV'   },
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`✅ 봇 로그인: ${client.user.tag}\n`);

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.roles.fetch();
  await guild.channels.fetch();

  for (const { roleName, categoryKeyword } of LEADER_CATEGORY_MAP) {
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
      console.log(`⚠️  역할 없음: ${roleName}`);
      continue;
    }

    // 게임 카테고리 찾기
    const category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory &&
           c.name.toUpperCase().includes(categoryKeyword)
    );
    if (!category) {
      console.log(`⚠️  카테고리 없음 (키워드: ${categoryKeyword})`);
      continue;
    }

    console.log(`\n📁 [${roleName}] → ${category.name}`);

    // 카테고리 내 음성채널에 전체 오버라이드 적용
    const voiceChannels = guild.channels.cache.filter(
      c => c.parentId === category.id && c.type === ChannelType.GuildVoice
    );

    for (const [, vc] of voiceChannels) {
      await vc.permissionOverwrites.edit(role, {
        MuteMembers:   true,
        DeafenMembers: true,
        MoveMembers:   true,
      }, { reason: `${roleName} 전용 음성채널 풀 권한` });

      console.log(`   🔊 ${vc.name} → 음소거 ✅ 귀막기 ✅ 이동 ✅`);
    }
  }

  console.log('\n🎉 완료! (관리자 역할은 계층 상 자동 보호됨)');
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
