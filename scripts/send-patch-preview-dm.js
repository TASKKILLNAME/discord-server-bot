require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { pool } = require('../src/db');
const lolCrawler = require('../src/services/patchCrawler');
const valorantCrawler = require('../src/services/valorantCrawler');
const tftCrawler = require('../src/services/tftCrawler');
const {
  lol,
  valorant,
  tft,
} = require('../src/services/unifiedPatchScheduler');

const PREVIEWS = [
  { label: 'LoL', command: '/패치노트 최신', crawler: lolCrawler, sender: lol },
  {
    label: 'Valorant',
    command: '/발로란트패치노트 최신',
    crawler: valorantCrawler,
    sender: valorant,
  },
  { label: 'TFT', command: '/tft패치노트 최신', crawler: tftCrawler, sender: tft },
];

function requireEnvironment(name) {
  if (!process.env[name]) {
    throw new Error(`${name}이(가) 설정되지 않았습니다.`);
  }
}

async function loadLatestPatch(crawler, label) {
  const latest = await crawler.getLatestPatchUrl();
  if (!latest.url) {
    throw new Error(`${label} 최신 패치 URL을 찾지 못했습니다.`);
  }

  const patchData = await crawler.crawlPatchContent(latest.url);
  if (!patchData) {
    throw new Error(`${label} 최신 패치 본문을 가져오지 못했습니다.`);
  }

  return patchData;
}

async function main() {
  if (!process.argv.includes('--confirm-send')) {
    throw new Error('실제 DM 전송에는 --confirm-send 옵션이 필요합니다.');
  }

  requireEnvironment('DISCORD_TOKEN');
  requireEnvironment('BOT_OWNER_ID');
  requireEnvironment('ANTHROPIC_API_KEY');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await client.login(process.env.DISCORD_TOKEN);

    const owner = await client.users.fetch(process.env.BOT_OWNER_ID);
    const dm = await owner.createDM();

    await dm.send(
      '🧪 **패치노트 실제 게시 형식 미리보기**\n' +
        '아래 내용은 각 `/최신` 명령이 채널에 보내는 것과 같은 embed + 원문 링크입니다.'
    );

    for (const preview of PREVIEWS) {
      const patchData = await loadLatestPatch(preview.crawler, preview.label);
      await dm.send(`**${preview.label} — \`${preview.command}\` 채널 게시 형식**`);
      await preview.sender.sendPatchToChannel(dm, patchData);
    }

    await dm.send('✅ LoL · Valorant · TFT 패치노트 미리보기 전송이 끝났습니다.');
    console.log('BOT_OWNER_ID로 패치노트 DM 미리보기 3종을 전송했습니다.');
  } finally {
    client.destroy();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`패치노트 DM 미리보기 전송 실패: ${error.message}`);
  process.exitCode = 1;
});
