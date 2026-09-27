'use strict';

// Characterization tests for known feature regressions. A [KNOWN DEFECT]
// test passes while it reproduces today's unsafe behavior. When production
// code is fixed, change that test to assert the intended behavior instead.
// No test in this file contacts Discord, PostgreSQL, or an external HTTP API.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  PermissionFlagsBits,
  PermissionsBitField,
} = require('discord.js');

const ROOT = path.resolve(__dirname, '..');

function loadCommonJsWithMocks(relativePath, mocks) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const loadedModule = { exports: {} };
  const realRequire = Module.createRequire(filename);
  const mockedRequire = (request) =>
    Object.prototype.hasOwnProperty.call(mocks, request)
      ? mocks[request]
      : realRequire(request);

  const compiledWrapper = new vm.Script(Module.wrap(source), { filename }).runInThisContext();
  compiledWrapper.call(
    loadedModule.exports,
    loadedModule.exports,
    mockedRequire,
    loadedModule,
    filename,
    path.dirname(filename)
  );
  return loadedModule.exports;
}

function createMemoryFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const keyFor = (filePath) => path.basename(String(filePath));

  return {
    files,
    module: {
      existsSync(filePath) {
        return files.has(keyFor(filePath));
      },
      readFileSync(filePath) {
        const key = keyFor(filePath);
        if (!files.has(key)) throw new Error(`Missing in-memory file: ${key}`);
        return files.get(key);
      },
      mkdirSync() {},
      writeFileSync(filePath, contents) {
        files.set(keyFor(filePath), String(contents));
      },
    },
  };
}

function silenceExpectedLogs(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
}

test('[KNOWN DEFECT] 새 이벤트의 5분 전 reminder는 participants 누락으로 TypeError가 난다', async (t) => {
  silenceExpectedLogs(t);

  const memoryFs = createMemoryFs();
  let scheduledCallback = null;
  const eventService = loadCommonJsWithMocks('src/services/eventService.js', {
    fs: memoryFs.module,
    'node-cron': {
      schedule(_expression, callback) {
        scheduledCallback = callback;
        return { stop() {} };
      },
    },
  });

  const event = eventService.createEvent({
    guildId: 'guild-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    creatorId: 'creator-1',
    creatorName: 'creator',
    title: '5분 뒤 이벤트',
    description: '',
    datetime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    repeat: 'none',
  });

  assert.deepEqual(event.attendees, []);
  assert.equal(event.participants, undefined);

  eventService.startEventScheduler({
    users: { fetch: async () => null },
    channels: { fetch: async () => null },
  });
  assert.equal(typeof scheduledCallback, 'function');

  await assert.rejects(
    () => scheduledCallback(),
    (error) => {
      assert.equal(error.name, 'TypeError');
      assert.match(error.message, /participants|iterable/i);
      return true;
    }
  );
});

test('[KNOWN DEFECT] 같은 Chzzk 채널을 구독한 두 guild 중 첫 guild에만 알림을 보낸다', async (t) => {
  silenceExpectedLogs(t);

  const chzzkChannelId = 'shared-chzzk-channel';
  const memoryFs = createMemoryFs({
    'lckChannels.json': JSON.stringify({
      'guild-1': {
        discordChannelId: 'discord-channel-1',
        chzzkChannelId,
        chzzkChannelName: 'LCK',
      },
      'guild-2': {
        discordChannelId: 'discord-channel-2',
        chzzkChannelId,
        chzzkChannelName: 'LCK',
      },
    }),
  });
  let httpCalls = 0;
  const chzzkService = loadCommonJsWithMocks('src/services/chzzkService.js', {
    fs: memoryFs.module,
    axios: {
      async get() {
        httpCalls += 1;
        return {
          data: {
            content: {
              liveId: 'live-1',
              liveTitle: 'T1 vs Gen.G',
              status: 'OPEN',
              concurrentUserCount: 1234,
              channel: { channelId: chzzkChannelId, channelName: 'LCK' },
            },
          },
        };
      },
    },
    'node-cron': { schedule: () => ({ stop() {} }) },
  });

  const fetchedChannels = [];
  const sentChannels = [];
  const client = {
    channels: {
      async fetch(channelId) {
        fetchedChannels.push(channelId);
        return {
          async send() {
            sentChannels.push(channelId);
          },
        };
      },
    },
  };

  await chzzkService.checkLckLive(client);

  assert.equal(httpCalls, 1, '동일 Chzzk 채널 조회는 한 번만 수행한다');
  assert.deepEqual(fetchedChannels, ['discord-channel-1']);
  assert.deepEqual(sentChannels, ['discord-channel-1']);
});

