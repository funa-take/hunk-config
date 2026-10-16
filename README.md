# hunk-config

ターミナルの差分ビューア [hunk](https://hunk.dev/) の個人用設定と拡張です。
コードレビューで差分の外も含めて検索・移動できるようにするための、設定の一例として公開しています。

動作は保証しません。hunk の将来のバージョンでは、拡張が動かなくなる可能性があります。

## 拡張

`extensions/` の各ファイルが、hunk の拡張です。

| ファイル | キー | 内容 |
| --- | --- | --- |
| `linesearch.ts` | `/` `n` `N` | 正規表現でマッチを 1 件ずつ移動する検索。同じ行に複数あってもそれぞれに止まる。小文字だけの検索語は大文字・小文字を区別しない。マッチは反転で表示する |
| `fullcontext.ts` | `F` | 全文表示と差分のみの表示を切り替える。全文表示にすると、`/` の検索対象がファイル全体になる |
| `changenav.ts` | `]` `[` | 変更が連続している範囲の先頭行へ移動する |
| `copypath.ts` | `V` | 開始行と終了行で 2 回押すと、`パス:開始行~終了行` をクリップボードへコピーする |
| `edgenav.ts` | `Home` `End` `Ctrl+Home` `Ctrl+End` | 今の行の行頭 / 行末へ横スクロールする。ファイルの先頭 / 最後の行へ移動する |

## 前提

- `linesearch.ts` `changenav.ts` `edgenav.ts` は、ほかの準備なしで動きます。
- `fullcontext.ts` は、`shell/hunk.bash` の `hunk` 関数経由で hunk を起動する必要があります。関数が `diff.context` を書き換えるファイルを用意し、環境変数 `HUNK_CTX_FILE` で拡張に渡します。
- `copypath.ts` は、環境変数 `CLIP` に、標準入力のテキストをクリップボードへ渡すコマンドが設定されている必要があります。

## 配置

1. `extensions/*.ts` を `~/.config/hunk/extensions/` に置きます。
2. `config.toml` を `~/.config/hunk/config.toml` に置きます。すでに設定がある場合は、`[keybindings]` と `[custom_theme]` を必要な分だけ取り込んでください。
3. `shell/hunk.bash` を `.bashrc` から読み込みます。

   ```bash
   . /path/to/hunk-config/shell/hunk.bash
   ```

4. `CLIP` を設定します(例: `export CLIP='pbcopy'`)。

`config.toml` の `[keybindings]` は、拡張とセットです。標準の次 / 前の変更(`]` `[`)と検索(`/` `n` `N`)、先頭 / 末尾への移動(`Home` `End`)を外し、拡張に割り当てています。この設定がないと、標準のコマンドが優先されます。

## ライセンス

MIT
