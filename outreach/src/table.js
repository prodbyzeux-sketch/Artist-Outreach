// table.js — turn an uploaded CSV / TSV / XLSX file into { headers, rows }.
// No dependencies: delimited text is parsed by hand (RFC-4180 quoting), XLSX is
// unzipped with the browser's DecompressionStream and its first sheet read.

// ── delimited text (CSV / TSV / semicolon) ───────────────────────────────────
// Auto-detect the delimiter from the header line, then parse with quote support
// (quoted fields may contain the delimiter and newlines; "" is an escaped quote).
export function parseDelimited(text) {
  const clean = (text || "").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = clean.slice(0, clean.indexOf("\n") === -1 ? clean.length : clean.indexOf("\n"));
  const delim = pickDelimiter(firstLine);

  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return finalize(rows);
}

function pickDelimiter(line) {
  const counts = { ",": 0, "\t": 0, ";": 0 };
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";
}

// Drop fully-empty rows, take the first non-empty row as headers.
function finalize(rows) {
  const nonEmpty = rows.filter((r) => r.some((c) => (c ?? "").trim() !== ""));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => (h ?? "").trim());
  const body = nonEmpty.slice(1);
  return { headers, rows: body };
}

// ── XLSX ─────────────────────────────────────────────────────────────────────
export async function parseXLSX(arrayBuffer) {
  const files = await unzip(new Uint8Array(arrayBuffer));
  const dec = new TextDecoder();
  const sharedXml = files["xl/sharedStrings.xml"] ? dec.decode(files["xl/sharedStrings.xml"]) : "";
  const shared = parseSharedStrings(sharedXml);

  // First worksheet — prefer sheet1.xml, else the first xl/worksheets/*.xml.
  const sheetName =
    Object.keys(files).find((n) => n === "xl/worksheets/sheet1.xml") ||
    Object.keys(files).find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) throw new Error("no worksheet in xlsx");
  const grid = parseSheet(dec.decode(files[sheetName]), shared);
  return finalize(grid);
}

// Shared strings: <si>…</si>, each with one or more <t> runs to concatenate.
function parseSharedStrings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += xmlUnescape(t[1]);
    out.push(s);
  }
  return out;
}

// Sheet: <row>…<c r="A1" t="s"><v>idx</v></c>…</row>. Cells are placed by their
// column letter so blank cells don't shift the row.
function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    let maxCol = -1;
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      const col = ref ? colToIndex(ref) : cells.length;
      let value = "";
      const vm = cm[2].match(/<v>([\s\S]*?)<\/v>/);
      const im = cm[2].match(/<t[^>]*>([\s\S]*?)<\/t>/); // inlineStr
      if (type === "s" && vm) value = shared[parseInt(vm[1], 10)] ?? "";
      else if (type === "inlineStr" && im) value = xmlUnescape(im[1]);
      else if (vm) value = xmlUnescape(vm[1]);
      cells[col] = value;
      if (col > maxCol) maxCol = col;
    }
    for (let i = 0; i <= maxCol; i++) if (cells[i] == null) cells[i] = "";
    rows.push(cells);
  }
  return rows;
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xmlUnescape(s) {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

// Minimal ZIP reader: walk the central directory, inflate each entry we need via
// DecompressionStream('deflate-raw'). Returns { entryName: Uint8Array }.
async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of Central Directory — scan back for signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true); // central dir offset

  const out = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!/^xl\/(sharedStrings\.xml|worksheets\/.*\.xml)$/.test(name)) continue;

    // Local header: data starts after its own name+extra fields.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    out[name] = method === 0 ? comp : await inflateRaw(comp);
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(bytes).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── dispatch ─────────────────────────────────────────────────────────────────
export async function parseTableFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".xlsx")) return parseXLSX(await file.arrayBuffer());
  return parseDelimited(await file.text());
}
