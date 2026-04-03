/**
 * fix-leader-move-perms.js
 * 
 * - 방장 역할 서버 전체 권한에서 Move Members 제거
 * - 각 게임 카테고리의 음성채널에만 해당 방장 role 오버라이드로 Move Members 허용
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require('discord.js');

const GUILD_ID = '1268523142897209405';

// 방장 역할명 → 해당 게임 카테고리 이름 키워드 매핑
const LEADER_CATEGORY_MAP = [
  { roleName: 'LOL 방장',      categoryKeyword: 'LOL'       },
  { roleName: '발로란트 방장', categoryKeyword: 'VALORANT'  },
  { roleName: 'apex 방장',     categoryKeyword: 'APEX'      },
  { roleName: 'pubg 방장',     categoryKeyword: 'PUBG'      },
  { roleName: 'rainbow6 방장', categoryKeyword: 'RAINBOW6'  },
  { roleName: 'tarkov 방장',   categoryKeyword: 'TARKOV'    },
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

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

    // 1. 서버 전체 권한에서 Move Members 제거
    if (role.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
      const newPerms = (role.permissions.bitfield & ~PermissionsBitField.Flags.MoveMembers).toString();
      await role.setPermissions(newPerms, '방장 서버 전체 이동 권한 제거');
      console.log(`🔧 [${roleName}] 서버 전체 MoveMembers 제거`);
    } else {
      console.log(`✅ [${roleName}] 이미 서버 전체 MoveMembers 없음`);
    }

    // 2. 해당 게임 카테고리 찾기
    const category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory &&
           c.name.toUpperCase().includes(categoryKeyword)
    );

    if (!category) {
      console.log(`⚠️  [${roleName}] 카테고리 없음 (키워드: ${categoryKeyword})`);
      continue;
    }

    console.log(`📁 [${roleName}] 카테고리: ${category.name} (${category.id})`);

    // 3. 카테고리 내 음성채널에만 Move Members 오버라이드 추가
    const voiceChannels = guild.channels.cache.filter(
      c => c.parentId === category.id && c.type === ChannelType.GuildVoice
    );

    if (voiceChannels.size === 0) {
      console.log(`⚠️  [${roleName}] 해당 카테고리에 음성채널 없음`);
      continue;
    }

    for (const [, vc] of voiceChannels) {
      await vc.permissionOverwrites.edit(role, {
        MoveMembers: true,
      }, { reason: `${roleName} 전용 음성채널 이동 권한` });
      console.log(`   🔊 ${vc.name} → MoveMembers 허용`);
    }
  }

  console.log('\n🎉 완료!');
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
