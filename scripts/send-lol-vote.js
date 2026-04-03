/**
 * send-lol-vote.js
 * LOL 역할 멤버(관리자 제외) 조회 후 방장 투표 임베드 전송
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const GUILD_ID       = '1268523142897209405';
const LOL_ROLE_ID    = '1462734611527499838';
const ADMIN_ROLE_ID  = '1268536779573559317';
const OWNER_ID       = '1268496335494058031'; // 프리뷰 DM 받을 유저

// 키캡 이모지 올바른 유니코드 이스케이프
const NUMBER_EMOJIS = [
  '\u0031\uFE0F\u20E3', // 1️⃣
  '\u0032\uFE0F\u20E3', // 2️⃣
  '\u0033\uFE0F\u20E3', // 3️⃣
  '\u0034\uFE0F\u20E3', // 4️⃣
  '\u0035\uFE0F\u20E3', // 5️⃣
  '\u0036\uFE0F\u20E3', // 6️⃣
  '\u0037\uFE0F\u20E3', // 7️⃣
  '\u0038\uFE0F\u20E3', // 8️⃣
  '\u0039\uFE0F\u20E3', // 9️⃣
  '\uD83D\uDD1F',        // 🔟
];
// 임베드 표시용 레이블 (가독성)
const NUMBER_LABELS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

// node send-lol-vote.js --preview  → DM으로 프리뷰
// node send-lol-vote.js            → lol-채팅에 실제 전송
const IS_PREVIEW = process.argv.includes('--preview');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', async () => {
  console.log(`✅ 봇 로그인: ${client.user.tag}\n`);

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.members.fetch(); // 전체 멤버 캐시

  // LOL 역할 보유 멤버 중 관리자 역할 제외
  const candidates = guild.members.cache
    .filter(m =>
      m.roles.cache.has(LOL_ROLE_ID) &&
      !m.roles.cache.has(ADMIN_ROLE_ID) &&
      !m.user.bot
    )
    .map(m => ({
      id: m.id,
      name: m.displayName,
    }));

  if (candidates.length === 0) {
    console.log('❌ 후보자가 없습니다.');
    client.destroy();
    return;
  }

  console.log(`👥 후보자 ${candidates.length}명:`);
  candidates.forEach((c, i) => console.log(`  ${NUMBER_LABELS[i]} ${c.name}`));

  // 임베드 설명 (후보자 목록)
  const description = candidates
    .map((c, i) => `${NUMBER_LABELS[i]} **${c.name}**`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🏆 방장 투표')
    .setDescription(
      `아래 후보 중 **LOL 방장**으로 활동할 멤버에게 투표해주세요!\n\n${description}`
    )
    .setColor(0x00E5FF)
    .setFooter({ text: '버튼 또는 리액션으로 투표 가능합니다' })
    .setTimestamp();

  // 버튼 생성 (최대 5개 per row)
  const rows = [];
  for (let i = 0; i < candidates.length; i += 5) {
    const row = new ActionRowBuilder();
    const slice = candidates.slice(i, i + 5);
    slice.forEach((c, j) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_lol_${c.id}`)
          .setLabel(`${NUMBER_LABELS[i + j]} ${c.name}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }

  let targetChannel;

  if (IS_PREVIEW) {
    // DM으로 프리뷰
    const owner = await client.users.fetch(OWNER_ID);
    targetChannel = await owner.createDM();
    console.log('\n📩 프리뷰 모드: DM으로 전송 중...');
  } else {
    // lol-채팅 채널 찾기
    await guild.channels.fetch();
    targetChannel = guild.channels.cache.find(
      c => c.name.toLowerCase().includes('lol') && c.name.includes('채팅')
    );
    if (!targetChannel) {
      console.error('❌ lol-채팅 채널을 찾을 수 없습니다.');
      client.destroy();
      return;
    }
    console.log(`\n📢 채널: #${targetChannel.name} (${targetChannel.id})`);
  }

  // 메시지 전송
  const msg = await targetChannel.send({
    embeds: [embed],
    components: rows,
  });

  console.log(`✅ 임베드 전송 완료 (message id: ${msg.id})`);

  // 번호 리액션 추가
  for (let i = 0; i < candidates.length; i++) {
    await msg.react(NUMBER_EMOJIS[i]);
    await new Promise(r => setTimeout(r, 600));
  }

  console.log('✅ 리액션 추가 완료');
  if (IS_PREVIEW) console.log('\n⚠️  프리뷰입니다. 실제 전송하려면 --preview 없이 실행하세요.');
  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
