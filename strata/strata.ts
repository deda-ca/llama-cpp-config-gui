// Minimal OpenAI-compatible chat server for the Strata engine — no Python.
//
//   spawn `strata --serve`  ->  drive the GEN/T/DONE line protocol on stdin/stdout
//   tokenize with @huggingface/tokenizers (BPE model + ByteLevel decoder),
//     fed the pack's GGUF vocab (vocab.json + merges.txt) and split with the
//     pack's qwen35 pre-tokenizer regex
//   Express: POST /v1/chat/completions (stream + non-stream), GET /v1/models, GET /health
//
// Run:  npx tsx strata/strata.ts
// Test: curl -s localhost:8790/v1/chat/completions -H 'content-type: application/json' \
//         -d '{"model":"strata","messages":[{"role":"user","content":"hi"}]}'

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import express from 'express';

// ---------------------------------------------------------------- config ----

const ENGINE = process.env.STRATA_ENGINE ?? '/home/ueiricho/Programs/AI/strata-engine-cuda-13/strata';
const PACK = '/home/ueiricho/Programs/AI/Strata-data/packs/iq3_s';
const MODEL =
  '/home/ueiricho/Programs/AI/Strata-data/models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf';
const PLE =
  '/home/ueiricho/Programs/AI/Strata-data/models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf';
const PROFILE = '/home/ueiricho/Programs/AI/Strata/data/expert-profile.bin';
const MTP = '/home/ueiricho/Programs/AI/Strata-data/mtp/rt';
const TOKENIZER = `${PACK}/tokenizer`;
const MODEL_NAME = 'Qwen3.8-Flash-Next';
const PORT = 5456;
const MAX_CONTEXT = 262144; // smaller than the real config: faster load for an experiment

// Engine args mirror strata-iq3_s.json minus vision. No --gpu: the cards are
// selected with CUDA_VISIBLE_DEVICES instead, so --layer-split auto sees 0,1,2.
// STRATA_ENGINE_ARGS overrides them (space-separated) — used to point at a mock.
const ENGINE_ARGS = process.env.STRATA_ENGINE_ARGS
  ? process.env.STRATA_ENGINE_ARGS.split(/\s+/).filter(Boolean)
  : [
      '--serve',
      '--pack', PACK,
      '--native', MODEL,
      '--ple-gguf', PLE,
      '--expert-profile', PROFILE,
      '--mtp', MTP,
      '--expert-cache', 'auto',
      '--prefill', 'auto',
      '--spec', '4',
      '--spec-min-p', '0.5',
      '--max-context', String(MAX_CONTEXT),
      '--kv', 'int8',
      '--kv-resident', String(MAX_CONTEXT),
      '--remote-expert-opt',
      '--ple-io', 'ram',
      '--pipeline-windows', '2',
      '--pool-workers', '16',
      '--layer-split', 'auto',
    ];

const IM_END = 248046; //   <|im_end|>
const ENDOFTEXT = 248044;
const EOS_IDS = new Set([IM_END, ENDOFTEXT]);

// Control literals emitted as single ids by the chat template.
const SPECIALS = ['<|im_start|>', '<|im_end|>', '<|endoftext|>'];

// Engine may take a long time to load weights (the Python server allows 900 s).
const READY_TIMEOUT_MS = 900_000;

// ------------------------------------------------------------- tokenizer ----

// GPT-2 byte<->unicode map (same as Strata's tools/strata_tokenizer.py).
function bytesToUnicode(): Record<number, string> {
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
  const bs = [...range(0x21, 0x7f), ...range(0xa1, 0xad), ...range(0xae, 0x100)];
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const m: Record<number, string> = {};
  bs.forEach((b, i) => (m[b] = String.fromCodePoint(cs[i])));
  return m;
}
const B2U = bytesToUnicode();

/** The BPE surface of the HF model we drive directly (not in the package's public types). */
interface BpeModel {
  bpe(token: string): string[];
  tokens_to_ids: Map<string, number>;
}

/**
 * The pack's tokenizer. The pack ships a GGUF-style vocab (vocab.json +
 * merges.txt + a 541-byte tokenizer.json holding only metadata), NOT an HF
 * tokenizers.json — so the HF package is fed a constructed config: its BPE
 * model + ByteLevel decoder, with the qwen35 pre-tokenizer split done here in
 * native JS (the package's own Split mangles the oniguruma pattern).
 *
 * Verified id-for-id against Strata's reference tools/strata_tokenizer.py.
 */
class StrataTokenizer {
  private hf: Tokenizer;
  private bpe: BpeModel;
  private qwen35: RegExp;
  private specialRe: RegExp;
  private specialIds: Record<string, number>;
  private idToSpecial: Map<number, string>;

