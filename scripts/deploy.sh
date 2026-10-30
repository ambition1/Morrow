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
  *) printf '用法：%s {https|proxy|local} {up|rollback|status|logs|stop|down|backup|auto-backup|backup-status|restore} [参数]\n' "$0"; exit 1 ;;
esac

# 备份期间的临时文件，失败后清理，避免误把半个备份当成完整文件。
BACKUP_TEMP=''
# 只有备份前正在运行的服务才会在退出时重新启动。
RESTART_AFTER_BACKUP=0
# 项目操作锁只由本次成功获得锁的进程释放。
DEPLOY_LOCK=''
# 解析后的项目名同时用于区分不同实例的备份文件。
DEPLOY_PROJECT=''
# 自动备份仅在完整备份和服务恢复均成功后发布成功状态。
AUTO_BACKUP_DIR=''
# 本次自动备份发布的文件路径。
AUTO_BACKUP_FILE=''
# 本次自动备份开始时间。
AUTO_BACKUP_STARTED=''


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
  if [[ -n "$AUTO_BACKUP_DIR" ]]; then
    # 状态文件使用原子替换，失败保留上次成功时间与文件。
    local status_file="$AUTO_BACKUP_DIR/${DEPLOY_PROJECT}-backup.status"
    # 只提取脚本写入的时间和文件名，不执行状态文件。
    local previous_success previous_archive status_temp
    previous_success=$(sed -n 's/^last_success=//p' "$status_file" 2>/dev/null || true)
    previous_archive=$(sed -n 's/^last_archive=//p' "$status_file" 2>/dev/null || true)
    if [[ "$result" == 0 ]]; then
      previous_success=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      previous_archive=$AUTO_BACKUP_FILE
    fi
    if status_temp=$(mktemp "$status_file.tmp.XXXXXX"); then
      if ! printf 'last_attempt=%s\nlast_result=%s\nlast_success=%s\nlast_archive=%s\n' \
        "$AUTO_BACKUP_STARTED" "$result" "$previous_success" "$previous_archive" > "$status_temp" ||
        ! mv -f -- "$status_temp" "$status_file"; then
        rm -f -- "$status_temp"
        printf '无法写入自动备份状态，请检查备份目录权限。\n' >&2
        result=1
      fi
    else
      printf '无法创建自动备份状态文件。\n' >&2
      result=1
    fi
    if [[ "$result" != 0 ]]; then printf '自动备份失败，最近成功记录未更新，请检查任务日志。\n' >&2; fi
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

