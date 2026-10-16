import type { ExtensionDiffFile, HunkExtensionAPI } from "hunkdiff/extension";

// ] / [: 変更が連続している範囲(削除行と追加行が続く部分)の先頭行へ移動する。
// 標準の ] / [ は、全文表示だと変更のかたまりが 1 ファイルに 1 つになり、ファイル単位でしか飛べないため、
// 差分テキスト(patch)から変更の先頭行を求めて移動する。全文表示でも差分のみの表示でも動く。

type Side = "old" | "new";
type Row = { kind: " " | "-" | "+"; oldLine: number; newLine: number };
// stopRow: 移動先の行の番号(追加行があれば最初の追加行、削除だけなら最初の削除行)
type Block = { stopRow: number; side: Side; line: number };

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
      rows.push({ kind: "-", oldLine, newLine });
      oldLine += 1;
    } else if (text.startsWith("+")) {
      rows.push({ kind: "+", oldLine, newLine });
      newLine += 1;
    } else if (text.startsWith(" ")) {
      rows.push({ kind: " ", oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

// 連続した変更を 1 つのかたまりとして扱い、かたまりごとの移動先を返す
function findBlocks(rows: Row[]): { blocks: Block[]; blockOfRow: Map<number, Block> } {
  const blocks: Block[] = [];
  const blockOfRow = new Map<number, Block>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind === " ") {
      i += 1;
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].kind !== " ") end += 1;
    const added = rows.findIndex((row, index) => index >= i && index < end && row.kind === "+");
    const stopRow = added >= 0 ? added : i;
    const stop = rows[stopRow];
    const block: Block = { stopRow, side: added >= 0 ? "new" : "old", line: added >= 0 ? stop.newLine : stop.oldLine };
    blocks.push(block);
    for (let r = i; r < end; r += 1) blockOfRow.set(r, block);
    i = end;
  }
  return { blocks, blockOfRow };
}

function rowIndexOf(rows: Row[], side: Side, line: number): number {
  return rows.findIndex((row) =>
    side === "new" ? row.kind !== "-" && row.newLine === line : row.kind !== "+" && row.oldLine === line,
  );
}

function blocksOf(file: ExtensionDiffFile) {
  return findBlocks(parseRows(file.patch)).blocks;
}

export default function (hunk: HunkExtensionAPI) {
  const move = (direction: 1 | -1) => (ctx: any) => {
    const { file, currentLine, files } = ctx.selection as {
      file: ExtensionDiffFile | null;
      currentLine: { side: Side; line: number } | null;
      files: readonly ExtensionDiffFile[];
    };
    if (!file) {
      ctx.notify("ファイルが選択されていません", "warning");
      return;
    }

    // 今のファイル内で、カーソルの次(前)のかたまりを探す
    const rows = parseRows(file.patch);
    const { blocks, blockOfRow } = findBlocks(rows);
    let target: Block | undefined;
    if (currentLine) {
      const rowIndex = rowIndexOf(rows, currentLine.side, currentLine.line);
      // かたまりの中にいるときは、そのかたまりの移動先(の位置か、それより後ろの行)を現在位置とみなす
      const here = blockOfRow.get(rowIndex);
      const position = here ? Math.max(rowIndex, here.stopRow) : rowIndex;
      target =
        direction === 1
          ? blocks.find((block) => block.stopRow > position)
          : [...blocks].reverse().find((block) => block.stopRow < position);
    } else {
      target = direction === 1 ? blocks[0] : blocks[blocks.length - 1];
    }
    if (target) {
      ctx.navigation.revealLine(file.id, target.side, target.line);
      return;
    }

    // ファイルの端なら、変更のある隣のファイルの最初(最後)の変更へ進む
    const index = files.findIndex((candidate) => candidate.id === file.id);
    for (let i = index + direction; i >= 0 && i < files.length; i += direction) {
      const candidate = blocksOf(files[i]);
      if (candidate.length === 0) continue;
      const block = direction === 1 ? candidate[0] : candidate[candidate.length - 1];
      ctx.navigation.revealLine(files[i].id, block.side, block.line);
      return;
    }
    ctx.notify(direction === 1 ? "最後の変更です" : "最初の変更です");
  };

  hunk.registerCommand({ id: "next-change-line", title: "次の変更へ移動", key: "]" }, move(1));
  hunk.registerCommand({ id: "prev-change-line", title: "前の変更へ移動", key: "[" }, move(-1));
}