  constructor(dir: string) {
    const vocab = JSON.parse(readFileSync(`${dir}/vocab.json`, 'utf8')) as Record<string, number>;
    const merges = readFileSync(`${dir}/merges.txt`, 'utf8').split('\n').filter(Boolean);
    const meta = JSON.parse(readFileSync(`${dir}/tokenizer.json`, 'utf8')) as {
      pre_pattern: string;
    };

    const hf = {
      version: '1.0',
      truncation: null,
      padding: null,
      normalizer: null,
      pre_tokenizer: null,
      added_tokens: [],
      model: { type: 'BPE', vocab, merges, unk_token: '<unk>', byte_fallback: true },
      post_processor: null,
      decoder: { type: 'ByteLevel', add_prefix_space: false, trim_offsets: false, use_regex: false },
      add_bos_token: false,
      add_eos_token: false,
    };
    this.hf = new Tokenizer(hf as never, {} as never);
    this.bpe = this.hf.model as unknown as BpeModel;
    this.qwen35 = new RegExp(meta.pre_pattern, 'gu');

    this.specialIds = {};
    this.idToSpecial = new Map();
    for (const s of SPECIALS) {
      const id = vocab[s];
      if (id === undefined) throw new Error(`special token ${s} not in vocab`);
      this.specialIds[s] = id;
      this.idToSpecial.set(id, s);
    }
    // Longest-first alternation so <|im_start|> wins over a shorter prefix.
    this.specialRe = new RegExp(
      SPECIALS.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|'),
      'g',
    );
  }

  /** BPE one plain (no-special) run: qwen35 split -> byte-map -> package BPE. */
  private encodePlain(text: string, out: number[]): void {
    for (const piece of text.match(this.qwen35) ?? []) {
      const mapped = [...new TextEncoder().encode(piece)].map((b) => B2U[b]).join('');
      for (const sub of this.bpe.bpe(mapped)) {
        const id = this.bpe.tokens_to_ids.get(sub);
        if (id === undefined) throw new Error(`BPE produced an out-of-vocab token: ${sub}`);
        out.push(id);
      }
    }
  }

