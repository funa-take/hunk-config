import { spawnSync } from "node:child_process";
import type { HunkExtensionAPI } from "hunkdiff/extension";

// V: 開始行で V、終了行でもう一度 V を押すと、`パス:開始行~終了行`(同じ行なら `パス:行`)をクリップボードへコピーする。
// 拡張からは標準の範囲選択(v)で選んだ範囲を読めないため、2回の押下で範囲を指定する。
// コピーは環境変数 CLIP のコマンドに標準入力で渡す(~/.bashrc.common で定義)。
const NOTICE_MS = 3000;

type Start = { path: string; line: number };
let start: Start | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

type Row = { kind: " " | "-" | "+"; oldLine: number; newLine: number };

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

// 行番号は変更後(右側)の番号にそろえる。削除行にカーソルがあるときは、左右並びで同じ行に並ぶ追加行の番号を使う
// (同じかたまりの n 番目の削除行は n 番目の追加行)。対応する追加行がなければ、その位置に来る変更後の行を使う
function newSideLine(patch: string, side: "old" | "new", line: number): number {
  if (side === "new") return line;
  const rows = parseRows(patch);
  const index = rows.findIndex((row) => row.kind === "-" && row.oldLine === line);
  if (index < 0) return line;

  let first = index;
  while (first > 0 && rows[first - 1].kind === "-") first -= 1;
  let end = index;
  while (end < rows.length && rows[end].kind === "-") end += 1;
  const added: number[] = [];
  for (let r = end; r < rows.length && rows[r].kind === "+"; r += 1) added.push(rows[r].newLine);

  const paired = added[index - first];
  if (paired !== undefined) return paired;
  return added.length > 0 ? added[added.length - 1] + 1 : Math.max(rows[index].newLine, 1);
}

function showNotice(ctx: { statusLine: { set(item: any): void; clear(id: string): void } }, text: string) {
  clearTimeout(noticeTimer);
  ctx.statusLine.set({ id: "notice", spans: [{ text, tone: "accent" }] });
  noticeTimer = setTimeout(() => {
    try {
      ctx.statusLine.clear("notice");
    } catch {
      // 再読込などで文脈が失効していれば、アイテムごと消えている
    }
  }, NOTICE_MS);
}

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand({ id: "copy", title: "パスと行範囲をコピー(開始行と終了行で押す)", key: "V" }, (ctx) => {
    const { file, currentLine } = ctx.selection;
    if (!file || !currentLine) {
      ctx.notify("カーソル行がありません(行カーソルを表示してください)", "warning");
      return;
    }
    const line = newSideLine(file.patch, currentLine.side, currentLine.line);

    // 開始位置がない、または別のファイルなら、ここを開始位置にする
    if (!start || start.path !== file.path) {
      start = { path: file.path, line };
      showNotice(ctx, `開始: ${file.path}:${line}(終了行でもう一度 V)`);
      return;
    }

    const from = Math.min(start.line, line);
    const to = Math.max(start.line, line);
    start = null;
    const text = from === to ? `${file.path}:${from}` : `${file.path}:${from}~${to}`;

    const command = process.env.CLIP;
    if (!command) {
      ctx.notify("CLIP が未設定です(~/.bashrc.common を確認してください)", "warning");
      return;
    }
    const result = spawnSync("sh", ["-c", command], { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (result.status !== 0) {
      ctx.notify(`コピーに失敗しました: ${command}`, "warning");
      return;
    }
    showNotice(ctx, `コピー: ${text}`);
  });
}
