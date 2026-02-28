const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// 길드별 대기열 관리
const queues = new Map();

/**
 * 대기열 가져오기 (없으면 생성)
 */
function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      songs: [],
      connection: null,
      player: null,
      textChannel: null,
      playing: false,
      disconnectTimer: null,
    });
  }
  return queues.get(guildId);
}

/**
 * 곡 추가
 */
function addSong(guildId, song) {
  const queue = getQueue(guildId);
  queue.songs.push(song);
  return queue.songs.length;
}

/**
 * yt-dlp로 YouTube 검색 (여러 결과 반환)
 */
async function ytdlpSearch(query, limit = 5) {
  const { stdout } = await execFileAsync('yt-dlp', [
    `ytsearch${limit}:${query}`,
    '--dump-json',
    '--no-download',
    '--no-warnings',
    '--flat-playlist',
  ], { timeout: 15000 });

  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * yt-dlp로 단일 영상 정보 가져오기
 */
async function ytdlpGetInfo(url) {
  const { stdout } = await execFileAsync('yt-dlp', [
    url,
    '--dump-json',
    '--no-download',
    '--no-warnings',
  ], { timeout: 15000 });

  return JSON.parse(stdout.trim());
}

/**
 * YouTube 검색 또는 URL에서 곡 정보 추출
 * - URL 직접 입력 지원
 * - MV 영상 우선 검색 (공식 뮤직비디오 우선)
 * - 자유로운 검색어 지원 (곡 제목만, 가사 일부, 별명 등)
 */
async function searchAndGetInfo(query) {
  // URL인지 확인
  const urlPattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//;
  if (urlPattern.test(query)) {
    const info = await ytdlpGetInfo(query);
    return {
      title: info.title,
      url: info.webpage_url || info.url,
      duration: formatDuration(info.duration),
      durationSec: info.duration || 0,
      thumbnail: info.thumbnail || null,
      channel: info.channel || info.uploader || '알 수 없음',
    };
  }

  // MV 키워드가 이미 포함되어 있는지 확인
  const mvKeywords = ['mv', 'music video', '뮤직비디오', 'official'];
  const hasMvKeyword = mvKeywords.some((kw) => query.toLowerCase().includes(kw.toLowerCase()));

  // MV 우선 검색
  const searchQuery = hasMvKeyword ? query : `${query} MV`;
  const results = await ytdlpSearch(searchQuery, 5);

  if (!results || results.length === 0) {
    // MV 검색 실패 시 원본 쿼리로 재시도
    if (!hasMvKeyword) {
      const fallback = await ytdlpSearch(query, 3);
      if (!fallback || fallback.length === 0) return null;
      return pickBestResult(fallback);
    }
    return null;
  }

  return pickBestResult(results);
}

/**
 * 검색 결과에서 MV/공식 영상 우선 선택
 */
function pickBestResult(results) {
  // MV/공식 영상 우선 선택
  const mvResult = results.find((v) => {
    const title = (v.title || '').toLowerCase();
    const channel = (v.channel || v.uploader || '').toLowerCase();
    return (
      title.includes('mv') ||
      title.includes('m/v') ||
      title.includes('music video') ||
      title.includes('official') ||
      title.includes('뮤직비디오') ||
      channel.includes('official') ||
      channel.includes('hybe') ||
      channel.includes('sm entertainment') ||
      channel.includes('jyp') ||
      channel.includes('yg')
    );
  });

  const video = mvResult || results[0];

  // 라이브 영상이나 너무 긴 영상(1시간 이상) 제외
  if (!video.duration || video.duration > 3600) {
    const filtered = results.find((v) => v.duration > 0 && v.duration <= 3600);
    if (filtered) return buildSongInfo(filtered);
    // 전부 라이브/긴 영상이면 첫 번째 결과 사용
    return buildSongInfo(results[0]);
  }

  return buildSongInfo(video);
}

/**
 * 검색 결과에서 곡 정보 객체 생성
 */
function buildSongInfo(video) {
  return {
    title: video.title,
    url: video.webpage_url || video.url || `https://www.youtube.com/watch?v=${video.id}`,
    duration: formatDuration(video.duration),
    durationSec: video.duration || 0,
    thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || null,
    channel: video.channel || video.uploader || '알 수 없음',
  };
}

/**
 * 현재 곡 재생
 */
async function playCurrentSong(guildId) {
  const queue = getQueue(guildId);

  if (queue.songs.length === 0) {
    queue.playing = false;
    // 3분 후 자동 퇴장 타이머
    startDisconnectTimer(guildId);
    return;
  }

  // 자동 퇴장 타이머 취소
  clearDisconnectTimer(guildId);

  const song = queue.songs[0];
  queue.playing = true;

  try {
    // yt-dlp로 오디오 스트림 생성
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '-o', '-',
      '--no-warnings',
      '--quiet',
      song.url,
    ]);

    const resource = createAudioResource(ytdlp.stdout, {
      inputType: StreamType.Arbitrary,
    });

    ytdlp.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString());
    });

    queue.player.play(resource);
  } catch (err) {
    console.error('음악 재생 오류:', err);

    // 실패한 곡 제거 후 다음 곡 시도
    queue.songs.shift();
    if (queue.textChannel) {
      queue.textChannel.send(`❌ **${song.title}** 재생에 실패했습니다. 다음 곡으로 넘어갑니다.`).catch(() => {});
    }
    return playCurrentSong(guildId);
  }
}

