# Morrow Docker Compose 部署

浏览器直接打开服务器笔记库，无需登录或创建用户。页面、附件、画布和历史记录继续保存在原有数据卷中。能够访问服务地址的人均可查看和编辑。

## 文件与部署模式

| 文件                 | 用途                                                         |
| -------------------- | ------------------------------------------------------------ |
| `compose.yaml`       | 应用、健康检查、数据卷、日志和运行限制；只发布服务器回环端口 |
| `compose.https.yaml` | 增加 Caddy 自动 HTTPS、80/443 入口和证书持久化               |
| `.env.example`       | 域名、端口、镜像标签和资源限制的配置示例                     |
| `deploy/Caddyfile`   | HTTPS 代理，保留 Host 和 105 MiB 请求体限制                  |
| `scripts/deploy.sh`  | 启停、一致性备份、空卷恢复                                   |

脚本的三个模式：`https`（推荐正式部署）、`proxy`（已有 HTTPS 反向代理）、`local`（本机 HTTP）。`local` 和 `proxy` 使用基础配置，`https` 额外加载网关配置。

## 方案一：自带 HTTPS（推荐）

### 1. 准备服务器

需要 Docker Engine、Compose v2 或更新版本、Bash、tar 和 gzip。建议至少 2 GB 内存；构建与笔记库扫描会额外使用内存。应用默认容器内存上限为 1 GB，可在 `.env` 调整。

准备一个独立域名，例如 `notes.example.com`，将 A 记录指向服务器；如果配置 AAAA，也必须正确指向服务器的 IPv6。放行 TCP 80、443；UDP 443 可用于 HTTP/3。公网不需要开放应用端口 3000。

