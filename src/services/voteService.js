// 투표 데이터 (메모리 기반)
// key: messageId → { votes: Map<userId, candidateIndex>, candidates: string[] }
const activeVotes = new Map();

/**
 * 투표 메시지 등록
 */
function registerVote(messageId, candidates) {
  activeVotes.set(messageId, {
    candidates,
    votes: new Map(),
  });
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
    registerVote(messageId, candidates);
    voteData = activeVotes.get(messageId);
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
};
