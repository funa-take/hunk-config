import type { ExtensionDiffFile, HunkExtensionAPI } from "hunkdiff/extension";

// / n N: 検索語(正規表現)のマッチを 1 件ずつ移動する。
// 標準の検索は移動先を hunk ごとに 1 つにまとめるため、全文表示(F)では 1 ファイル 1 か所にしか止まらない。
// ここでは同じ行に複数あっても 1 件ずつ止まる。小文字だけの検索語は大文字・小文字を区別しない。
// マッチはすべて反転(current)で塗る。match は行の背景にわずかに混ぜた色で、緑・赤の行の上では見分けにくいため。

type Side = "old" | "new";
type Row = { side: Side; line: number; text: string };
// start / end: 行の本文の中の範囲(終了は含まない)
type Target = { fileIndex: number; fileId: string; path: string; rowIndex: number; side: Side; line: number; start: number; end: number; text: string };
type Mark = { side: Side; line: number; range: [number, number]; tone: "current" };

const HIGHLIGHTER_ID = "matches";
const STATUS_ID = "status";
const STATUS_TEXT_MAX = 60;
// ファイル内の行番号より大きい値にして、(ファイル, 行)の並びを 1 つの数で比べる
const FILE_STRIDE = 1_000_000;

// 削除行は旧側、追加行と文脈行は新側の行番号で扱う
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
      rows.push({ side: "old", line: oldLine, text: text.slice(1) });
      oldLine += 1;
    } else if (text.startsWith("+")) {
      rows.push({ side: "new", line: newLine, text: text.slice(1) });
      newLine += 1;
    } else if (text.startsWith(" ")) {
      rows.push({ side: "new", line: newLine, text: text.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

// 検索語を正規表現にして、1 行の中のマッチの範囲をすべて返す関数を作る
function compile(query: string): { ok: true; locate: (text: string) => [number, number][] } | { ok: false; error: string } {
  try {
    const pattern = new RegExp(query, query === query.toLowerCase() ? "gi" : "g");
    return {
      ok: true,
      locate: (text) => {
        const ranges: [number, number][] = [];
        pattern.lastIndex = 0;
        let found: RegExpExecArray | null;
        while ((found = pattern.exec(text)) !== null) {
          // 長さ 0 のマッチでは 1 文字進めて、無限ループを避ける
          const end = found.index + Math.max(found[0].length, 1);
          ranges.push([found.index, end]);
          pattern.lastIndex = end;
        }
        return ranges;
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function findTargets(files: readonly ExtensionDiffFile[], locate: (text: string) => [number, number][]): Target[] {
  const targets: Target[] = [];
  files.forEach((file, fileIndex) => {
    parseRows(file.patch).forEach((row, rowIndex) => {
      for (const [start, end] of locate(row.text)) {
        targets.push({ fileIndex, fileId: file.id, path: file.path, rowIndex, side: row.side, line: row.line, start, end, text: row.text });
      }
    });
  });
  return targets;
}

const rankOf = (fileIndex: number, rowIndex: number) => fileIndex * FILE_STRIDE + rowIndex;

const truncate = (text: string) => (text.length <= STATUS_TEXT_MAX ? text : `${text.slice(0, STATUS_TEXT_MAX - 1)}…`);

let query: string | null = null;
let current: Target | null = null;

export default function (hunk: HunkExtensionAPI) {
  hunk.registerLineHighlighter({
    id: HIGHLIGHTER_ID,
    highlight: ({ file }: { file: ExtensionDiffFile }): Mark[] | null => {
      if (query === null) return null;
      const compiled = compile(query);
      if (!compiled.ok) return null;
      const marks: Mark[] = [];
      for (const row of parseRows(file.patch)) {
        for (const [start, end] of compiled.locate(row.text)) {
          marks.push({ side: row.side, line: row.line, range: [start, end], tone: "current" });
        }
      }
      return marks;
    },
  });

  const show = (ctx: any, spans: { text: string; tone?: string }[]) => ctx.statusLine.set({ id: STATUS_ID, spans, priority: 1 });

  // direction: 前後。inclusive: 検索の直後に、カーソルのある行のマッチも対象にするか
  const go = (ctx: any, direction: 1 | -1, inclusive: boolean) => {
    if (query === null) {
      show(ctx, [{ text: "検索語がありません(/ で検索)", tone: "muted" }]);
      return;
    }
    const compiled = compile(query);
    if (!compiled.ok) {
      show(ctx, [{ text: `正規表現が正しくありません: ${compiled.error}`, tone: "removed" }]);
      return;
    }
    const { file, currentLine, files } = ctx.selection as {
      file: ExtensionDiffFile | null;
      currentLine: { side: Side; line: number } | null;
      files: readonly ExtensionDiffFile[];
    };
    const targets = findTargets(files, compiled.locate);
    if (targets.length === 0) {
      current = null;
      ctx.highlights.refresh(HIGHLIGHTER_ID);
      show(ctx, [{ text: `見つかりません: ${query}`, tone: "removed" }]);
      return;
    }

    // 直前に移動したマッチにカーソルがあれば、その次(前)へ進む。同じ行に複数あるときに、行の中を順に進めるため
    let index = -1;
    let wrapped = false;
    const last = current;
    if (last && file && currentLine && last.path === file.path && last.side === currentLine.side && last.line === currentLine.line) {
      const at = targets.findIndex((t) => t.path === last.path && t.side === last.side && t.line === last.line && t.start === last.start);
      if (at >= 0) {
        index = at + direction;
        if (index < 0 || index >= targets.length) {
          index = (index + targets.length) % targets.length;
          wrapped = true;
        }
      }
    }

    if (index < 0) {
      // カーソルの行を基準に、それより後(前)の最初のマッチを探す
      const fileIndex = file ? files.findIndex((candidate) => candidate.id === file.id) : -1;
      let position: number | null = null;
      if (file && fileIndex >= 0) {
        const rows = parseRows(file.patch);
        const rowIndex = currentLine ? rows.findIndex((row) => row.side === currentLine.side && row.line === currentLine.line) : -1;
        position = rankOf(fileIndex, rowIndex);
      }
      if (position === null) {
        index = direction === 1 ? 0 : targets.length - 1;
      } else if (direction === 1) {
        const from = position;
        index = targets.findIndex((t) => (inclusive ? rankOf(t.fileIndex, t.rowIndex) >= from : rankOf(t.fileIndex, t.rowIndex) > from));
        if (index < 0) {
          index = 0;
          wrapped = true;
        }
      } else {
        const from = position;
        for (let i = targets.length - 1; i >= 0; i -= 1) {
          if (rankOf(targets[i].fileIndex, targets[i].rowIndex) < from) {
            index = i;
            break;
          }
        }
        if (index < 0) {
          index = targets.length - 1;
          wrapped = true;
        }
      }
    }

    const target = targets[index];
    current = target;
    ctx.navigation.revealLine(target.fileId, target.side, target.line);
    ctx.highlights.refresh(HIGHLIGHTER_ID);
    show(ctx, [
      { text: `[${index + 1}/${targets.length}] `, tone: "accent" },
      { text: `${target.path}:${target.line}${wrapped ? " • wrapped" : ""}`, tone: "muted" },
      { text: ` — ${truncate(target.text.trim())}` },
    ]);
  };

  hunk.registerCommand({ id: "find", title: "検索(正規表現)", key: "/" }, async (ctx: any) => {
    const input = await ctx.prompts.line({ prefix: "/", placeholder: "search (regex)", initial: query ?? "" });
    if (input === null) return;
    if (input.trim().length === 0) {
      query = null;
      current = null;
      ctx.highlights.refresh(HIGHLIGHTER_ID);
      ctx.statusLine.clear(STATUS_ID);
      return;
    }
    query = input;
    current = null;
    go(ctx, 1, true);
  });
  hunk.registerCommand({ id: "next", title: "次のマッチへ移動", key: "n" }, (ctx: any) => go(ctx, 1, false));
  hunk.registerCommand({ id: "previous", title: "前のマッチへ移動", key: "N" }, (ctx: any) => go(ctx, -1, false));
}