/**
 * 음성 채널 연결 + 플레이어 세팅
 */
async function connectAndSetup(guildId, voiceChannel, textChannel, adapterCreator) {
  const queue = getQueue(guildId);

  // 이미 연결되어 있으면 재사용
  if (queue.connection && queue.player) {
    queue.textChannel = textChannel;
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    console.error('음성채널 연결 실패 상세:', err.message, '| 상태:', connection.state?.status);
    connection.destroy();
    throw new Error('음성채널 연결에 실패했습니다. 잠시 후 다시 시도해주세요.');
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  // Idle 이벤트 → 다음 곡 자동 재생
  player.on(AudioPlayerStatus.Idle, () => {
    queue.songs.shift(); // 끝난 곡 제거
    if (queue.songs.length > 0) {
      playCurrentSong(guildId);
      // 다음 곡 알림
      const nextSong = queue.songs[0];
      if (queue.textChannel) {
        queue.textChannel.send(`🎵 **지금 재생:** ${nextSong.title} [${nextSong.duration}]`).catch(() => {});
      }
    } else {
      queue.playing = false;
      if (queue.textChannel) {
        queue.textChannel.send('📭 대기열의 모든 곡을 재생했습니다. 3분 후 자동으로 퇴장합니다.').catch(() => {});
      }
      startDisconnectTimer(guildId);
    }
  });

  player.on('error', (err) => {
    console.error('오디오 플레이어 오류:', err.message);
  });

  // 연결 끊김 감지
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // 재연결 시도 중
    } catch {
      // 완전히 끊김 → 정리
      cleanup(guildId);
    }
  });

  connection.subscribe(player);

  queue.connection = connection;
  queue.player = player;
  queue.textChannel = textChannel;
}

/**
 * 스킵 (현재 곡 건너뛰기)
 */
function skip(guildId) {
  const queue = getQueue(guildId);
  if (!queue.player) return false;
  // player.stop() → Idle 이벤트 트리거 → 다음 곡 자동 재생
  queue.player.stop();
  return true;
}

/**
 * 정지 (대기열 비우기 + 연결 종료)
 */
function stop(guildId) {
  const queue = getQueue(guildId);
  queue.songs = [];
  queue.playing = false;
  clearDisconnectTimer(guildId);

  if (queue.player) {
    queue.player.stop();
  }
  if (queue.connection) {
    queue.connection.destroy();
  }

  queues.delete(guildId);
  return true;
}

/**
 * 일시정지
 */
function pause(guildId) {
  const queue = getQueue(guildId);
  if (!queue.player) return false;
  queue.player.pause();
  return true;
}

/**
 * 다시재생
 */
function resume(guildId) {
  const queue = getQueue(guildId);
  if (!queue.player) return false;
  queue.player.unpause();
  return true;
}

/**
 * 대기열 정보 가져오기
 */
function getQueueInfo(guildId) {
  const queue = getQueue(guildId);
  return {
    songs: [...queue.songs],
    playing: queue.playing,
  };
}

/**
 * 3분 후 자동 퇴장 타이머
 */
function startDisconnectTimer(guildId) {
  const queue = getQueue(guildId);
  clearDisconnectTimer(guildId);

  queue.disconnectTimer = setTimeout(() => {
    const q = queues.get(guildId);
    if (q && !q.playing && q.songs.length === 0) {
      if (q.textChannel) {
        q.textChannel.send('👋 3분간 재생이 없어 음성채널에서 퇴장합니다.').catch(() => {});
      }
      stop(guildId);
    }
  }, 3 * 60 * 1000);
}

/**
 * 타이머 취소
 */
function clearDisconnectTimer(guildId) {
  const queue = queues.get(guildId);
  if (queue?.disconnectTimer) {
    clearTimeout(queue.disconnectTimer);
    queue.disconnectTimer = null;
  }
}

/**
 * 정리 (연결 끊김 시)
 */
function cleanup(guildId) {
  const queue = queues.get(guildId);
  if (queue) {
    queue.songs = [];
    queue.playing = false;
    clearDisconnectTimer(guildId);
    if (queue.player) queue.player.stop();
    if (queue.connection) {
      try { queue.connection.destroy(); } catch {}
    }
    queues.delete(guildId);
  }
}

/**
 * 초를 MM:SS 또는 HH:MM:SS 형식으로 변환
 */
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return 'LIVE';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
  getQueue,
  addSong,
  searchAndGetInfo,
  playCurrentSong,
  connectAndSetup,
  skip,
  stop,
  pause,
  resume,
  getQueueInfo,
};
