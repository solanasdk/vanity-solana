#!/usr/bin/env node
"use strict";

/**
 * vanityGen.js — Multi-core Solana vanity address grinder (RANDOM ONLY)
 *
 * Generates random Solana keypairs in parallel and saves **two files per hit**:
 *   1) vanityGen/<PUBKEY>.json          → array[64] of integers (exact solana-keygen format)
 *   2) vanityKeysGen/<PUBKEY>.key.json  → { publicKey, secretKeyBase58 }  ← wallet-friendly
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHAT IS A "GROUP"?
 * ──────────────────────────────────────────────────────────────────────────────
 * A **group** is one set of matching rules applied together.
 * • Inside a group, different rule types (start / end / contains) are **AND-ed**.
 * • Within the same rule type, multiple values are **OR-ed**.
 * • Across groups, results are **OR-ed** (the pubkey may match any one group).
 *
 * Build groups with flags:
 *   -g           start a NEW group
 *   -s <val>     pubkey **starts with** <val> (repeatable; comma list OK: -s dev,fun)
 *   -e <val>     pubkey **ends with** <val>   (repeatable; comma list OK: -e 8,so1)
 *   -m <val>     pubkey **contains** <val>    (repeatable; comma list OK: -m jup,wrap)
 *   -ci          toggle **case-insensitive** for CURRENT group (default: sensitive)
 *
 * Examples:
 * 1) One group: start AND end
 *    node vanityGen.js -g -s dev -e pump
 *    → starts with "dev" AND ends with "pump".
 *
 * 2) One group: multiple starts OR multiple ends
 *    node vanityGen.js -g -s dev -s fun -e pump -e so1
 *    → (starts dev OR fun) AND (ends pump OR so1).
 *
 * 3) One group: contains + start + end
 *    node vanityGen.js -g -s Jup -m 777 -e jup
 *    → starts Jup AND contains 777 AND ends jup.
 *
 * 4) Two groups (OR across groups)
 *    node vanityGen.js -g -s 88 -e 88  -g -s 78 -e 78
 *    → (starts 88 AND ends 88) OR (starts 78 AND ends 78).
 *
 * 5) Case-insensitive group
 *    node vanityGen.js -g -ci -s wrap -e so1
 *    → match ignoring case: starts "wrap" AND ends "so1".
 *
 * 6) Comma lists (shorthand)
 *    node vanityGen.js -g -s dev,fun -e pump,so1
 *    → same as repeating flags.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * FLAGS (≤4 chars)
 * ──────────────────────────────────────────────────────────────────────────────
 * Rule building
 *   -g           start NEW group
 *   -s <str>     STARTS-WITH (repeatable; comma list OK)
 *   -e <str>     ENDS-WITH   (repeatable; comma list OK)
 *   -m <str>     CONTAINS    (repeatable; comma list OK)
 *   -ci          toggle CASE-INSENSITIVE for CURRENT group (default: case-sensitive)
 *
 * Run / Output
 *   -w <n>       workers (default: CPU cores)
 *   -cnt <n>     stop after n matches (default 10)
 *   -out <dir>   folder for 64-int files (default vanityGen)
 *   -outk <dir>  folder for key.json files (default vanityKeysGen)
 *   -dbg <n>     print first n pubkeys per worker (sanity)
 *   -q           quiet (no progress line)
 *   -h, --help   help
 *
 * Install once:
 *   npm i @solana/web3.js bs58
 *
 * Quick examples:
 *   node vanityGen.js -cnt 10 -g -s 88 -e 88 -g -s 78 -e 78
 *   node vanityGen.js -w 8 -cnt 5  -g -s dev -e pump -g -s fun -e pump
 *   node vanityGen.js -w 1 -cnt 1  -g -s 8
 *   node vanityGen.js -w 1 -cnt 1  -g -e 8
 *
 * Defaults (if no rules are provided):
 *   [1] start 'Jup', end 'jup' (CS)
 *   [2] start 'dev', end 'so1' (CS)
 *   [3] start 'dev', end 'pump' (CS)
 *   [4] start 'fun', end 'pump' (CS)
 *   [5] start in {usdv2, So1, USDV2, node, wrap} AND end in {dev, node, jup, so1} (CS)
 *   [6] contains one of {abraham, 1111111, Binance} (CS)
 *   [7] start in {Node, Wrap} AND end in {dev, node, jup, so1} (CI)
 *   [8] ends in {pump} AND contains {777} (CS)
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

// Base58 for wallet-friendly private key
let bs58; try { bs58 = require("bs58"); } catch {}
const b58encode = (buf) => {
  try {
    if (bs58 && typeof bs58.encode === "function") return bs58.encode(buf);
    if (bs58 && bs58.default && typeof bs58.default.encode === "function") return bs58.default.encode(buf);
  } catch {}
  // Fallback to hex if bs58 isn’t present; install `bs58` for Base58.
  return Buffer.from(buf).toString("hex");
};

// ───────── CLI ─────────
function parseArgs(argv) {
  const args = {
    groups: [],
    workers: Math.max(1, os.cpus().length),
    count: 10,
    outDir: "vanityGen",
    outKeyDir: "vanityKeysGen",
    debug: 0,
    quiet: false,
  };

  const help = `
Usage: node vanityGen.js [rules...] [options]

Rules (groups OR-ed; inside group AND-ed):
  -g            start NEW group
  -s <v>        STARTS-WITH (repeatable; comma list OK)
  -e <v>        ENDS-WITH   (repeatable; comma list OK)
  -m <v>        CONTAINS    (repeatable; comma list OK)
  -ci           toggle CASE-INSENSITIVE for current group (default: case-sensitive)

Options:
  -w <n>        workers (default CPU cores)
  -cnt <n>      stop after n matches (default 10)
  -out <dir>    folder for 64-int keypair files (default vanityGen)
  -outk <dir>   folder for wallet-friendly key.json (default vanityKeysGen)
  -dbg <n>      print first n pubkeys per worker (sanity)
  -q            quiet mode (no progress line)
  -h, --help    help
`.trim();

  // group builders
  const currentGroup = () => args.groups[args.groups.length - 1];
  const hasCurrent = () => args.groups.length > 0;
  const groupHasRules = (g) => g && (g.start.length || g.end.length || g.any.length);
  function startNewGroupIfNeeded() { if (!hasCurrent()) args.groups.push({ start: [], end: [], any: [], caseSensitive: true }); }
  function addList(v, push) { String(v ?? "").split(",").map(s => s.trim()).filter(Boolean).forEach(push); }
  function addStart(v){ startNewGroupIfNeeded(); addList(v, x => currentGroup().start.push(x)); }
  function addEnd(v)  { startNewGroupIfNeeded(); addList(v, x => currentGroup().end.push(x)); }
  function addAny(v)  { startNewGroupIfNeeded(); addList(v, x => currentGroup().any.push(x)); }
  function toggleCI() { startNewGroupIfNeeded(); const g=currentGroup(); g.caseSensitive=!g.caseSensitive; }

  const toNum = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { console.log(help); process.exit(0); }
    else if (a === "-g") { if (!hasCurrent() || groupHasRules(currentGroup())) args.groups.push({ start: [], end: [], any: [], caseSensitive: true }); }
    else if (a === "-s") addStart(argv[++i]);
    else if (a === "-e") addEnd(argv[++i]);
    else if (a === "-m") addAny(argv[++i]);
    else if (a === "-ci") toggleCI();
    else if (a === "-w") args.workers = Math.max(1, Math.floor(toNum(argv[++i], args.workers)));
    else if (a === "-cnt") args.count = Math.max(1, Math.floor(toNum(argv[++i], args.count)));
    else if (a === "-out") args.outDir = argv[++i] || "vanityGen";
    else if (a === "-outk") args.outKeyDir = argv[++i] || "vanityKeysGen";
    else if (a === "-dbg") args.debug = Math.max(0, Math.floor(toNum(argv[++i], 0)));
    else if (a === "-q") args.quiet = true;
    else { console.error(`Unknown flag: ${a}\n\n${help}`); process.exit(1); }
  }

  // Defaults if nothing provided
  if (!args.groups.length || (!args.groups[0].start.length && !args.groups[0].end.length && !args.groups[0].any.length)) {
    args.groups = [
      { start: ["Jup"], end: ["jup"], any: [], caseSensitive: true },
      { start: ["dev"], end: ["so1"], any: [], caseSensitive: true },
      { start: ["dev"], end: ["pump"], any: [], caseSensitive: true },
      { start: ["fun"], end: ["pump"], any: [], caseSensitive: true },
      { start: ["usdv2","So1","USDV2","node","wrap"], end: ["dev","node","jup","so1"], any: [], caseSensitive: true },
      { start: [], end: [], any: ["abraham","1111111","Binance"], caseSensitive: true },
      { start: ["Node","Wrap"], end: ["dev","node","jup","so1"], any: [], caseSensitive: false },
      { start: [], end: ["pump"], any: ["777"], caseSensitive: true },
    ];
  }
  return args;
}

// ───────── utils ─────────
function safeName(pub) { return pub.replace(/[^A-Za-z0-9._-]/g, "_"); }
function uniquePath(dir, base) {
  let p = path.join(dir, base + ".json");
  if (!fs.existsSync(p)) return p;
  for (let i = 1; ; i++) { const q = path.join(dir, `${base}(${i}).json`); if (!fs.existsSync(q)) return q; }
}
function fmtGroup(g){
  const p=[]; if(g.start.length)p.push("^"+g.start.join("|")); if(g.any.length)p.push("~"+g.any.join("|")); if(g.end.length)p.push(g.end.join("|")+"$"); if(!g.caseSensitive)p.push("[i]");
  return p.join(" ");
}

// ───────── main / workers ─────────
if (isMainThread) {
  const args = parseArgs(process.argv);
  const { groups, workers, count, outDir, outKeyDir, debug, quiet } = args;

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(outKeyDir, { recursive: true });

  console.log(`Searching with ${workers} thread(s) for: ${groups.map(fmtGroup).join("  OR  ")}`);
  console.log(`Flags: -g=new group | -s=start | -e=end | -m=contains | -ci=case-insensitive group | -w workers | -cnt matches | -out dir | -outk keydir | -dbg n | -q quiet`);
  console.log(`Output: 64-int → ${path.resolve(outDir)} | key.json → ${path.resolve(outKeyDir)}`);

  let matches = 0;
  let done = false;
  const attempts = new Array(workers).fill(0);
  const children = [];

  function finalize() {
    if (!quiet) process.stdout.write("\n");
    console.log("Total Vanity Keypairs Generated:", matches);
    process.exit(0);
  }
  async function stopAll() {
    if (done) return;
    done = true;
    if (!quiet) process.stdout.write("\nStopping workers...\n");
    for (const w of children) { try { await w.terminate(); } catch {} }
    finalize();
  }
  function maybeStop(){ if (!done && matches >= count) stopAll(); }
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);

  // progress ticker (1/s)
  let lastSum = 0, lastT = Date.now(), startT = lastT;
  if (!quiet) setInterval(() => {
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    const sum = attempts.reduce((a,b)=>a+b,0);
    const rate = (sum - lastSum) / Math.max(0.001, dt);
    const elapsed = (now - startT) / 1000;
    const rateStr = rate>=1e6 ? (rate/1e6).toFixed(2)+"M/s" : rate>=1e3 ? (rate/1e3).toFixed(1)+"k/s" : rate.toFixed(0)+"/s";
    process.stdout.write(`\rElapsed: ${elapsed.toFixed(1)}s | Rate: ${rateStr} | Matches: ${matches}/${count}   `);
    lastSum = sum; lastT = now;
  }, 1000);

  for (let i = 0; i < workers; i++) {
    const w = new Worker(__filename, { workerData: { id:i, groups, debug }});
    children.push(w);
    w.on("message", (msg) => {
      if (done) return;
      if (msg.type === "progress") {
        attempts[msg.id >>> 0] += msg.n >>> 0;
      } else if (msg.type === "match") {
        const { publicKey, secretBytes } = msg;
        try {
          const base = safeName(publicKey);

          // (1) Standard 64-int file for CLI tools
          const arrayFile = uniquePath(outDir, base);
          fs.writeFileSync(arrayFile, JSON.stringify(secretBytes));

          // (2) Wallet-friendly key.json (ONLY publicKey + Base58 private)
          const keyFile = uniquePath(outKeyDir, base + ".key"); // -> <PUB>.key.json
          const secBuf = Buffer.from(secretBytes);
          const minimal = {
            publicKey,
            secretKeyBase58: b58encode(secBuf),
          };
          fs.writeFileSync(keyFile, JSON.stringify(minimal, null, 2));

          matches++;
          if (!quiet) {
            process.stdout.write(`\nMATCH [${matches}/${count}] ${publicKey}\nSaved: ${arrayFile}\nSaved: ${keyFile}\n`);
          } else {
            console.log(`MATCH [${matches}/${count}] ${publicKey} -> ${arrayFile} | ${keyFile}`);
          }
          maybeStop();
        } catch (e) { console.error("Write error:", e); }
      } else if (msg.type === "dbg") {
        console.log(`[w${msg.id}] ${msg.pub}`);
      }
    });
    w.on("error", (e) => console.error("Worker error:", e));
  }

} else {
  // ───────── worker ─────────
  const { Keypair } = require("@solana/web3.js");
  const { id, groups, debug } = workerData;

  // Prepare predicates
  const preds = (groups || []).map(g => {
    const cs = !!g.caseSensitive;
    const S = (g.start||[]).map(x=>cs?x:x.toLowerCase());
    const E = (g.end  ||[]).map(x=>cs?x:x.toLowerCase());
    const M = (g.any  ||[]).map(x=>cs?x:x.toLowerCase());
    return (pub) => {
      const a = cs ? pub : pub.toLowerCase();
      if (S.length && !S.some(x => a.startsWith(x))) return false;
      if (E.length && !E.some(x => a.endsWith(x)))   return false;
      if (M.length && !M.some(x => a.includes(x)))   return false;
      return true;
    };
  });
  const matches = pub => preds.some(f => f(pub));

  const STEP = 8192;  // fewer IPC calls = faster
  let local = 0;
  let dbgLeft = Math.max(0, debug|0);

  while (true) {
    for (let i = 0; i < STEP; i++) {
      const kp = Keypair.generate();
      const pub = kp.publicKey.toString();
      const sec = Buffer.from(kp.secretKey); // 64 bytes (seed||pub)

      if (dbgLeft > 0) { parentPort.postMessage({ type: "dbg", id, pub }); dbgLeft--; }
      if (matches(pub)) {
        parentPort.postMessage({ type: "match", publicKey: pub, secretBytes: Array.from(sec) });
      }
      local++;
    }
    parentPort.postMessage({ type: "progress", id, n: local });
    local = 0;
  }
}
