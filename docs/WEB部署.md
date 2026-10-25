# Morrow 远程 Web 部署

Web 版提供多人独立账号和独立笔记库。任意电脑通过 HTTPS 浏览器登录同一账号，即可访问该账号在服务器上的笔记。没有公开注册入口，管理员通过命令行创建账号。

## 使用 Docker Compose 部署

在服务器安装 Docker 和 Compose，将项目放入服务器目录后运行：

```sh
docker compose up -d --build
```

服务默认发布在服务器的 `127.0.0.1:3000`。在前方配置 HTTPS 反向代理，客户端通过域名访问。不要直接将容器端口暴露到公网。

创建账号（用户名为 3–48 位英文字母、数字、下划线或连字符，密码为 12–256 个字符）：

```sh
read -s MORROW_USER_PASSWORD
export MORROW_USER_PASSWORD
docker compose exec -e MORROW_USER_PASSWORD morrow node server/index.mjs create-user alice
unset MORROW_USER_PASSWORD
```

再执行一次并更换用户名即可创建其他账号。密码保存在带随机盐值的 scrypt 摘要中。账号不会因容器重建而丢失。

以下为 Nginx 的代理配置片段，放入已有证书配置的 HTTPS `server` 中。将域名替换为你的实际域名，证书由服务器的证书管理工具配置：

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

HTTP 入口应重定向至 HTTPS。认证 Cookie 默认带 `Secure`、`HttpOnly` 和 `SameSite=Strict`，正式部署必须使用 HTTPS。站点部署在域名根路径；目前没有子路径配置。

## 不使用 Docker

需要 Node.js 24 或更新版本，以及安装前端依赖所需的 npm。

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:web
MORROW_DATA_DIR=/srv/morrow/data npm run start:web
```

请使用 systemd 等进程管理器运行服务，并让服务账号对数据目录拥有读写权限。默认监听 `127.0.0.1:3000`，仍需要 HTTPS 反向代理。

创建账号时必须使用与服务相同的数据目录：

```sh
read -s MORROW_USER_PASSWORD
export MORROW_USER_PASSWORD
MORROW_DATA_DIR=/srv/morrow/data npm run user:create -- alice
unset MORROW_USER_PASSWORD
```

## 本机开发与验收

首次构建、创建测试账号后启动本机 HTTP 服务：

```sh
npm run build:web
# 先按照上一节方式创建账号，省略 MORROW_DATA_DIR 时默认为项目 data/。
MORROW_INSECURE_HTTP=1 npm run start:web
```

打开 `http://localhost:3000`。本机 HTTP 调试才使用 `MORROW_INSECURE_HTTP=1`。如需前端热更新，在另一个终端运行 `npm run dev:web`，Vite 会把 `/api` 转发至 3000 端口。

`npm run preview:web` 只能预览静态文件，不包含认证与存储 API，实际使用请运行 `start:web`。

验证命令：

```sh
npm run typecheck
npm run lint
npm test
npm run test:web
npm run build:web
```

## 存储与备份

- `MORROW_DATA_DIR/accounts/<用户名>.json`：账号摘要，服务端专用，不能作为静态文件发布。
- `MORROW_DATA_DIR/vaults/<用户名>/`：该账号的 Markdown 页面、画布、附件和 `.morrow` 历史等元数据。
- Docker 使用 `morrow-data` 数据卷；更新时使用 `docker compose up -d --build`，不要使用 `down -v`，后者会删除数据卷。
- 备份整个数据目录或数据卷（建议暂停服务后制作一致快照）；恢复后重启服务。每位用户也可在设置中导出备份或 Markdown。
- 会话保留七天，服务重启后所有用户需要重新登录。设置中的“退出登录”会先保存更改，保存失败时不会强制退出。
- 目前支持单个服务实例；账号版本与会话保存在服务进程中，不支持多个副本同时写入同一数据目录。不要从外部直接修改正在使用的服务器笔记库。

## 多设备行为

同一账号的不同设备共享磁盘数据，但不提供实时协同编辑。其他设备保存后，当前页面会提示刷新；旧客户端的写入会被版本检查拒绝。请先复制未保存内容，或在设置中导出备份，再刷新读取最新版本。账号切换后，旧标签页的文件请求也会被工作区身份检查拒绝。

每个账号可访问的路径只来自其会话身份，客户端不能指定他人的笔记库。路径穿越和符号链接访问均被拒绝。上传附件通过认证接口读取为 Blob，不能直接作为本站 HTML 执行。

## 中文与字体

新安装默认简体中文，可在设置 → 通用中切换语言。空笔记库第一次打开会生成中文功能指南。不会替换已有笔记的正文或标题。

字体默认使用浏览器所在设备的系统字体。设置 → 外观可分别填写界面字体和正文字体的本机名称。填写一个字体名即可；字体未安装时回退为系统字体，留空恢复默认。字体设置按浏览器保存，不会把字体文件上传到服务器。

原生文件夹、局域网配对同步、云文件夹检测、系统快捷捕获、AI 助手、MCP、PDF 导出和自动更新仍由桌面版提供。Web 版支持页面编辑、数据库、画布、附件、历史、模板、复习以及备份和 Markdown 导入导出。
