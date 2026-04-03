const axios = require('axios');
const cheerio = require('cheerio');
const { pool } = require('../db');

const GAME_KEY = 'tarkov';
const LIST_URL = 'https://changes.tarkov-changes.com/list';
const BASE_URL = 'https://changes.tarkov-changes.com';

async function loadLastPatch() {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM patch_state WHERE game = $1',
      [GAME_KEY]
    );
    if (rows[0]) {
      return { lastUrl: rows[0].last_url, lastTitle: rows[0].last_title };
    }
  } catch (err) {
    console.error('타르코프 패치 데이터 로드 실패:', err.message);
  }
  return { lastUrl: null, lastTitle: null };
}

async function saveLastPatch(data) {
  try {
    await pool.query(
      `INSERT INTO patch_state (game, last_url, last_title, checked_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (game) DO UPDATE
       SET last_url = $2, last_title = $3, checked_at = NOW()`,
      [GAME_KEY, data.lastUrl, data.lastTitle]
    );
  } catch (err) {
    console.error('타르코프 패치 데이터 저장 실패:', err.message);
  }
}

async function getLatestPatchUrl() {
  try {
    const { data: html } = await axios.get(LIST_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(html);

    let latestUrl = null;
    let latestTitle = null;

    // /view/숫자 형태의 링크 중 가장 첫 번째 (최신)
    $('a[href^="/view/"]').each((i, el) => {
      if (!latestUrl) {
        const href = $(el).attr('href');
        latestUrl = `${BASE_URL}${href}`;
        latestTitle = $(el).text().trim() || `Tarkov Update ${href.replace('/view/', '')}`;
      }
    });

    return { url: latestUrl, title: latestTitle };
  } catch (err) {
    console.error('타르코프 패치노트 목록 가져오기 실패:', err.message);
    return { url: null, title: null };
  }
}

async function crawlPatchContent(url) {
  try {
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 20000,
    });

    const $ = cheerio.load(html);

    // 제목: h1 또는 h2에서 버전/날짜 정보
    let title = '';
    $('h1, h2').each((i, el) => {
      const text = $(el).text().trim();
      if (!title && (text.includes('Game Version') || text.includes('Changes from') || text.includes('Dated'))) {
        title = text;
      }
    });
    if (!title) title = $('title').text().trim() || '타르코프 패치노트';

    // 본문: 변경사항 내용
    let content = '';

    // script, style, nav 제거
    $('script, style, nav, footer, header').remove();

    // 주요 콘텐츠 영역
    const selectors = [
      '.container',
      'main',
      'article',
      '.content',
    ];

    for (const selector of selectors) {
      const el = $(selector);
      if (el.length > 0) {
        content = el.text().trim();
        if (content.length > 500) break;
      }
    }

    if (content.length < 500) {
      content = $('body').text().trim();
    }

    if (content.length > 15000) {
      content = content.substring(0, 15000) + '\n\n... (이하 생략)';
    }

    return { title, content, url };
  } catch (err) {
    console.error('타르코프 패치노트 크롤링 실패:', err.message);
    return null;
  }
}

async function checkForNewPatch() {
  const lastPatch = await loadLastPatch();
  const latest = await getLatestPatchUrl();

  if (!latest.url) {
    console.log('⚠️ 타르코프 최신 패치노트 URL을 가져올 수 없습니다.');
    return null;
  }

  if (latest.url === lastPatch.lastUrl) {
    console.log(
      `📋 타르코프 새 패치 없음 (현재: ${lastPatch.lastTitle || latest.url})`
    );
    return null;
  }

  console.log(`🆕 타르코프 새 패치노트 발견! ${latest.title || latest.url}`);

  const patchData = await crawlPatchContent(latest.url);

  if (patchData) {
    await saveLastPatch({
      lastUrl: latest.url,
      lastTitle: latest.title || patchData.title,
    });
  }

  return patchData;
}

async function forceGetLatestPatch() {
  const latest = await getLatestPatchUrl();

  if (!latest.url) {
    return null;
  }

  const patchData = await crawlPatchContent(latest.url);

  if (patchData) {
    await saveLastPatch({
      lastUrl: latest.url,
      lastTitle: latest.title || patchData.title,
    });
  }

  return patchData;
}

module.exports = {
  checkForNewPatch,
  forceGetLatestPatch,
  getLatestPatchUrl,
  crawlPatchContent,
  loadLastPatch,
  saveLastPatch,
};
