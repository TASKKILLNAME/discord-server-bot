const { pool } = require('../db');

function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

// Compare only supplied fields: Discord adds its own embed metadata.
function contains(actual, expected) {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (!actual) return false;
  return Object.keys(expected).every(key => key === 'timestamp' || contains(actual[key], expected[key]));
}

async function history(channel, predicate) {
  let before;
  for (let page = 0; page < 20; page++) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of messages.values()) {
      if (message.author.id === channel.client.user.id && predicate(message)) return true;
    }
    if (messages.size < 100) return false;
    before = messages.last().id;
  }
  throw new Error('패치 게시 이력 확인 한도 초과: 중복 방지를 위해 전송 보류');
}

async function deliverPatch(game, channel, patchUrl, buildPayloads) {
  const url = canonicalUrl(patchUrl);
  const db = await pool.connect();
  const key = `patch:${game}:${channel.id}`;
  try {
    const lock = await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key]);
    if (!lock.rows[0].locked) return false;
    try {
      let { rows } = await db.query(
        'SELECT * FROM patch_deliveries WHERE game=$1 AND channel_id=$2 AND patch_url=$3',
        [game, channel.id, url]
      );
      let receipt = rows[0];
      if (receipt?.sent_at) return true;
      if (!receipt) {
        // Legacy patch_state includes silent startup syncs, so it is NOT evidence of delivery.
        const alreadySent = await history(channel, message => {
          if (!message.content.startsWith('📎 **원문 보기:**')) return false;
          try { return canonicalUrl(message.content.split('**원문 보기:**')[1].trim()) === url; }
          catch { return false; }
        });
        const payloads = alreadySent ? [] : await buildPayloads();
        const inserted = await db.query(
          `INSERT INTO patch_deliveries (game,channel_id,patch_url,payloads,sent_at)
           VALUES ($1,$2,$3,$4::jsonb,CASE WHEN $5 THEN NOW() ELSE NULL END) RETURNING *`,
          [game, channel.id, url, JSON.stringify(payloads), alreadySent]
        );
        receipt = inserted.rows[0];
        if (alreadySent) return true;
      }
      for (let i = receipt.next_index; i < receipt.payloads.length; i++) {
        const payload = receipt.payloads[i];
        // Reconcile a Discord success followed by a failed DB write/process exit.
        const found = await history(channel, message =>
          message.createdTimestamp >= new Date(receipt.created_at).getTime() - 1000 &&
          (message.content || '') === (payload.content || '') &&
          (!payload.embeds || message.embeds.length === payload.embeds.length) &&
          (payload.embeds || []).every((embed, index) => contains(message.embeds[index].toJSON(), embed))
        );
        if (!found) await channel.send(payload);
        await db.query(
          'UPDATE patch_deliveries SET next_index=$4 WHERE game=$1 AND channel_id=$2 AND patch_url=$3',
          [game, channel.id, url, i + 1]
        );
      }
      await db.query(
        'UPDATE patch_deliveries SET sent_at=NOW() WHERE game=$1 AND channel_id=$2 AND patch_url=$3',
        [game, channel.id, url]
      );
      return true;
    } finally {
      await db.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    }
  } finally {
    db.release();
  }
}

module.exports = { canonicalUrl, deliverPatch };
