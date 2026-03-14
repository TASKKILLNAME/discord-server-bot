require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { REST, Routes, ChannelType } = require('discord.js');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const GUILD_ID    = '1268523142897209405';
const EVERYONE    = '1268523142897209405';

// ── 게임 역할 ID ──────────────────────────────────────
const ROLES = {
  lol:       '1462734611527499838',
  valorant:  '1462734448901492843',
  apex:      '1462734548008697856',
  pubg:      '1462736830981210225',
  rainbow6:  '1468235099454832774',
  tarkov:    '1482258801242669137',
};

// ── 기존 채널 ID (이동 대상) ───────────────────────────
const EXISTING = {
  lol: {
    text:  [
      '1472637487590412460', // 📝lol-패치노트
      '1477302564323328050', // 🎮lck-알림
      '1474057114329808906', // 🤖lol-매칭정보
    ],
    voice: '1463871001350635572', // lol
  },
  valorant: {
    text:  ['1477302619079966923'], // 📝val-패치노트
    voice: '1462736433268654167',
  },
  apex: {
    text:  [],
    voice: '1269517163027370015',
  },
  pubg: {
    text:  [],
    voice: '1462736775083462707',
  },
  rainbow6: {
    text:  [],
    voice: '1468235410764337464',
  },
  tarkov: {
    text:  ['1482258807131476131'], // 📝tarkov-뉴스
    voice: '1482258805420200009',
  },
};

// ── 새로 만들 채팅방 이름 ──────────────────────────────
const CHAT_NAMES = {
  lol:      '💬lol-채팅',
  valorant: '💬발로란트-채팅',
  apex:     '💬apex-채팅',
  pubg:     '💬pubg-채팅',
  rainbow6: '💬rainbow6-채팅',
  tarkov:   '💬tarkov-채팅',
};

const CATEGORY_NAMES = {
  lol:      '🎮 LOL',
  valorant: '🎮 발로란트',
  apex:     '🎮 APEX',
  pubg:     '🎮 PUBG',
  rainbow6: '🎮 RAINBOW6',
  tarkov:   '🔫 TARKOV',
};

function categoryPerms(roleId) {
  return [
    { id: EVERYONE, type: 0, deny: '1049600', allow: '0' },
    { id: roleId,   type: 0, allow: '1049600', deny: '0'  },
  ];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('🚀 게임 카테고리 구조 재편 시작!\n');

  for (const game of Object.keys(ROLES)) {
    console.log(`\n── ${CATEGORY_NAMES[game]} ──`);
    const roleId = ROLES[game];
    const perms  = categoryPerms(roleId);

    // 1. 카테고리 생성
    const cat = await rest.post(Routes.guildChannels(GUILD_ID), {
      body: {
        name: CATEGORY_NAMES[game],
        type: ChannelType.GuildCategory,
        permission_overwrites: perms,
      },
    });
    console.log(`  ✅ 카테고리 생성: ${cat.name} (${cat.id})`);
    await sleep(400);

    // 2. 새 채팅방 생성
    await rest.post(Routes.guildChannels(GUILD_ID), {
      body: {
        name: CHAT_NAMES[game],
        type: ChannelType.GuildText,
        parent_id: cat.id,
        permission_overwrites: perms,
      },
    });
    console.log(`  ✅ 채팅방 생성: ${CHAT_NAMES[game]}`);
    await sleep(400);

    // 3. 기존 텍스트 채널 이동
    for (const chId of EXISTING[game].text) {
      await rest.patch(Routes.channel(chId), {
        body: { parent_id: cat.id, lock_permissions: false },
      });
      console.log(`  ✅ 텍스트 이동: ${chId}`);
      await sleep(400);
    }

    // 4. 기존 음성 채널 이동
    await rest.patch(Routes.channel(EXISTING[game].voice), {
      body: { parent_id: cat.id, lock_permissions: false },
    });
    console.log(`  ✅ 음성 이동: ${EXISTING[game].voice}`);
    await sleep(400);
  }

  console.log('\n🎉 게임 카테고리 구조 재편 완료!');
}

main().catch(console.error);
