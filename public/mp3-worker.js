/* MP3 encoding off the main thread.
 *
 * Encoding a long recording inline would stall the audio graph and drop
 * samples, so the capture side ships Float32 chunks here and receives finished
 * MP3 frames back. */

importScripts('/vendor/lame.min.js');

let encoder = null;
let parts = [];
let bytes = 0;

/** Float32 (-1..1) to the Int16 lamejs expects. */
function toInt16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = Math.max(-1, Math.min(1, input[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

self.onmessage = (event) => {
  const msg = event.data || {};

  if (msg.type === 'start') {
    // Mono keeps the file half the size, which matters more here than stereo.
    encoder = new lamejs.Mp3Encoder(1, msg.sampleRate, msg.bitrate || 64);
    parts = [];
    bytes = 0;
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'chunk' && encoder) {
    const frame = encoder.encodeBuffer(toInt16(msg.samples));
    if (frame.length) {
      parts.push(frame);
      bytes += frame.length;
      self.postMessage({ type: 'progress', bytes });
    }
    return;
  }

  if (msg.type === 'stop') {
    if (!encoder) {
      self.postMessage({ type: 'done', blob: new Blob([], { type: 'audio/mpeg' }), bytes: 0 });
      return;
    }
    const tail = encoder.flush();
    if (tail.length) {
      parts.push(tail);
      bytes += tail.length;
    }
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    encoder = null;
    parts = [];
    self.postMessage({ type: 'done', blob, bytes });
  }
};
