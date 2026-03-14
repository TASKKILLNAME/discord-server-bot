require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { REST, Routes, ChannelType } = require('discord.js');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const GUILD_ID = '1268523142897209405';
const EVERYONE = '1268523142897209405';

async function main() {
  console.log('➕ 트리거 음성채널 생성 중...\n');

  // 게임 카테고리 찾기
  const channels = await rest.get(Routes.guildChannels(GUILD_ID));
  const gameCategories = channels.filter(c =>
    c.type === ChannelType.GuildCategory &&
    (c.name.startsWith('🎮') || c.name.startsWith('🔫'))
  );

  for (const cat of gameCategories) {
    // 이미 트리거 채널이 있는지 확인
    const existing = channels.find(c =>
      c.parent_id === cat.id && c.name === '➕ 방 만들기'
    );
    if (existing) {
      console.log(`  ⏭️ ${cat.name} - 이미 있음`);
      continue;
    }

    await rest.post(Routes.guildChannels(GUILD_ID), {
      body: {
        name: '➕ 방 만들기',
        type: ChannelType.GuildVoice,
        parent_id: cat.id,
        bitrate: 64000,
      },
    });
    console.log(`  ✅ ${cat.name} - 트리거 채널 생성`);

    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n🎉 완료!');
}

main().catch(console.error);
