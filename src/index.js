const {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { startUnifiedPatchScheduler } = require('./services/unifiedPatchScheduler');
const { startLckScheduler } = require('./services/chzzkService');
const { startEventScheduler } = require('./services/eventService');
const { startDashboard } = require('../dashboard/server');
const { handleMemberJoin, handleGameSelect } = require('./services/welcomeService');
const { addXp, createLevelUpEmbed } = require('./services/levelService');
const { startLolTracker } = require('./services/lolTrackerService');
const { initDb } = require('./db');

// ============================================
// 클라이언트 설정
// ============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================
// 명령어 로드
// ============================================
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    console.log(`📝 명령어 로드: ${command.data.name}`);
  }
}

// ============================================
// 봇 준비 완료
// ============================================
client.once(Events.ClientReady, async (c) => {
  console.log('\n========================================');
  console.log(`🤖 ${c.user.tag} 봇이 온라인입니다!`);
  console.log(`📊 ${c.guilds.cache.size}개의 서버에서 활동 중`);
  console.log('========================================\n');

  // DB 초기화
  await initDb();

  // 상태 메시지 설정
  client.user.setActivity('/도움말 로 명령어 확인', { type: 3 }); // WATCHING

  // 통합 패치노트 자동 체크 스케줄러 시작 (롤/발로란트/TFT)
  await startUnifiedPatchScheduler(client);

  // 치지직 LCK 경기 시작 알림 스케줄러 시작
  await startLckScheduler(client);

  // 이벤트 알림 스케줄러 시작
  startEventScheduler(client);

  // 웹 대시보드 시작
  startDashboard(client);

  // 롤 게임 자동 감지 트래커 시작
  startLolTracker(client);
});

// ============================================
// 슬래시 명령어 처리
// ============================================
client.on(Events.InteractionCreate, async (interaction) => {
  // 슬래시 명령어 처리
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`명령어를 찾을 수 없음: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`명령어 실행 오류 (${interaction.commandName}):`, error);

      const errorMsg = {
        content: '❌ 명령어 실행 중 오류가 발생했습니다.',
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMsg);
      } else {
        await interaction.reply(errorMsg);
      }
    }
  }

  // 셀렉트 메뉴 처리 (서버 구성 템플릿 선택 + 게임 역할 선택)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'template_select') {
      const setupCommand = client.commands.get('서버구성');
      if (setupCommand?.handleSelect) {
        try {
          await setupCommand.handleSelect(interaction);
        } catch (error) {
          console.error('템플릿 선택 오류:', error);
        }
      }
    }

    // 🎮 게임 역할 선택 처리
    if (interaction.customId === 'game_select') {
      try {
        await handleGameSelect(interaction);
      } catch (error) {
        console.error('게임 선택 오류:', error);
      }
    }
  }

  // 버튼 처리 (서버 구성 확인/취소 + 이벤트 + 멤버십)
  if (interaction.isButton()) {
    // 💳 멤버십 버튼 (서버: 구매 / DM: 승인·거절)
    if (interaction.customId.startsWith('membership_')) {
      const membershipCommand = client.commands.get('멤버십');
      if (membershipCommand?.handleButton) {
        try {
          await membershipCommand.handleButton(interaction);
        } catch (error) {
          console.error('멤버십 버튼 오류:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ 오류가 발생했습니다.', ephemeral: true });
          }
        }
      }
      return;
    }

    // 이벤트 참가/목록 버튼
    if (interaction.customId.startsWith('event_')) {
      const eventCommand = client.commands.get('이벤트');
      if (eventCommand?.handleButton) {
        try {
          await eventCommand.handleButton(interaction);
        } catch (error) {
          console.error('이벤트 버튼 오류:', error);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ 오류가 발생했습니다.', ephemeral: true });
          }
        }
      }
      return;
    }

    if (interaction.customId.startsWith('confirm_setup')) {
      const setupCommand = client.commands.get('서버구성');
      if (setupCommand?.handleConfirm) {
        try {
          await setupCommand.handleConfirm(interaction);
        } catch (error) {
          console.error('서버 구성 오류:', error);
        }
      }
    }

    if (interaction.customId === 'cancel_setup') {
      await interaction.update({
        content: '❌ 서버 구성이 취소되었습니다.',
        embeds: [],
        components: [],
      });
    }
  }
});

// ============================================
// 멤버 입장 이벤트 (환영 메시지 + 게임 선택)
// ============================================
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleMemberJoin(member);
  } catch (error) {
    console.error('환영 메시지 오류:', error);
  }
});

// ============================================
// 메시지 이벤트 (XP 시스템)
// ============================================
client.on(Events.MessageCreate, async (message) => {
  // 봇 메시지 무시
  if (message.author.bot) return;

  // DM 무시
  if (!message.guild) return;

  try {
    const result = await addXp(message.guild.id, message.author.id);

    // 🎉 레벨업 알림
    if (result.leveledUp) {
      const embed = createLevelUpEmbed(message.member, result.newLevel);
      await message.channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('XP 처리 오류:', error);
  }
});

// ============================================
// 에러 핸들링
// ============================================
client.on('error', (error) => {
  console.error('클라이언트 에러:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('처리되지 않은 프로미스 거부:', error);
});

// ============================================
// 로그인
// ============================================
client.login(process.env.DISCORD_TOKEN);