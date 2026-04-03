const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// 투표 데이터 (메모리 기반)
// key: messageId → { votes: Map<userId, candidateIndex>, candidates: string[], timer, channel, closed }
const activeVotes = new Map();

const VOTE_DURATION = 60 * 60 * 1000; // 1시간

/**
 * 투표 메시지 등록 + 1시간 후 자동 마감 타이머
 */
function registerVote(messageId, candidates, channel) {
  const timer = channel
    ? setTimeout(() => closeVote(messageId), VOTE_DURATION)
    : null;

  activeVotes.set(messageId, {
    candidates,
    votes: new Map(),
    channel,
    timer,
    closed: false,
  });
}

/**
 * 투표 마감 처리
 */
async function closeVote(messageId) {
  const voteData = activeVotes.get(messageId);
  if (!voteData || voteData.closed) return;
  voteData.closed = true;

  // 타이머 정리
  if (voteData.timer) {
    clearTimeout(voteData.timer);
    voteData.timer = null;
  }

  // 결과 집계
  const counts = {};
  for (const candidate of voteData.candidates) {
    counts[candidate] = 0;
  }
  for (const index of voteData.votes.values()) {
    counts[voteData.candidates[index]]++;
  }

  // 최다 득표 찾기
  const maxVotes = Math.max(...Object.values(counts));
  const winners = Object.entries(counts)
    .filter(([, count]) => count === maxVotes)
    .map(([name]) => name);

  // 결과 텍스트
  const resultLines = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const bar = '█'.repeat(count) + '░'.repeat(Math.max(0, 5 - count));
      const isWinner = winners.includes(name) && maxVotes > 0;
      return `${isWinner ? '👑' : '　'} **${name}** ${bar} ${count}표`;
    })
    .join('\n');

  const totalVotes = voteData.votes.size;

  let winnerText;
  if (maxVotes === 0) {
    winnerText = '아무도 투표하지 않았습니다!';
  } else if (winners.length > 1) {
    winnerText = `🎲 동점! **${winners.join(', ')}** (${maxVotes}표) — 추첨이 필요합니다!`;
  } else {
    winnerText = `🎉 **${winners[0]}** 당선! (${maxVotes}표)`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🗳️ 투표 결과')
    .setDescription(`${resultLines}\n\n${winnerText}`)
    .setFooter({ text: `총 ${totalVotes}명 참여` })
    .setColor(0xFFD700)
    .setTimestamp();

  // 원본 메시지 버튼 비활성화
  if (voteData.channel) {
    try {
      const message = await voteData.channel.messages.fetch(messageId);
      const disabledRows = message.components.map((row) => {
        const newRow = ActionRowBuilder.from(row);
        newRow.components.forEach((btn) => btn.setDisabled(true));
        return newRow;
      });
      await message.edit({ components: disabledRows });
    } catch {}

    await voteData.channel.send({ embeds: [embed] });
  }

  activeVotes.delete(messageId);
}

/**
 * 버튼 인터랙션 처리
 */
async function handleVoteButton(interaction) {
  const messageId = interaction.message.id;
  let voteData = activeVotes.get(messageId);

  // 봇 재시작 후에도 버튼의 label에서 후보 복원
  if (!voteData) {
    const candidates = [];
    for (const row of interaction.message.components) {
      for (const btn of row.components) {
        if (btn.customId?.startsWith('vote_')) {
          // 비활성화된 버튼이면 이미 마감
          if (btn.disabled) {
            return interaction.reply({
              content: '❌ 이 투표는 이미 마감되었습니다.',
              ephemeral: true,
            });
          }
          candidates.push(btn.label);
        }
      }
    }
    if (candidates.length === 0) {
      return interaction.reply({
        content: '❌ 이 투표는 만료되었습니다.',
        ephemeral: true,
      });
    }
    registerVote(messageId, candidates, interaction.channel);
    voteData = activeVotes.get(messageId);
  }

  if (voteData.closed) {
    return interaction.reply({
      content: '❌ 이 투표는 이미 마감되었습니다.',
      ephemeral: true,
    });
  }

  const index = parseInt(interaction.customId.replace('vote_', ''), 10);
  const candidate = voteData.candidates[index];
  if (!candidate) return;

  const userId = interaction.user.id;
  const previousVote = voteData.votes.get(userId);

  // 같은 후보 다시 클릭 → 투표 취소
  if (previousVote === index) {
    voteData.votes.delete(userId);
    return interaction.reply({
      content: `🗑️ **${candidate}** 투표를 취소했어요.`,
      ephemeral: true,
    });
  }

  // 투표 등록 (변경 포함)
  voteData.votes.set(userId, index);

  const changed = previousVote !== undefined;
  return interaction.reply({
    content: changed
      ? `✅ **${candidate}**(으)로 투표를 변경했어요!`
      : `✅ **${candidate}**에게 투표했어요!`,
    ephemeral: true,
  });
}

/**
 * 투표 결과 조회
 */
function getVoteResults(messageId) {
  const voteData = activeVotes.get(messageId);
  if (!voteData) return null;

  const counts = {};
  for (const candidate of voteData.candidates) {
    counts[candidate] = 0;
  }
  for (const index of voteData.votes.values()) {
    counts[voteData.candidates[index]]++;
  }
  return counts;
}

module.exports = {
  activeVotes,
  registerVote,
  handleVoteButton,
  getVoteResults,
  closeVote,
};
