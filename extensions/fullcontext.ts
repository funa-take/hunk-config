import { readFileSync, writeFileSync } from "node:fs";
import type { HunkExtensionAPI } from "hunkdiff/extension";

// F: 全文表示(diff.context = 99999)と差分のみの表示を切り替える。
// hunk は内部で git diff を実行するため、~/.bashrc.common の hunk 関数が起動時に用意した gitconfig に
// HUNK_CTX_FILE を include させておき、このファイルの中身を書き換えて hunk を再読込させる。
const FULL_CONTEXT = "[diff]\n\tcontext = 99999\n";
// 再読込するとカーソルがファイルの先頭に戻るため、切り替え前の位置を覚えて戻す
const RESTORE_DELAY_MS = 300;
// 切り替え後のモードをステータス行に出しておく時間
const MODE_NOTICE_MS = 3000;

type Position = { path: string; side: "old" | "new"; line: number };
let pending: Position | null = null;
// 再読込のあとに表示するモード。F を押した時点で決める(true: 全文表示)
let pendingMode: boolean | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

// 再読込で古い文脈は失効するため、再読込後の文脈で表示して一定時間後に消す
function showMode(ctx: { statusLine: { set(item: any): void; clear(id: string): void } }, full: boolean) {
  clearTimeout(noticeTimer);
  ctx.statusLine.set({
    id: "mode",
    spans: [{ text: full ? "[全文]" : "[差分]", tone: full ? "accent" : "muted" }],
  });
  noticeTimer = setTimeout(() => ctx.statusLine.clear("mode"), MODE_NOTICE_MS);
}

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand(
    { id: "toggle", title: "全文表示と差分のみを切り替え", key: "F" },
    (ctx) => {
      const ctxFile = process.env.HUNK_CTX_FILE;
      if (!ctxFile) {
        ctx.notify("HUNK_CTX_FILE が未設定です(hunk 関数経由で起動してください)", "warning");
        return;
      }

      const { file, currentLine } = ctx.selection;
      pending = file && currentLine ? { path: file.path, ...currentLine } : null;

      const isFull = readFileSync(ctxFile, "utf8").trim() !== "";
      writeFileSync(ctxFile, isFull ? "" : FULL_CONTEXT);
      pendingMode = !isFull;
      // 再読込の要求は、コマンドの文脈にはなく、イベントの文脈にだけある
      hunk.events.emit("fullcontext:reload", {});
    },
  );

  hunk.events.on("fullcontext:reload", async (_payload, ctx) => {
    const result = await ctx.review.requestReload();
    if (!result.ok) {
      pending = null;
      pendingMode = null;
      ctx.notify(`再読込に失敗しました: ${result.detail}`, "warning");
    }
  });

  hunk.on("session_reload", ({ changeset, reason }, ctx) => {
    if (reason !== "extension") return;

    if (pendingMode !== null) {
      showMode(ctx, pendingMode);
      pendingMode = null;
    }
    if (!pending) return;
    const target = pending;
    pending = null;

    const file = changeset.files.find((candidate) => candidate.path === target.path);
    if (!file) return;

    // 全文表示から差分のみへ戻すと、元の行が畳まれて見えなくなる。その場合は最も近い変更のかたまりを選ぶ
    const spans = (file.hunks ?? []).map((h) => ({
      index: h.index,
      range: target.side === "old" ? h.oldRange : h.newRange,
    }));
    const visible = spans.some(({ range }) => range && range[0] <= target.line && target.line <= range[1]);
    const nearest = spans
      .filter((s): s is { index: number; range: [number, number] } => Boolean(s.range))
      .map((s) => ({ index: s.index, distance: Math.min(Math.abs(target.line - s.range[0]), Math.abs(target.line - s.range[1])) }))
      .sort((a, b) => a.distance - b.distance)[0];

    setTimeout(() => {
      if (visible) ctx.navigation.revealLine(file.id, target.side, target.line);
      else if (nearest) ctx.navigation.selectHunk(file.id, nearest.index);
      else ctx.navigation.selectFile(file.id);
    }, RESTORE_DELAY_MS);
  });
}