# 自动备份目录必须显式指定且位于代码目录之外，避免发布清理时连同备份被删除。
prepare_backup_directory() {
  # 管理员提供的独立绝对目标目录，不从 .env 执行任何命令。
  local requested=${MORROW_BACKUP_DIR:-}
  if [[ "$requested" != /* || "$requested" == *$'\n'* ]]; then
    printf '请设置 MORROW_BACKUP_DIR 为独立备份目录的绝对路径。\n' >&2; exit 1
  fi
  umask 077
  mkdir -p -- "$requested"
  # 解析符号链接后的真实路径，不能用链接绕过代码目录限制。
  local resolved root_resolved
  resolved=$(CDPATH= cd -- "$requested" && pwd -P)
  root_resolved=$(CDPATH= cd -- "$DEPLOY_ROOT" && pwd -P)
  if [[ "$resolved" == "$root_resolved" || "$resolved" == "$root_resolved/"* || "$resolved" == / ]]; then
    printf '自动备份目录必须位于项目目录之外，且不能是文件系统根目录。\n' >&2; exit 1
  fi
  AUTO_BACKUP_DIR=$resolved
}

# 在项目部署锁内备份和清理，只清理本功能生成的本项目归档。
automatic_backup() {
  # 保留数量需要是有限正整数，防止误输入导致清空备份。
  local keep=${MORROW_BACKUP_KEEP:-14}
  if [[ ! "$keep" =~ ^[1-9][0-9]{0,3}$ ]]; then
    printf 'MORROW_BACKUP_KEEP 必须为 1 至 9999 的整数。\n' >&2; exit 1
  fi
  prepare_backup_directory
  AUTO_BACKUP_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # PID 避免同一秒内重复执行时覆盖，固定前缀区分人工归档。
  AUTO_BACKUP_FILE="$AUTO_BACKUP_DIR/${DEPLOY_PROJECT}-auto-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
  backup_data "$DEPLOY_MODE" backup "$AUTO_BACKUP_FILE"
  # 恢复服务成功后才允许清理旧备份，保留失败时原有恢复点。
  if [[ "$RESTART_AFTER_BACKUP" == 1 ]]; then
    "${COMPOSE_CMD[@]}" start morrow >/dev/null
    RESTART_AFTER_BACKUP=0
  fi
  # 只匹配严格时间戳与 PID 文件名，忽略其他项目、手动备份及符号链接。
  local archive count=1
  # 先确认扫描成功，再清理；进程替换会吞掉扫描失败的退出码。
  local archives
  archives=$(find "$AUTO_BACKUP_DIR" -maxdepth 1 -type f -name "${DEPLOY_PROJECT}-auto-*.tar.gz" \
    -exec basename {} \; | sed "s/^${DEPLOY_PROJECT}-auto-//" | LC_ALL=C sort -r)
  while IFS= read -r archive; do
    [[ "$archive" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+\.tar\.gz$ ]] || continue
    [[ "$AUTO_BACKUP_DIR/${DEPLOY_PROJECT}-auto-$archive" == "$AUTO_BACKUP_FILE" ]] && continue
    count=$((count + 1))
    if (( count > keep )); then
      rm -- "$AUTO_BACKUP_DIR/${DEPLOY_PROJECT}-auto-$archive"
    fi
  done <<< "$archives"
}

# 读取最近尝试和最近成功记录；没有成功记录时以非零退出供监控判断。
show_backup_status() {
  prepare_backup_directory
  # 本操作不修改部署锁，也不发布一次新的备份尝试记录。
  local directory=$AUTO_BACKUP_DIR
  AUTO_BACKUP_DIR=''
  # Docker 负责解析实际项目名，与所有变更操作使用同一命名规则。
  local project_name
  project_name=$("${COMPOSE_CMD[@]}" config --format yaml | sed -n 's/^name: //p')
  if [[ ! "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then exit 1; fi
  # 状态中不包含任何笔记内容，仅供运维读取。
  local status_file="$directory/${project_name}-backup.status"
  if [[ ! -f "$status_file" ]]; then printf '尚无自动备份记录。\n' >&2; return 1; fi
  cat -- "$status_file"
  if ! sed -n 's/^last_result=//p' "$status_file" | grep -qx 0; then return 1; fi
  if ! sed -n 's/^last_success=//p' "$status_file" | grep -q .; then return 1; fi
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
  up|rollback|stop|down|backup|auto-backup|restore) acquire_lock ;;
esac

case "$DEPLOY_ACTION" in
  rollback) "${COMPOSE_CMD[@]}" up -d --no-build --wait ;;
  up) "${COMPOSE_CMD[@]}" up -d --build --wait ;;
  status) "${COMPOSE_CMD[@]}" ps ;;
  logs) "${COMPOSE_CMD[@]}" logs --tail 100 -f ;;
  stop) "${COMPOSE_CMD[@]}" stop ;;
  down) "${COMPOSE_CMD[@]}" down ;;
  backup) backup_data "$@" ;;
  auto-backup) automatic_backup ;;
  backup-status) show_backup_status ;;
  restore) restore_data "$@" ;;
  *) printf '支持操作：up、rollback、status、logs、stop、down、backup [文件]、auto-backup、backup-status、restore 文件。\n'; exit 1 ;;
esac
