const https = require('https');
const fs = require('fs');
const path = require('path');

const TTS_DIR = path.join(__dirname, '../../data/tts');

// TTS 디렉토리 생성
if (!fs.existsSync(TTS_DIR)) {
  fs.mkdirSync(TTS_DIR, { recursive: true });
}

/**
 * Google TTS로 텍스트를 음성 파일로 변환
 * 무료, 한국어/영어/일본어 지원
 */
async function textToSpeech(text, lang = 'ko') {
  // 텍스트 길이 제한 (Google TTS는 약 200자)
  const maxLen = 200;
  if (text.length > maxLen) {
    text = text.substring(0, maxLen);
  }

  const encodedText = encodeURIComponent(text);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=${lang}&client=tw-ob`;

  const filePath = path.join(TTS_DIR, `tts_${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);

    https
      .get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Referer': 'https://translate.google.com/',
        },
      }, (response) => {
        // 리다이렉트 처리
        if (response.statusCode === 302 || response.statusCode === 301) {
          https.get(response.headers.location, {
            headers: {
              'User-Agent': 'Mozilla/5.0',
            },
          }, (redirectRes) => {
            redirectRes.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve(filePath);
            });
          }).on('error', reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(filePath);
          reject(new Error(`TTS 요청 실패: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          // 파일 크기 확인
          const stats = fs.statSync(filePath);
          if (stats.size < 100) {
            fs.unlinkSync(filePath);
            reject(new Error('TTS 파일이 비어있습니다.'));
            return;
          }
          resolve(filePath);
        });
      })
      .on('error', (err) => {
        file.close();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        reject(err);
      });
  });
}

/**
 * 긴 텍스트를 여러 청크로 분할
 */
function splitText(text, maxLen = 200) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // 문장 단위로 끊기 시도
    let splitIndex = remaining.lastIndexOf('.', maxLen);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(' ', maxLen);
    if (splitIndex === -1) splitIndex = maxLen;

    chunks.push(remaining.substring(0, splitIndex + 1).trim());
    remaining = remaining.substring(splitIndex + 1).trim();
  }

  return chunks;
}

/**
 * 오래된 TTS 파일 정리 (5분 이상)
 */
function cleanupTTSFiles() {
  try {
    const files = fs.readdirSync(TTS_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(TTS_DIR, file);
      const stats = fs.statSync(filePath);

      if (now - stats.mtimeMs > 5 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    // 무시
  }
}

module.exports = {
  textToSpeech,
  splitText,
  cleanupTTSFiles,
};