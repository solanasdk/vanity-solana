#!/usr/bin/env node
"use strict";

/**
 * listAddresses.js — Build a one-line list of Base58 public keys from JSON key files.
 *
 * INCLUDED files (in target folder):
 *   • A 64-int array JSON (standard Solana keypair: [32 priv bytes, 32 pub bytes])
 *   • An object JSON that has **both**:
 *       { publicKey: "<base58>", secretKeyBase58: "<base58>" }
 *
 * Sorting (customizable):
 *   • Default: right-to-left (compare last char first), **letters before digits** at each position.
 *   • -a    : left-to-right (compare first char first)
 *   • -num  : numbers first (digits before letters) at each position
 *   • Ties within same letter ignore case first, then ASCII (so 'A' < 'a').
 *
 * Output:
 *   <dir>/listAddresses.txt   (single line, keys separated by ", ")
 *
 * Flags:
 *   -dir <folder>   folder to scan (and where listAddresses.txt is written). Default "."
 *   -a              sort left-to-right (default is right-to-left)
 *   -num            numbers-first (default letters-first)
 *   -q              quiet mode
 *   -h, --help      help
 */

const fs = require("fs");
const path = require("path");

// Base58 is required
let bs58;
try { bs58 = require("bs58"); }
catch {
  console.error("This tool requires 'bs58'. Install with: npm i bs58");
  process.exit(1);
}

function helpAndExit(code=0){
  console.log(`
Usage:
  node listAddresses.js [-dir <folder>] [-a] [-num] [-q]

Options:
  -dir <folder>   folder to scan (and where listAddresses.txt is written)
                  default: current directory (.)
  -a              sort left-to-right (default: right-to-left)
  -num            numbers-first at each position (default: letters-first)
  -q              quiet mode
  -h, --help      help
`.trim());
  process.exit(code);
}

function parseArgs(argv){
  const args = { dir: ".", quiet: false, rtl: true, lettersFirst: true };
  for (let i=2;i<argv.length;i++){
    const a = argv[i];
    if (a === "-h" || a === "--help") helpAndExit(0);
    else if (a === "-dir") args.dir = argv[++i] || args.dir;
    else if (a === "-q") args.quiet = true;
    else if (a === "-a") args.rtl = false;           // left-to-right
    else if (a === "-num") args.lettersFirst = false;// numbers-first
    else { console.error(`Unknown flag: ${a}`); helpAndExit(1); }
  }
  return args;
}

// --- inclusion shapes ---
function looksLikeIntArray64(x){
  if (!Array.isArray(x) || x.length !== 64) return false;
  for (const n of x) if ((n|0)!==n || n<0 || n>255) return false;
  return true;
}
function extractPubFrom64IntArray(arr){
  // last 32 bytes are the public key per Solana keypair format
  const pub = Buffer.from(arr.slice(32, 64));
  return (bs58.encode ? bs58.encode(pub) : bs58.default.encode(pub));
}
function extractPubFromBothFields(obj){
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.publicKey !== "string" || typeof obj.secretKeyBase58 !== "string") return null;
  return obj.publicKey; // trusted as provided
}
function extractPublicKey(filePath){
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    if (looksLikeIntArray64(j)) return extractPubFrom64IntArray(j);
    const pk = extractPubFromBothFields(j);
    if (pk) return pk;
    return null;
  } catch { return null; }
}

// --- comparators ---
function makeCharClassifier(lettersFirst){
  // Returns a function that maps a char to a tuple for ordering:
  // [classRank, caseInsensitiveRank, asciiRank]
  // classRank depends on lettersFirst: 0=preferred class, 1=secondary (digits), 2=others
  const preferred = lettersFirst ? "letter" : "digit";
  return function charKey(ch){
    let cls = 2; // others (shouldn't appear in Base58)
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      cls = (preferred === "letter") ? 0 : 1;
      return [cls, ch.toLowerCase().charCodeAt(0), ch.charCodeAt(0)];
    }
    if (ch >= '0' && ch <= '9') {
      cls = (preferred === "digit") ? 0 : 1;
      return [cls, ch.charCodeAt(0), ch.charCodeAt(0)];
    }
    return [2, ch.charCodeAt(0), ch.charCodeAt(0)];
  };
}

function makeComparator({ rtl, lettersFirst }){
  const charKey = makeCharClassifier(lettersFirst);
  return function cmp(a, b){
    const la = a.length, lb = b.length;
    const max = Math.max(la, lb);
    if (rtl) {
      // right-to-left: compare from end
      for (let i = 1; i <= max; i++){
        const ca = (la - i >= 0) ? a[la - i] : null;
        const cb = (lb - i >= 0) ? b[lb - i] : null;
        if (ca === cb) continue;
        if (ca === null) return -1; // shorter a first
        if (cb === null) return 1;  // shorter b first
        const ka = charKey(ca), kb = charKey(cb);
        for (let j = 0; j < ka.length; j++){
          if (ka[j] < kb[j]) return -1;
          if (ka[j] > kb[j]) return 1;
        }
      }
      return 0;
    } else {
      // left-to-right: compare from start
      const min = Math.min(la, lb);
      for (let i = 0; i < min; i++){
        const ca = a[i], cb = b[i];
        if (ca === cb) continue;
        const ka = charKey(ca), kb = charKey(cb);
        for (let j = 0; j < ka.length; j++){
          if (ka[j] < kb[j]) return -1;
          if (ka[j] > kb[j]) return 1;
        }
      }
      // If equal up to min, shorter first
      if (la < lb) return -1;
      if (la > lb) return 1;
      return 0;
    }
  };
}

// --- main ---
(function main(){
  const { dir, quiet, rtl, lettersFirst } = parseArgs(process.argv);
  const absDir = path.resolve(dir);

  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    console.error(`Directory does not exist: ${absDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(absDir).filter(f => f.toLowerCase().endsWith(".json"));
  if (!files.length) {
    if (!quiet) console.log("No .json files found in", absDir);
    const listPath = path.join(absDir, "listAddresses.txt");
    fs.writeFileSync(listPath, "");
    console.log(`Wrote empty ${path.relative(process.cwd(), listPath)}`);
    process.exit(0);
  }

  const keys = new Set();
  let scanned = 0, added = 0, skipped = 0;

  for (const name of files) {
    const p = path.join(absDir, name);
    scanned++;
    const pk = extractPublicKey(p);
    if (pk) { keys.add(pk); added++; } else { skipped++; }
  }

  const comparator = makeComparator({ rtl, lettersFirst });
  const sorted = Array.from(keys).sort(comparator);
  const line = sorted.join(", ");
  const outPath = path.join(absDir, "listAddresses.txt");

  // Avoid rewriting if identical
  let changed = true;
  if (fs.existsSync(outPath)) {
    try { if (fs.readFileSync(outPath, "utf8") === line) changed = false; } catch {}
  }

  if (changed) {
    fs.writeFileSync(outPath, line);
    if (!quiet) console.log(`WROTE ${path.relative(process.cwd(), outPath)} (${sorted.length} unique keys)` +
      ` | Order: ${rtl ? "RTL" : "LTR"}, ${lettersFirst ? "letters-first" : "numbers-first"}`);
  } else if (!quiet) {
    console.log(`UNCHANGED ${path.relative(process.cwd(), outPath)} (${sorted.length} unique keys)` +
      ` | Order: ${rtl ? "RTL" : "LTR"}, ${lettersFirst ? "letters-first" : "numbers-first"}`);
  }

  if (!quiet) console.log(`Scanned: ${scanned} | Added: ${added} | Skipped: ${skipped}`);
  process.exit(0);
})();
