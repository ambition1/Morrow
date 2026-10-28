#!/usr/bin/env bash
# 功能：统一管理 家庭共享 Compose 启停、一致性备份和空卷恢复。
# 作者：xuanli
# 创建时间：2026-10-27 01:22:49
set -euo pipefail

# 项目根目录使脚本可以从任意工作目录执行。
DEPLOY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# 部署模式分别对应已有代理、本机 HTTP、内置 HTTPS 网关。
DEPLOY_MODE=${1:-help}
# 当前管理操作。
DEPLOY_ACTION=${2:-help}
# 固定 Compose 参数交给 Docker 解析 .env，不把环境文件当作 Shell 执行。
COMPOSE_CMD=(docker compose --project-directory "$DEPLOY_ROOT" -f "$DEPLOY_ROOT/compose.yaml")
# 显式选取项目环境文件，避免从其他工作目录执行时误读那里的 .env。
if [[ -f "$DEPLOY_ROOT/.env" ]]; then
  COMPOSE_CMD+=(--env-file "$DEPLOY_ROOT/.env")
else
  COMPOSE_CMD+=(--env-file /dev/null)
fi
case "$DEPLOY_MODE" in
  proxy|local) ;;
  https) COMPOSE_CMD+=(-f "$DEPLOY_ROOT/compose.https.yaml") ;;
  *) printf '用法：%s {https|proxy|local} {up|rollback|status|logs|stop|down|backup|restore} [参数]\n' "$0"; exit 1 ;;
esac

# 备份期间的临时文件，失败后清理，避免误把半个备份当成完整文件。
BACKUP_TEMP=''
# 只有备份前正在运行的服务才会在退出时重新启动。
RESTART_AFTER_BACKUP=0
# 项目操作锁只由本次成功获得锁的进程释放。
DEPLOY_LOCK=''
# 解析后的项目名同时用于区分不同实例的备份文件。
DEPLOY_PROJECT=''

# 保留原退出码，清理临时备份并恢复服务原先的运行状态。
cleanup_deployment() {
  # 保存失败时不能被清理操作的退出码覆盖。
  local result=$?
  trap - EXIT INT TERM
  if [[ -n "$BACKUP_TEMP" ]]; then rm -f -- "$BACKUP_TEMP"; fi
  if [[ "$RESTART_AFTER_BACKUP" == 1 ]]; then
    if ! "${COMPOSE_CMD[@]}" start morrow >/dev/null; then
      printf '备份后未能重新启动服务，请检查 docker compose 日志。\n' >&2
      result=1
    fi
  fi
  if [[ -n "$DEPLOY_LOCK" ]]; then
    rm -f -- "$DEPLOY_LOCK/owner"
    rmdir -- "$DEPLOY_LOCK"
  fi
  exit "$result"
}

# 按 Compose 实际项目名串行化所有修改操作，避免重叠备份中途恢复写入。
acquire_lock() {
  # Docker 解析 .env 后返回项目名，无需执行环境文件内容。
  local project_name
  project_name=$("${COMPOSE_CMD[@]}" config --format yaml | sed -n 's/^name: //p')
  if [[ ! "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    printf '无法确定安全的 Compose 项目名。\n' >&2; exit 1
  fi
  # 创建目录本身是原子的，不自动夺取无法确认状态的旧锁。
  local candidate="$DEPLOY_ROOT/.deploy-locks/$project_name"
  umask 077
  mkdir -p -- "$DEPLOY_ROOT/.deploy-locks"
  if ! mkdir -- "$candidate" 2>/dev/null; then
    printf '此项目已有部署或备份操作进行中：%s\n' "$candidate" >&2; exit 1
  fi
  DEPLOY_PROJECT="$project_name"
  DEPLOY_LOCK="$candidate"
  trap cleanup_deployment EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '%s\n' "$$" > "$DEPLOY_LOCK/owner"
}

# 暂停写入后备份完整数据目录和共享笔记库，退出时恢复原有服务状态。
backup_data() {
  # 允许指定备份位置，默认文件名使用 UTC 时间以便跨服务器排序。
  local output=${3:-"$DEPLOY_ROOT/backups/${DEPLOY_PROJECT}-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"}
  if [[ -e "$output" ]]; then printf '备份文件已存在，不会覆盖：%s\n' "$output" >&2; exit 1; fi
  if [[ -z "$("${COMPOSE_CMD[@]}" ps -a -q morrow)" ]]; then
    printf '未找到此项目的 Morrow 容器，请先确认项目名与部署模式。\n' >&2; exit 1
  fi
  umask 077
  mkdir -p -- "$(dirname -- "$output")"
  BACKUP_TEMP=$(mktemp "${output}.tmp.XXXXXX")
  if [[ -n "$("${COMPOSE_CMD[@]}" ps --status running -q morrow)" ]]; then
    RESTART_AFTER_BACKUP=1
    "${COMPOSE_CMD[@]}" stop morrow
  fi
  "${COMPOSE_CMD[@]}" run --rm --no-deps -T --entrypoint tar morrow -C /app/data -czf - . > "$BACKUP_TEMP"
  gzip -t "$BACKUP_TEMP"
  # 原子发布且不覆盖同名文件，即使其他项目同时选择了同一目标。
  ln -- "$BACKUP_TEMP" "$output"
  rm -f -- "$BACKUP_TEMP"
  BACKUP_TEMP=''
  printf '备份已保存：%s\n' "$output"
}

# 只向全新的空数据卷恢复，既有笔记不会被覆盖或删除。
restore_data() {
  # 只接受管理员自己通过本脚本生成的完整数据备份。
  local archive=${3:?请提供可信的 tar.gz 备份文件}
  if [[ ! -f "$archive" ]]; then printf '备份文件不存在。\n' >&2; exit 1; fi
  gzip -t "$archive"
  if [[ -n "$("${COMPOSE_CMD[@]}" ps --status running -q morrow)" ]]; then
    printf '恢复目标服务仍在运行，请使用新的 COMPOSE_PROJECT_NAME 恢复。\n' >&2; exit 1
  fi
  if ! "${COMPOSE_CMD[@]}" run --rm --no-deps -T --entrypoint node morrow \
    -e "if (require('node:fs').readdirSync('/app/data').length) process.exit(1)"; then
    printf '目标数据卷不是空卷，已拒绝恢复；请使用新的 COMPOSE_PROJECT_NAME。\n' >&2; exit 1
  fi
  "${COMPOSE_CMD[@]}" run --rm --no-deps -T --entrypoint tar morrow \
    -C /app/data --no-same-owner --keep-old-files -xzf - < "$archive"
  printf '数据已恢复到新数据卷。请启动服务并验证共享笔记。\n'
}

case "$DEPLOY_ACTION" in
  up|rollback|stop|down|backup|restore) acquire_lock ;;
esac

case "$DEPLOY_ACTION" in
  rollback) "${COMPOSE_CMD[@]}" up -d --no-build --wait ;;
  up) "${COMPOSE_CMD[@]}" up -d --build --wait ;;
  status) "${COMPOSE_CMD[@]}" ps ;;
  logs) "${COMPOSE_CMD[@]}" logs --tail 100 -f ;;
  stop) "${COMPOSE_CMD[@]}" stop ;;
  down) "${COMPOSE_CMD[@]}" down ;;
  backup) backup_data "$@" ;;
  restore) restore_data "$@" ;;
  *) printf '支持操作：up、rollback、status、logs、stop、down、backup [文件]、restore 文件。\n'; exit 1 ;;
esac
