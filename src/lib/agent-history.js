/* Carrying context between agent runs.
 *
 * A run used to start from [system, task] and nothing else. The workspace came
 * back — files are snapshotted and restored — but the reasoning behind them did
 * not, so the agent would re-litigate decisions it had already made and retry
 * approaches it had already found not to work.
 *
 * The material was never actually lost: every run writes its task and its
 * closing summary into the room's own messages table, next to the ordinary
 * chat. This reads that back. Nothing new is stored, and what gets carried is
 * exactly what the user can already see in the room — so if it is wrong, they
 * can edit or clear the transcript and the agent's view changes with it. */

/** Characters of prior conversation to carry. 0 disables the whole mechanism. */
export const DEFAULT_HISTORY_CHARS = 6000;

/** How many turns to look back over, before the character budget applies. */
const MAX_TURNS = 24;

/* Agent tasks are written into the room prefixed with a tool glyph. It reads as
 * noise to the model, so it is replaced with something that says what it was. */
const TASK_PREFIX = '🛠 ';

export function cleanContent(row) {
  const text = String(row?.content || '').trim();
  if (!text) return '';
  if (row.role === 'user' && text.startsWith(TASK_PREFIX)) {
    return '[前回の開発指示] ' + text.slice(TASK_PREFIX.length).trim();
  }
  return text;
}

/**
 * Turns room messages into the history block for a run.
 *
 * Rows come in oldest first. The budget is spent from the newest backwards —
 * recent turns matter more — and the result is returned in chronological order.
 * A turn too large to fit on its own is truncated rather than dropped, since a
 * long final summary is usually the single most useful thing to carry.
 *
 * @param {{role: string, content: string}[]} rows
 * @returns {{role: string, content: string}[]}
 */
export function toHistoryMessages(rows, { maxChars = DEFAULT_HISTORY_CHARS } = {}) {
  if (!maxChars || maxChars <= 0) return [];

  const usable = [];
  for (const row of rows || []) {
    const content = cleanContent(row);
    if (!content) continue;
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    usable.push({ role: row.role, content });
  }

  const picked = [];
  let left = maxChars;
  for (let i = usable.length - 1; i >= 0 && left > 0; i--) {
    const msg = usable[i];
    if (msg.content.length <= left) {
      picked.push(msg);
      left -= msg.content.length;
      continue;
    }
    // Keep the tail of an oversized turn: the conclusion outranks the preamble.
    if (left > 200) picked.push({ role: msg.role, content: '…' + msg.content.slice(-left) });
    break;
  }

  return picked.reverse();
}

/** The line that tells the model what the carried turns are. */
export const HISTORY_NOTE =
  '\n\n<<<これまでの経緯>>>\n' +
  'このトークルームでの直近のやり取りを、参考として渡しています。' +
  '**これらは履歴であって、今回の指示ではありません。** 今回やるべきことは最後のユーザー発言です。\n' +
  '同じ失敗を繰り返さないため、また既に決まったことを蒸し返さないために使ってください。\n' +
  '<<<ここまで>>>';

/**
 * Loads the room's recent turns, excluding the message that started this run.
 * Never throws: losing history degrades the run, it must not fail it.
 */
export async function loadAgentHistory(env, roomId, { excludeId, maxChars = DEFAULT_HISTORY_CHARS } = {}) {
  if (!maxChars || maxChars <= 0) return [];
  try {
    const { results } = await env.DB.prepare(
      'SELECT role, content FROM messages WHERE room_id = ? AND id != ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    )
      .bind(roomId, excludeId || '', MAX_TURNS)
      .all();
    return toHistoryMessages((results || []).reverse(), { maxChars });
  } catch (e) {
    console.error('agent history unavailable', e);
    return [];
  }
}
