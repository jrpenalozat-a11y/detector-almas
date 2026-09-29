// Voz realista del espíritu: genera la voz fuera de la página para no trabarla.
// - Piper (voces neuronales de rhasspy/piper-voices) con su fonetizador eSpeak.
// - MMS/VITS afinado con voces chilenas (ylacombe/mms-spa-finetuned-chilean-monospeaker).
// Los modelos los descarga la página y quedan en Cache Storage «almas-voz»; aquí solo se leen.
const ORT_BASE = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/";
const PIPER_HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const PIPER_PH = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const MMS_BASE = "https://huggingface.co/ylacombe/mms-spa-finetuned-chilean-monospeaker/resolve/main/";

importScripts(ORT_BASE + "ort.min.js");
ort.env.wasm.wasmPaths = ORT_BASE;
ort.env.wasm.numThreads = 1;

async function cached(url) {
  const cache = await caches.open("almas-voz");
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  const buf = await r.arrayBuffer();
  await cache.put(url, new Response(buf.slice(0)));
  return buf;
}

let ph = null;
function phonemizer() {
  if (!ph) ph = (async () => {
    importScripts(PIPER_PH + ".js");
    const [w, d] = await Promise.all([cached(PIPER_PH + ".wasm"), cached(PIPER_PH + ".data")]);
    return { wasm: URL.createObjectURL(new Blob([w], { type: "application/wasm" })), data: URL.createObjectURL(new Blob([d])) };
  })().catch(e => { ph = null; throw e; });
  return ph;
}

const sessions = {};
function piperSession(path) {
  if (!sessions[path]) sessions[path] = (async () => {
    const cfg = JSON.parse(new TextDecoder().decode(await cached(PIPER_HF + path + ".json")));
    return { cfg, sess: await ort.InferenceSession.create(await cached(PIPER_HF + path)) };
  })().catch(e => { delete sessions[path]; throw e; });
  return sessions[path];
}
async function piperGen(path, sid, text) {
  const [S, files] = await Promise.all([piperSession(path), phonemizer()]);
  const ids = await new Promise(async (res, rej) => {
    try {
      const m = await createPiperPhonemize({
        print: l => { try { res(JSON.parse(l).phoneme_ids); } catch (e) {} },
        printErr: l => rej(new Error(l)),
        locateFile: f => f.endsWith(".wasm") ? files.wasm : f.endsWith(".data") ? files.data : f,
      });
      m.callMain(["-l", S.cfg.espeak.voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
    } catch (e) { rej(e); }
  });
  const i = S.cfg.inference;
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    // un poco más lento y con más variación que lo normal: suena cansado, no de locutor
    scales: new ort.Tensor("float32", Float32Array.from([i.noise_scale * 1.1, i.length_scale * 1.12, i.noise_w * 1.2]), [3]),
  };
  if (S.cfg.num_speakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(sid || 0)]), [1]);
  const out = await S.sess.run(feeds);
  return { pcm: new Float32Array(out.output.data), sr: S.cfg.audio.sample_rate };
}

let mms = null;
function mmsSession() {
  if (!mms) mms = (async () => {
    const vocab = JSON.parse(new TextDecoder().decode(await cached(MMS_BASE + "vocab.json")));
    return { vocab, sess: await ort.InferenceSession.create(await cached(MMS_BASE + "onnx/model.onnx")) };
  })().catch(e => { mms = null; throw e; });
  return mms;
}
async function mmsGen(text) {
  const { vocab, sess } = await mmsSession();
  // letras del vocabulario con un blanco (0) entre cada una, como el tokenizador original
  const ids = [0];
  for (const ch of text.toLowerCase().normalize("NFC")) if (ch in vocab) ids.push(vocab[ch], 0);
  const n = ids.length;
  const out = await sess.run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
    attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
  }, ["waveform"]);
  return { pcm: new Float32Array(out.waveform.data), sr: 16000 };
}

// trabajos de a uno (la voz chilena es pesada), el de más prioridad primero:
// la respuesta de la tabla antes que la llamada, y la llamada antes que lo que dice solo
const pending = [];
let working = false;
async function pump() {
  if (working || !pending.length) return;
  working = true;
  const m = pending.shift();
  try {
    if (m.kind === "warm") {
      if (m.mms) await mmsSession();
      for (const p of m.paths || []) await piperSession(p);
      if ((m.paths || []).length) await phonemizer();
      self.postMessage({ id: m.id, ok: true });
    } else {
      const r = m.kind === "mms" ? await mmsGen(m.text) : await piperGen(m.path, m.sid, m.text);
      self.postMessage({ id: m.id, pcm: r.pcm, sr: r.sr }, [r.pcm.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
  working = false;
  pump();
}
self.onmessage = e => {
  const m = e.data;
  if (m.kind === "bump") { // una frase que ya estaba en cola ahora urge
    const j = pending.find(x => x.id === m.target);
    if (j && (j.prio || 0) < m.prio) j.prio = m.prio;
  } else pending.push(m);
  pending.sort((a, b) => (b.prio || 0) - (a.prio || 0)); // estable: a igual prioridad, por orden de llegada
  pump();
};
