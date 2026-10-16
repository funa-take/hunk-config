# hunk: 起動のたびに一時フォルダへ gitconfig を作り、GIT_CONFIG_GLOBAL に指定して起動する。
# 拡張 fullcontext(F キー)が HUNK_CTX_FILE に diff.context を書き込むことで、全文表示と差分のみを切り替える。
# 設定が効くのはこの hunk プロセスだけで、ほかの git diff には影響しない
hunk() {
  local tmp rc
  tmp=$(mktemp -d) || return
  : > "${tmp}/ctx.conf"
  printf '[include]\n\tpath = %s/.gitconfig\n\tpath = %s/.config/git/config\n\tpath = %s/ctx.conf\n' \
    "${HOME}" "${HOME}" "${tmp}" > "${tmp}/gitconfig"
  GIT_CONFIG_GLOBAL="${tmp}/gitconfig" HUNK_CTX_FILE="${tmp}/ctx.conf" command hunk "$@"
  rc=$?
  rm -rf "${tmp}"
  return "${rc}"
}