  /** Tokenize, emitting the control literals as single ids. */
  encode(text: string): number[] {
    const out: number[] = [];
    let pos = 0;
    this.specialRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = this.specialRe.exec(text))) {
      if (m.index > pos) this.encodePlain(text.slice(pos, m.index), out);
      out.push(this.specialIds[m[0]]);
      pos = m.index + m[0].length;
    }
    if (pos < text.length) this.encodePlain(text.slice(pos), out);
    return out;
  }

  /** Detokenize ids; special ids become their literal text. */
  decode(ids: number[]): string {
    let out = '';
    let run: number[] = [];
    const flush = () => {
      if (run.length) {
        out += this.hf.decode(run, { skip_special_tokens: false });
        run = [];
      }
    };
    for (const id of ids) {
      const sp = this.idToSpecial.get(id);
      if (sp !== undefined) {
        flush();
        out += sp;
      } else {
        run.push(id);
      }
    }
    flush();
    return out;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------- engine client ----

interface GenResult {
  ids: number[];
  stop: string;
  produced: number;
  promptTokens: number;
  promptMs: number;
  decodeMs: number;
}

class StrataEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  // One sequence at a time: the engine reads stdin on its own thread and the
  // Python server serializes requests behind a FIFO. Copy that.
  private queue: Promise<unknown> = Promise.resolve();
  // State of the request currently being streamed.
  private current: {
    ids: number[];
    resolve: (r: GenResult) => void;
    reject: (e: Error) => void;
    onToken?: (id: number) => void;
  } | null = null;

  async start(): Promise<void> {
    const proc = spawn(ENGINE, ENGINE_ARGS, {
      cwd: '/home/ueiricho/Programs/AI/Strata',
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: '1,2,3',
        CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
        LD_LIBRARY_PATH:
          `/usr/local/cuda-13.4/bin:/usr/local/cuda-13.4/lib64${
            process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''
          }`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (s: string) => process.stderr.write(`[engine] ${s}`));
    proc.on('exit', (code, signal) => {
      this.ready = false;
      this.current?.reject(new Error(`engine exited (code=${code} signal=${signal})`));
      this.current = null;
      console.error(`[strata] engine exited (code=${code} signal=${signal})`);
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));

    // First stdout line is the handshake: "READY <max_context> stop"
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`engine did not become ready within ${READY_TIMEOUT_MS} ms`)),
        READY_TIMEOUT_MS,
      );
      const check = setInterval(() => {
        if (this.ready) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  private onLine(line: string): void {
    if (!this.ready) {
      // Everything before READY is load noise on stdout; the handshake is the
      // first line starting with READY.
      if (line.startsWith('READY')) {
        console.error(`[strata] ${line}`);
        this.ready = true;
      }
      return;
    }
    const cur = this.current;
    if (!cur) return; // engine is chatty between requests (stats lines) — ignore

    if (line.startsWith('T ')) {
      const id = Number(line.slice(2));
      if (Number.isFinite(id)) {
        cur.ids.push(id);
        cur.onToken?.(id);
      }
      return;
    }
    if (line.startsWith('ERR ')) {
      this.current = null;
      cur.reject(new Error(line.slice(4).trim()));
      return;
    }
    if (line.startsWith('DONE')) {
      // DONE <produced> <prompt_tokens> <prompt_ms> <decode_ms> <reason> ...
      const f = line.split(/\s+/);
      this.current = null;
      cur.resolve({
        ids: cur.ids,
        produced: Number(f[1]),
        promptTokens: Number(f[2]),
        promptMs: Number(f[3]),
        decodeMs: Number(f[4]),
        stop: f[5] ?? 'unknown',
      });
      return;
    }
    // RESUME / PP / REUSED and stats noise: informational only.
    if (line.startsWith('FATAL')) {
      this.current = null;
      cur.reject(new Error(line));
    }
  }

  /** Queue one generation. `onToken` streams each generated id as it arrives. */
  generate(
    ids: number[],
    maxNew: number,
    sampling: Record<string, string | number>,
    onToken?: (id: number) => void,
  ): Promise<GenResult> {
    const run = () =>
      new Promise<GenResult>((resolve, reject) => {
        if (!this.ready || !this.proc) {
          reject(new Error('engine not ready'));
          return;
        }
        this.current = { ids: [], resolve, reject, onToken };
        const keys = Object.entries(sampling)
          .map(([k, v]) => ` ${k}=${v}`)
          .join('');
        const line = `GEN ${maxNew}${keys} ${ids.join(',')}\n`;
        this.proc.stdin.write(line);
      });
    // Chain onto the queue; keep going even if a request failed.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stop(): void {
    this.proc?.stdin.write('STOP\n');
  }

  quit(): void {
    this.proc?.stdin.write('QUIT\n');
    this.proc?.kill();
  }
}

// ------------------------------------------------------ chat template ----

// Hardcoded Qwen3 ChatML wrapper (serve/chat_template.jinja is 183 lines of
// Jinja; for plain chat this is all it effectively emits).
function renderChat(messages: { role: string; content: string }[]): string {
  let out = '';
  for (const m of messages) out += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
  return out + '<|im_start|>assistant\n';
}

// ---------------------------------------------------------------- main ----

async function main(): Promise<void> {
  const tok = new StrataTokenizer(TOKENIZER);
  const engine = new StrataEngine();
  await engine.start();

  const app = express();
  app.use(express.json({ limit: '64mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/v1/models', (_req, res) =>
    res.json({
      object: 'list',
      data: [{ id: MODEL_NAME, object: 'model', owned_by: 'strata' }],
    }),
  );

  app.post('/v1/chat/completions', async (req, res) => {
    const body = req.body ?? {};
    const messages: { role: string; content: string }[] = body.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: { message: 'messages required' } });
      return;
    }

    const maxNew = Number(body.max_tokens ?? 512);
    const prompt = tok.encode(renderChat(messages));

    // Per-request sampling -> engine GEN keys. Absent = greedy.
    const sampling: Record<string, string | number> = {};
    if (body.temperature !== undefined) sampling.temperature = body.temperature;
    if (body.top_p !== undefined) sampling.top_p = body.top_p;
    if (body.top_k !== undefined) sampling.top_k = body.top_k;
    if (body.seed !== undefined) sampling.seed = body.seed;

    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${created}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const send = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        send({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: MODEL_NAME,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        // Decode incrementally so a multi-byte character split across tokens is
        // emitted whole: hold ids while the decode ends on a replacement char.
        let pending: number[] = [];
        const emit = (done = false) => {
          if (!pending.length) return;
          const text = tok.decode(pending);
          if (!done && text.endsWith('\uFFFD')) return;
          pending = [];
          if (text) {
            send({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: MODEL_NAME,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            });
          }
        };

        const result = await engine.generate(prompt, maxNew, sampling, (id) => {
          if (EOS_IDS.has(id)) return;
          pending.push(id);
          emit();
        });
        emit(true);

        send({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: MODEL_NAME,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        send({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: MODEL_NAME,
          choices: [],
          usage: {
            prompt_tokens: result.promptTokens,
            completion_tokens: result.produced,
            total_tokens: result.promptTokens + result.produced,
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const result = await engine.generate(prompt, maxNew, sampling);
        const gen = result.ids.filter((id) => !EOS_IDS.has(id));
        res.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model: MODEL_NAME,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: tok.decode(gen) },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: result.promptTokens,
            completion_tokens: result.produced,
            total_tokens: result.promptTokens + result.produced,
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[strata] request failed: ${message}`);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: { message } });
      }
    }
  });

  app.listen(PORT, () => {
    console.log(`strata-ts ready: http://127.0.0.1:${PORT}/v1  (model: ${MODEL_NAME})`);
  });

  const shutdown = () => {
    console.error('[strata] shutting down');
    engine.quit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
