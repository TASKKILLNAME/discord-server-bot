require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { REST, Routes, ChannelType } = require('discord.js');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const GUILD_ID  = '1268523142897209405';
const TFT_CH_ID = '1477302664462204928'; // 📝tft-패치노트

async function main() {
  const channels = await rest.get(Routes.guildChannels(GUILD_ID));
  const lolCat = channels.find(c => c.name === '🎮 LOL' && c.type === ChannelType.GuildCategory);

  if (!lolCat) { console.error('❌ LOL 카테고리를 찾을 수 없음'); return; }
  console.log(`LOL 카테고리 ID: ${lolCat.id}`);

  await rest.patch(Routes.channel(TFT_CH_ID), {
    body: { parent_id: lolCat.id, lock_permissions: false },
  });
  console.log('✅ 📝tft-패치노트 → 🎮 LOL 카테고리 이동 완료!');
}

main().catch(console.error);
