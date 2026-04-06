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
const { handleVoiceStateUpdate, cleanupTempChannels } = require('./services/tempVoiceService');
const { handleVoteButton } = require('./services/voteService');
const { startTracker } = require('./services/activityTrackerService');

// ============================================
// 클라이언트 설정
// ============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
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

  // 실시간 활동 감시
  startTracker(client);

  // 임시 음성채널 정리 (봇 재시작 시)
  await cleanupTempChannels(client);
});

// ============================================
// 슬래시 명령어 처리
// ============================================
client.on(Events.InteractionCreate, async (interaction) => {
  // ── Context Menu (우클릭) 처리 ──
  if (interaction.isUserContextMenuCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`컨텍스트 메뉴 오류 (${interaction.commandName}):`, error);
      const msg = { content: '❌ 명령어 실행 중 오류가 발생했습니다.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    }
    return;
  }

  // ── Modal Submit 처리 ──
  if (interaction.isModalSubmit()) {
    try {
      // 전적 검색 모달 (우클릭 → 미등록 유저)
      if (interaction.customId.startsWith('lol_search_modal_')) {
        const targetUserId = interaction.customId.replace('lol_search_modal_', '');
        const gameName = interaction.fields.getTextInputValue('summoner_name');
        const tagLine = interaction.fields.getTextInputValue('summoner_tag');

        const targetUser = await interaction.client.users.fetch(targetUserId);
        const contextMenuCmd = client.commands.get('전적 검색');
        if (contextMenuCmd?.searchDirect) {
          await contextMenuCmd.searchDirect(interaction, gameName, tagLine, targetUser);
        }
      }

      // 림버스 진척도 모달
      if (interaction.customId === 'limbus_profile_modal') {
        const chapterRaw = interaction.fields.getTextInputValue('story_chapter');
        const mirrorRaw = interaction.fields.getTextInputValue('mirror_floor');
        const countsRaw = interaction.fields.getTextInputValue('counts');
        const mainRaw = interaction.fields.getTextInputValue('main_info');
        const note = interaction.fields.getTextInputValue('note') || null;

        const storyChapter = parseInt(chapterRaw) || null;
        const mirrorFloor = parseInt(mirrorRaw) || null;

        let identityCount = null, egoCount = null, level = null;
        if (countsRaw) {
          const parts = countsRaw.split('/').map(s => parseInt(s.trim()));
          identityCount = parts[0] || null;
          egoCount = parts[1] || null;
          level = parts[2] || null;
        }

        let mainSinner = null, mainIdentity = null;
        if (mainRaw) {
          const parts = mainRaw.split('/').map(s => s.trim());
          mainSinner = parts[0] || null;
          mainIdentity = parts[1] || null;
        }

        const { upsertProfile } = require('./services/limbusService');
        await upsertProfile(interaction.guild.id, interaction.user.id, {
          storyChapter, mirrorFloor, identityCount, egoCount, level,
          mainSinner, mainIdentity, note, screenshotUrl: null,
        });

        await interaction.reply({
          content: '✅ 림버스 진척도가 저장되었습니다! `/림버스 조회`로 확인해보세요.',
          ephemeral: true,
        });
      }

      // 빠른 이벤트 모달
      if (interaction.customId === 'quick_event_modal') {
        const title = interaction.fields.getTextInputValue('event_title');
        const dateStr = interaction.fields.getTextInputValue('event_date');
        const timeStr = interaction.fields.getTextInputValue('event_time');
        const description = interaction.fields.getTextInputValue('event_desc') || '';

        const datetime = new Date(`${dateStr}T${timeStr}:00+09:00`);
        if (isNaN(datetime.getTime())) {
          return interaction.reply({
            content: '❌ 날짜/시간 형식이 올바르지 않습니다.\n예: 날짜 `2026-04-10` 시간 `20:00`',
            ephemeral: true,
          });
        }
        if (datetime < new Date()) {
          return interaction.reply({
            content: '❌ 과거 시간으로는 이벤트를 생성할 수 없습니다.',
            ephemeral: true,
          });
        }

        await interaction.deferReply();

        const { createEvent, createEventEmbed } = require('./services/eventService');
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

        const event = createEvent({
          guildId: interaction.guild.id,
          channelId: interaction.channel.id,
          messageId: null,
          creatorId: interaction.user.id,
          creatorName: interaction.member.displayName,
          title,
          description,
          datetime: datetime.toISOString(),
          repeat: 'none',
        });

        const embed = createEventEmbed(event);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`event_join_${event.id}`)
            .setLabel('✅ 참가 / 취소')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`event_list_${event.id}`)
            .setLabel('📋 참가자 목록')
            .setStyle(ButtonStyle.Secondary),
        );

        const reply = await interaction.editReply({ embeds: [embed], components: [row] });

        // messageId 업데이트
        const events = require('./services/eventService').loadEvents();
        if (events[event.id]) {
          events[event.id].messageId = reply.id;
          require('fs').writeFileSync(
            require('path').join(__dirname, '../data/events.json'),
            JSON.stringify(events, null, 2)
          );
        }
      }
    } catch (error) {
      console.error('모달 처리 오류:', error);
      const msg = { content: '❌ 처리 중 오류가 발생했습니다.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    }
    return;
  }

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

    // 🗳️ 투표 버튼
    if (interaction.customId.startsWith('vote_')) {
      try {
        await handleVoteButton(interaction);
      } catch (error) {
        console.error('투표 버튼 오류:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ 오류가 발생했습니다.', ephemeral: true });
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
// 음성 채널 이벤트 (임시 방 생성/삭제)
// ============================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('음성 상태 업데이트 오류:', error);
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