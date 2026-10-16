import type { ExtensionDiffFile, HunkExtensionAPI } from "hunkdiff/extension";

// Home / End: 今の行の行頭 / 行末へ横スクロールする。
// Ctrl+Home / Ctrl+End: 今のファイルの先頭 / 最後の行へ移動する(g / G はレビュー全体の先頭 / 末尾のまま)。
// 全文表示(F)ならファイルの 1 行目と最終行、差分のみならファイルの最初と最後のかたまりの端になる。

type Side = "old" | "new";
type Row = { kind: " " | "-" | "+"; oldLine: number; newLine: number; text: string };

// 横スクロールの上限(hunk のコマンド 1 回あたりの回数の上限)
const MAX_SCROLL_COUNT = 10_000;
// 左のファイル一覧の幅(ビューポートが 160 桁以上のとき表示される)と、行番号などの余白の目安
const SIDEBAR_COLUMNS = 27;
const SIDEBAR_MIN_VIEWPORT = 160;
const GUTTER_COLUMNS = 8;
// 左右並び(split)になるビューポートの幅(auto レイアウトの場合)
const SPLIT_MIN_VIEWPORT = 120;
// 行末が見切れないよう、行末の右に空ける桁数
const END_MARGIN_COLUMNS = 12;
const TAB_COLUMNS = 4;

function parseRows(patch: string): Row[] {
  const rows: Row[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
    } else if (!inHunk || text.startsWith("\\")) {
      continue;
    } else if (text.startsWith("-")) {
      rows.push({ kind: "-", oldLine, newLine, text: text.slice(1) });
      oldLine += 1;
    } else if (text.startsWith("+")) {
      rows.push({ kind: "+", oldLine, newLine, text: text.slice(1) });
      newLine += 1;
    } else if (text.startsWith(" ")) {
      rows.push({ kind: " ", oldLine, newLine, text: text.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

// 表示幅(全角は 2 桁、タブは TAB_COLUMNS 桁)
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\t") width += TAB_COLUMNS;
    else if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x1f300
    )
      width += 2;
    else width += 1;
  }
  return width;
}

export default function (hunk: HunkExtensionAPI) {
  // 左右並びかどうかは layout_changed で追い、まだ分からなければ画面の幅から推定する
  let splitLayout: boolean | null = null;
  hunk.on("layout_changed", ({ canonicalLayout }) => {
    splitLayout = canonicalLayout ? canonicalLayout === "split" : null;
  });

  const estimateCodeColumns = () => {
    const viewport = process.stdout.columns ?? 120;
    const available = viewport - (viewport >= SIDEBAR_MIN_VIEWPORT ? SIDEBAR_COLUMNS : 0) - GUTTER_COLUMNS;
    const split = splitLayout ?? viewport >= SPLIT_MIN_VIEWPORT;
    return split ? Math.floor(available / 2) : available;
  };

  hunk.registerCommand({ id: "line-start", title: "行頭へ移動", key: "home" }, (ctx) => {
    ctx.commands.execute("hunk.review.scrollCodeLeft", { count: MAX_SCROLL_COUNT });
  });

  hunk.registerCommand({ id: "line-end", title: "行末へ移動", key: "end" }, (ctx) => {
    ctx.commands.execute("hunk.review.scrollCodeLeft", { count: MAX_SCROLL_COUNT });
    const { file, currentLine } = ctx.selection;
    if (!file || !currentLine) return;
    const rows = parseRows(file.patch);
    const index = rows.findIndex((candidate) =>
      currentLine.side === "new"
        ? candidate.kind !== "-" && candidate.newLine === currentLine.line
        : candidate.kind !== "+" && candidate.oldLine === currentLine.line,
    );
    if (index < 0) return;

    // 左右並びでは、同じ行に並ぶ削除行と追加行が一緒にスクロールするため、組になる行の長いほうに合わせる
    const texts = [rows[index].text];
    if (rows[index].kind !== " ") {
      let first = index;
      while (first > 0 && rows[first - 1].kind === rows[index].kind) first -= 1;
      let blockStart = first;
      while (blockStart > 0 && rows[blockStart - 1].kind !== " ") blockStart -= 1;
      let blockEnd = index;
      while (blockEnd < rows.length && rows[blockEnd].kind !== " ") blockEnd += 1;
      const block = rows.slice(blockStart, blockEnd);
      const own = block.filter((candidate) => candidate.kind === rows[index].kind);
      const other = block.filter((candidate) => candidate.kind !== rows[index].kind);
      const pair = other[own.indexOf(rows[index])];
      if (pair) texts.push(pair.text);
    }
    // 行がコード欄より短ければ、左端のまま動かさない
    const scroll = Math.max(...texts.map(displayWidth)) - estimateCodeColumns() + END_MARGIN_COLUMNS;
    if (scroll > 0) ctx.commands.execute("hunk.review.scrollCodeRight", { count: Math.min(scroll, MAX_SCROLL_COUNT) });
  });

  const moveToFileEdge = (edge: "start" | "end") => (ctx: any) => {
    const file = ctx.selection.file as ExtensionDiffFile | null;
    if (!file) return;
    const rows = parseRows(file.patch);
    const row = edge === "start" ? rows[0] : rows[rows.length - 1];
    if (!row) return;
    const side: Side = row.kind === "-" ? "old" : "new";
    ctx.navigation.revealLine(file.id, side, side === "old" ? row.oldLine : row.newLine);
  };

  hunk.registerCommand({ id: "file-start", title: "ファイルの先頭へ移動", key: "ctrl+home" }, moveToFileEdge("start"));
  hunk.registerCommand({ id: "file-end", title: "ファイルの最後へ移動", key: "ctrl+end" }, moveToFileEdge("end"));
}