Caddy 会申请和续期证书，并将 HTTP 重定向到 HTTPS。域名解析、80/443 可达以及证书数据卷持久化是必要条件，详见 [Caddy 自动 HTTPS 文档](https://caddyserver.com/docs/automatic-https)。

### 2. 获取项目并配置

```sh
git clone --branch codex/chinese-font-multiuser-web https://github.com/ambition1/Morrow.git
cd Morrow
# 首次部署执行；已有 .env 时直接编辑，避免覆盖原配置。
cp .env.example .env
```

编辑 `.env`，至少修改：

```dotenv
COMPOSE_PROJECT_NAME=morrow
MORROW_IMAGE_TAG=initial
MORROW_DOMAIN=notes.example.com
ACME_EMAIL=admin@example.com
```

域名只填写主机名，不添加 `https://`、路径或端口。正式部署保持 Caddy 的默认对外端口 80/443。`.env` 不需要账号密码，也不会提交到 Git 或打进镜像。

`COMPOSE_PROJECT_NAME` 决定数据卷前缀。已有部署不要随意改名，否则会连接到另一组空卷。升级旧版本时保持原项目名，可继续使用原来的 `morrow-data` 卷。

### 3. 启动

```sh
./scripts/deploy.sh https up
./scripts/deploy.sh https status
```

启动命令会构建镜像并等待服务健康。打开 `https://notes.example.com` 即可访问，不需要创建账号。

不用脚本时，对应启动命令是：

```sh
docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
```

应用健康后才会启动网关。该顺序使用 Compose 的 `service_healthy` 条件，参见 [Docker 官方说明](https://docs.docker.com/compose/how-tos/startup-order/)。

## 方案二：已有 Nginx、宝塔或其他 HTTPS 代理

不启动内置网关：

```sh
./scripts/deploy.sh proxy up
```

应用默认监听服务器的 `127.0.0.1:3000`。现有 HTTPS 站点反向代理到该地址；若端口被占用，在 `.env` 修改 `MORROW_HTTP_PORT`。

Nginx 的 HTTPS `server` 配置片段：

```nginx
server_name notes.example.com;
client_max_body_size 105m;
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

HTTP 站点需重定向到 HTTPS。必须保留浏览器原始 Host（包括非默认端口），否则保存可能因跨站检查返回 403。应用部署在域名根路径，不支持子路径。

## 本机 HTTP 调试

```sh
# 端口被占用时，先在 .env 设置 MORROW_HTTP_PORT=3189。
./scripts/deploy.sh local up
```

打开 `http://localhost:3000`（或配置的端口）。不需要 Cookie 配置。基础配置的应用端口绑定回环地址，不会把本机调试入口暴露到局域网或公网。

本机已有 Node 服务与容器是两个独立实例。不要让两者同时操作同一个笔记库目录。

## 数据实际存放在哪里

应用数据挂载在容器的 `/app/data`：

```text
/app/data/
├── accounts/                 # 旧文件保留，不再读取或校验
└── vaults/
    └── local/                # 继续使用原有服务器笔记库，不迁移路径
        ├── 页面.md
        ├── attachments/
        ├── .morrow/          # 注册信息、历史、样式等
        └── .trash/
```

Docker 卷默认名为 `morrow_morrow-data`；前面的 `morrow` 来自项目名。查看实际卷名与挂载位置：

```sh
docker compose ps
docker inspect "$(docker compose ps -q morrow)" --format '{{json .Mounts}}'
docker volume inspect morrow_morrow-data
```

Docker Desktop/OrbStack 的卷通常位于虚拟机内，不能当作项目下的普通文件夹使用。容器重建、停止和普通 `down` 都保留数据卷。不要执行 `down -v` 或手动删除这些卷来更新应用。

HTTPS 模式另有 `caddy-data` 和 `caddy-config` 卷，分别保存证书状态与网关配置状态；也应保留。应用数据备份脚本只备份 `morrow-data`。服务器级备份可额外快照网关卷。

## 备份

```sh
./scripts/deploy.sh https backup
# 或指定目标文件；不会覆盖已有文件。
./scripts/deploy.sh https backup /srv/backups/morrow-before-update.tar.gz
```

备份包含完整数据目录、笔记、附件、历史、回收站和自定义样式。脚本会先优雅停止应用以保证一致性；备份前正在运行才会在结束后自动启动。遇到打包失败也会尝试恢复原先运行状态，并移除不完整的临时文件。

备份期间网关可能短暂返回 502。备份放在项目 `backups/` 或指定目录，权限限制为当前用户可读写。请复制到独立存储，避免服务器故障时连同数据卷一起丢失。

需要迁移窗口保持停止时，先执行 `stop` 再执行 `backup`，脚本不会重新启动已经停止的实例：

```sh
./scripts/deploy.sh https stop
./scripts/deploy.sh https backup /srv/backups/morrow-migration.tar.gz
```

## 恢复与迁移

恢复脚本只允许**没有运行应用、且数据卷为空**的目标。不会清空或覆盖原有卷。只恢复管理员自己生成的可信 tar.gz；界面导出的 JSON 备份仍应通过界面“恢复备份”导入。

例如恢复到一个新项目：

```sh
COMPOSE_PROJECT_NAME=morrow-restored ./scripts/deploy.sh https restore /srv/backups/morrow-migration.tar.gz
```

此时数据位于 `morrow-restored_morrow-data`，还没有启动正式服务。可以先在回环测试端口验证：

```sh
COMPOSE_PROJECT_NAME=morrow-restored MORROW_HTTP_PORT=3100 ./scripts/deploy.sh local up
# 仅从服务器本机或 SSH 端口转发访问 http://localhost:3100，验证笔记。
COMPOSE_PROJECT_NAME=morrow-restored MORROW_HTTP_PORT=3100 ./scripts/deploy.sh local down
```

正式切换时，先 `down` 原 HTTPS 项目（不加 `-v`），将 `.env` 中的项目名改成 `morrow-restored`，再执行 `./scripts/deploy.sh https up`。原卷仍保留，确认恢复完整后再自行决定清理。此处改名是一次明确的数据迁移，不是普通升级操作。

迁移到另一台服务器时，复制代码、`.env` 和备份文件，在空目标卷执行相同恢复流程，然后更新 DNS。避免迁移期间两台服务器同时接收编辑。

### 将当前本机 `data/` 迁移进 Docker

容器不会自动读取项目现有的 `data/`。先停止直接运行的 Node 服务，在项目目录执行：

```sh
mkdir -p backups
# 备份应在停止写入后生成，目录内应完整保留 vaults/ 及其他现有文件。
tar -C data -czf backups/from-local.tar.gz .
COMPOSE_PROJECT_NAME=morrow-imported ./scripts/deploy.sh https restore backups/from-local.tar.gz
```

验证后将 `.env` 项目名切换为 `morrow-imported` 并启动。直接打开即可，不需要登录；现有笔记库路径保持不变。

## 更新与回滚

更新前备份，记录当前 Git 提交和 `.env` 的镜像标签。为每次发布使用不同的 `MORROW_IMAGE_TAG`，保留旧镜像。

```sh
./scripts/deploy.sh https backup
# 获取并检查目标提交后再切换；不要覆盖服务器上未提交的配置修改。
git fetch origin
git switch codex/chinese-font-multiuser-web
git pull --ff-only
# 编辑 .env，为 MORROW_IMAGE_TAG 设置一个新的标签。
./scripts/deploy.sh https up
./scripts/deploy.sh https status
```

应用重启后刷新页面即可继续使用。更新不会删除笔记，也不移动现有存储目录。

回滚到已保留的镜像时，在 `.env` 恢复旧标签，**不要重新构建**：

```sh
./scripts/deploy.sh https rollback
```

回滚镜像必须兼容对应版本的 Compose 健康检查配置；跨部署配置版本回滚时，应一起使用旧提交中的配置和脚本。

若更新包含数据格式迁移，需使用升级前的数据备份恢复到新卷，并按恢复流程切换，不能假定旧代码支持新版数据。

## 操作互斥

`up`、`rollback`、`stop`、`down`、`backup`、`restore` 按 Compose 实际项目名互斥；服务恢复完成后才释放锁。请从同一份代码目录统一使用脚本管理，不要让定时任务、人工操作和另一份代码副本绕过脚本同时修改同一实例。

锁位于 `.deploy-locks/<项目名>/`，记录发起操作的进程 PID。正常退出、失败和常规终止信号均会清理锁。机器断电或强制杀进程可能留下锁；不要直接重试覆盖。先确认记录的进程及该项目的临时备份/恢复容器都已退出，再手动清理残留锁目录。`status` 和 `logs` 不阻塞修改操作。

## 运维和故障排查

```sh
./scripts/deploy.sh https status
./scripts/deploy.sh https logs
# 单独查看应用或证书日志：
docker compose -f compose.yaml -f compose.https.yaml logs --tail 100 morrow caddy
# 不涉及任何笔记内容的健康接口：
curl -f https://notes.example.com/api/health
```

| 现象                 | 检查                                                            |
| -------------------- | --------------------------------------------------------------- |
| 证书申请失败         | 域名 A/AAAA、TCP 80/443、防火墙、其他进程端口占用及 Caddy 日志  |
| 保存返回 403         | 代理是否保留原始 Host，是否跨域或放在子路径下                   |
| 页面显示空笔记库     | Compose 项目名、挂载的数据卷是否与原部署一致                    |
| 应用 unhealthy       | `/api/health`、构建文件是否存在、数据卷权限、内存限制及应用日志 |
| 保存提示其他设备更新 | 先保留未保存内容再刷新；当前不提供实时协同编辑                  |
| 恢复被拒绝           | 目标应用仍在运行或卷已非空；换新项目名恢复，不删除原数据        |

健康检查会验证静态入口可读及数据目录可写，返回内容只有 `{"ok":true}`。Compose 的健康状态用于启动等待和诊断，**unhealthy 本身不会自动重启仍在运行的进程**；异常退出由 `unless-stopped` 重启。

应用以非 root 用户运行，根文件系统只读，只有数据卷和临时目录可写；日志按 10 MB × 3 轮转。`stop_grace_period` 给保存请求留出结束时间。这里只支持一个应用实例写入同一卷，不能横向扩容或同时让外部程序编辑服务器笔记。

## 非容器开发

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:web
PORT=3188 npm run start:web
```

直接运行时默认使用项目 `data/`，可通过 `MORROW_DATA_DIR` 修改。`dev:web` 的 API 默认代理到 3000；`preview:web` 只有静态预览，不包含文件 API。

## 已完成的本地部署验收

已在独立 Compose 项目和数据卷中验证，未操作开发中的笔记库：

- 三种 Compose 配置可解析；应用非 root、只读根文件系统下健康启动、建号与读写正常。
- 中文页面和附件在容器强制重建后保留。
- 运行实例可一致性备份，并在结束后重启；原先停止的实例不会被意外启动。
- 备份恢复至新项目的空卷后，原页面与附件可正常读取；非空卷恢复被拒绝。
- 占用项目锁时修改操作被拒绝；故障注入导致打包失败时，临时文件和锁被清理，原服务重新启动。
- Caddy 使用本地 CA 的 TLS 证书通过信任链校验；附件与中文读写正常，HTTP 返回 308，错误 Origin 返回 403。

本地 CA 验证不等于公网证书签发验收。真实域名的 DNS、80/443 可达性和 ACME 申请，需要在目标服务器完成配置后检查。