test('/멤버 킥과 밴은 Administrator만 실행할 수 있다', async () => {
  const command = require('../src/commands/member');
  const payload = command.data.toJSON();
  const nonAdministratorPermissions = new PermissionsBitField(
    PermissionFlagsBits.ModerateMembers |
      PermissionFlagsBits.KickMembers |
      PermissionFlagsBits.BanMembers
  );
  const administratorPermissions = new PermissionsBitField(PermissionFlagsBits.Administrator);

  assert.equal(
    payload.default_member_permissions,
    PermissionFlagsBits.ModerateMembers.toString()
  );
  assert.equal(nonAdministratorPermissions.has(PermissionFlagsBits.KickMembers), true);
  assert.equal(nonAdministratorPermissions.has(PermissionFlagsBits.BanMembers), true);
  assert.equal(nonAdministratorPermissions.has(PermissionFlagsBits.Administrator), false);
  assert.ok(payload.options.some((option) => option.name === '킥'));
  assert.ok(payload.options.some((option) => option.name === '밴'));

  const actions = [];
  const target = {
    kickable: true,
    bannable: true,
    user: { tag: 'target-user' },
    async kick(reason) {
      actions.push(['kick', reason]);
    },
    async ban({ reason }) {
      actions.push(['ban', reason]);
    },
  };

  function interactionFor(subcommand, memberPermissions, replies) {
    return {
      memberPermissions,
      options: {
        getSubcommand: () => subcommand,
        getMember: () => target,
        getString: () => null,
      },
      reply: async (payload) => {
        replies.push(payload);
      },
    };
  }

  const nonAdministratorReplies = [];
  await command.execute(interactionFor('킥', nonAdministratorPermissions, nonAdministratorReplies));
  await command.execute(interactionFor('밴', nonAdministratorPermissions, nonAdministratorReplies));

  assert.deepEqual(actions, []);
  assert.equal(nonAdministratorReplies.length, 2);
  assert.ok(nonAdministratorReplies.every((reply) => reply.ephemeral === true));
  assert.match(nonAdministratorReplies[0].content, /관리자만/);
  assert.match(nonAdministratorReplies[1].content, /관리자만/);

  const administratorReplies = [];
  await command.execute(interactionFor('킥', administratorPermissions, administratorReplies));
  await command.execute(interactionFor('밴', administratorPermissions, administratorReplies));

  assert.deepEqual(actions, [
    ['kick', '사유 없음'],
    ['ban', '사유 없음'],
  ]);
  assert.equal(administratorReplies.length, 2);
});

test('[KNOWN DEFECT] 권한 없는 사용자가 다른 멤버의 LoL 등록과 해제를 변경한다', async () => {
  const calls = [];
  const trackerService = {
    async registerPlayer(guildId, userId, gameName, tagLine) {
      calls.push(['register', guildId, userId, gameName, tagLine]);
      return { gameName, tagLine };
    },
    async unregisterPlayer(guildId, userId) {
      calls.push(['unregister', guildId, userId]);
      return true;
    },
    async addTrackerRole(_guild, userId) {
      calls.push(['add-role', userId]);
    },
    async removeTrackerRole(_guild, userId) {
      calls.push(['remove-role', userId]);
    },
    setTrackerChannel: async () => {},
    getRegisteredPlayers: async () => ({}),
    getTrackerChannel: async () => null,
    ensureTrackerRole: async () => null,
    setChannelPermissions: async () => {},
  };
  const command = loadCommonJsWithMocks('src/commands/lol.js', {
    '../services/riotService': {
      fetchLiveGameData: async () => ({}),
      fetchRecentMatchData: async () => ({ matches: [] }),
    },
    '../services/lolAnalyzer': {
      analyzeLiveGame: async () => '',
      analyzeRecentMatches: async () => '',
      parseAnalysisToFields: () => [],
    },
    '../services/lolTrackerService': trackerService,
    '../services/matchLayoutService': {
      buildRecentMatchLayout: () => ({}),
      buildLiveGameLayout: () => ({}),
      buildSingleMatchLayout: () => ({}),
    },
  });

  const actorPermissions = new PermissionsBitField(0n);
  const actor = { id: 'actor-user', tag: 'actor-user' };
  const target = { id: 'target-user', tag: 'target-user' };

  function interactionFor(subcommand) {
    return {
      user: actor,
      memberPermissions: actorPermissions,
      guild: { id: 'guild-1' },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => (name === '소환사명' ? 'Target Account' : 'KR1'),
        getUser: () => target,
      },
      deferReply: async () => {},
      editReply: async () => {},
      reply: async () => {},
    };
  }

  await command.execute(interactionFor('등록'));
  await command.execute(interactionFor('해제'));

  assert.deepEqual(calls, [
    ['register', 'guild-1', 'target-user', 'Target Account', 'KR1'],
    ['add-role', 'target-user'],
    ['unregister', 'guild-1', 'target-user'],
    ['remove-role', 'target-user'],
  ]);
});

test('[KNOWN DEFECT] emoji 확대 handler가 bot messageCreate 흐름에 연결되어 있지 않다', () => {
  const indexSource = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');

  assert.doesNotMatch(indexSource, /require\(['"]\.\/events\/emojiEnlarger['"]\)/);
  assert.doesNotMatch(indexSource, /handleEmojiEnlarge\s*\(/);
});
