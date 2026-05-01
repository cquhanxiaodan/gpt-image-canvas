# GPT Image Canvas

[English](README.md) | [简体中文](README.zh-CN.md)

基于 tldraw、Hono、SQLite 和 GPT Image 2 构建的本地专业 AI 画布。`v0.1.0` 新增腾讯云 COS 备份、PackyCode / `gpt-image` 返回格式兼容，并优化了生成资产相关体验。

## 效果图

![GPT Image Canvas 效果图](docs/assets/app-preview.png)

## 亮点

- 基于 tldraw 的 AI 画布，支持文生图和参考图生成。
- 生成图像和项目快照默认本地优先保存。
- 可选腾讯云 COS 备份，新生成图支持本地 + COS 双写。
- 生成历史支持定位、重跑、下载和云端上传状态提示。
- 支持 OpenAI 兼容图像端点，并兼容 PackyCode / `gpt-image` 风格响应。

## 环境要求

- Node.js 22 或更新版本。
- pnpm 9.14.2。包管理器版本已固定在 `package.json` 中；可以通过 `corepack prepare pnpm@9.14.2 --activate` 启用。
- Docker Desktop 或兼容的 Docker Engine，用于 Docker 工作流。
- 用于实时生成的 OpenAI API key，且需要具备 `gpt-image-2` 访问权限。没有凭证时应用仍可启动，但生成请求会返回运行时缺少 key 的错误。

## 快速开始

Windows PowerShell：

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

macOS/Linux：

```sh
pnpm install
cp .env.example .env
pnpm dev
```

实时生成前，请在应用内点击「API 设置」配置你自己的 API Key 和 Base URL。应用默认使用 `gpt-image-2` 模型；如需使用不同的兼容图像模型，可在 `.env` 中设置 `OPENAI_IMAGE_MODEL`。

打开 `http://localhost:5173` 使用 Web 应用。

## 升级到 v0.1.0

升级前建议备份本地运行数据：

Windows PowerShell：

```powershell
Copy-Item -Recurse data data-backup-before-v0.1.0
docker compose up --build
```

macOS/Linux：

```sh
cp -R data data-backup-before-v0.1.0
docker compose up --build
```

请确保 Web 应用和 API 一起重新构建。如果使用 Docker，建议直接访问 `http://localhost:8787`，并避免同时运行 `pnpm dev` 和 Docker 共用同一个 `data/` 目录。

## Codex 用户

Codex 可以直接在这个仓库中工作。克隆后，让 Codex 读取 `AGENTS.md`，再让它使用固定的包管理器安装依赖并运行检查：

```sh
pnpm install
pnpm typecheck
pnpm build
```

请不要把凭证写进提示词或日志。OpenAI API key 只应由用户在应用内的「API 设置」弹窗中配置，不要粘贴到 Codex 对话中。如果需要让 Codex 验证实时生成，请要求它使用已配置的用户 API Key，且不要打印凭证值。

如果涉及 UI 修改，让 Codex 运行 `pnpm dev`，并在浏览器中验证 Vite 应用 `http://localhost:5173`。本地临时文件应放在 `.codex-temp/` 下，该目录已被 Git 忽略。

## 开发流程

`pnpm dev` 会同时启动两个服务：

- API：Hono，默认地址为 `http://127.0.0.1:8787`。
- Web：Vite，默认地址为 `http://localhost:5173`，并将 `/api` 代理到 API 服务。开发服务会严格占用该端口，避免 `5173` 上的旧应用掩盖本项目启动失败。

使用右侧 AI 面板输入提示词、选择画面尺寸并生成图像。当画布中选中一张图片形状时，生成按钮会切换为参考图生成。画布编辑后会自动保存到本地 API，最近生成历史提供定位、重跑和下载已存储输出的操作。

AI 面板顶部也提供云存储按钮。需要将新生成图保存到 COS 时，可在弹窗中启用腾讯云 COS。

完成改动前请运行：

```sh
pnpm typecheck
pnpm build
```

## 脚本

- `pnpm dev` 启动全部 workspace 开发流程。
- `pnpm api:dev` 启动 API 开发流程。
- `pnpm web:dev` 启动 Web 开发流程。
- `pnpm typecheck` 检查 shared、web 和 API 的 TypeScript。
- `pnpm build` 构建 shared、web 和 API 包。
- `pnpm start` 启动构建后的 API 包。

## Docker

Docker Compose 会把共享契约、Web 应用和 API 构建到同一个镜像中。Hono API 会在同一个本地端口同时提供 `/api` 和构建后的 Web bundle，SQLite 数据和生成资产会持久化到宿主机 `./data`。

Windows PowerShell：

```powershell
Copy-Item .env.example .env
docker compose config --quiet --no-env-resolution
docker compose up --build
```

macOS/Linux：

```sh
cp .env.example .env
docker compose config --quiet --no-env-resolution
docker compose up --build
```

默认在 `http://localhost:8787` 打开应用。如需使用其他本地端口，请在启动 Docker Compose 前设置 `.env` 中的 `PORT`。

Docker Compose 还会默认设置 `SQLITE_JOURNAL_MODE=DELETE` 和 `SQLITE_LOCKING_MODE=EXCLUSIVE`。这样可以避开 Docker Desktop 绑定挂载 `./data` 目录时常见的 SQLite `SQLITE_IOERR_SHMOPEN` 错误，同时仍然把项目和生成资产保存在宿主机上。

Compose 构建支持与参考项目 `open-managed-flow` 相同的网络相关 build args：`NODE_IMAGE`、`NPM_CONFIG_REGISTRY`、`APT_MIRROR` 和 `APT_SECURITY_MIRROR`。Compose 中默认的 `NODE_IMAGE` 是 `node:23-bullseye-slim`，因为它满足应用的 `>=22` 运行时要求，并且在 Docker Hub 不可用时更常见于本地缓存。如需强制使用 Node 22 基础镜像，可以运行：

Windows PowerShell：

```powershell
$env:NODE_IMAGE = 'node:22-bookworm-slim'
docker compose up --build
```

macOS/Linux：

```sh
NODE_IMAGE=node:22-bookworm-slim docker compose up --build
```

`OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 已不再支持。用户必须在应用内的「API 设置」弹窗中自行配置 API Key 和 Base URL，否则生成请求会返回缺少配置的 JSON 错误。

## 腾讯云 COS 备份

生成图始终先保存到本地。用户在应用内云存储弹窗启用 COS 后，新生成图还会上传到：

```text
<key-prefix>/YYYY/MM/<assetId>.<ext>
```

COS 表单默认值来自 `.env`：

- `COS_DEFAULT_BUCKET`
- `COS_DEFAULT_REGION`
- `COS_DEFAULT_KEY_PREFIX`

保存 COS 配置前会执行一次测试上传和删除。由于当前应用没有服务端账号系统，`SecretKey` 会保存在本地 SQLite 数据库中，但读取配置接口只返回掩码状态，不会回显明文。

COS 上传失败不会导致生成失败。图片仍可从本地读取，生成历史中会显示云备份失败标记。

## 本地数据

运行时状态存储在 `DATA_DIR` 下，本地默认是 `./data`，Docker 中默认是 `/app/data`。该目录包含：

- `gpt-image-canvas.sqlite`：默认项目、生成历史、资产元数据、云端上传元数据和可选 COS 配置。
- `assets/`：生成的图像文件。

Docker Compose 会将宿主机 `./data` 绑定挂载到 `/app/data`，因此项目和生成资产会在容器重建后保留。不要提交 `.env`、`data/`、生成图像、SQLite 文件或构建输出。

## 安全与隐私说明

- 用户 API Key 和 Base URL 仅由应用内「API 设置」弹窗配置，并随每次生成请求传递给后端。后端不再从 `.env` 读取这些配置。
- 密钥不应出现在日志或聊天回复中。配置 COS 后，请将 `data/gpt-image-canvas.sqlite` 也视为敏感文件。
- 从 UI 保存的 COS SecretKey 会存储在本地 SQLite 中，并由设置接口掩码返回。配置 COS 后，请将 `data/gpt-image-canvas.sqlite` 也视为敏感文件。
- 提示词、项目状态、生成资产和 SQLite 数据都是 `DATA_DIR` 下的本地运行时数据。除非你有意导出特定资产，否则应将 `data/` 视为私有数据。
- 发布分支前，请检查 `git status --short`，确认只暂存了源代码、文档和预期 metadata。`.env`、`.ralph/`、`.codex-temp/`、`data/`、生成图像、SQLite 数据库和构建输出都应保持未跟踪。
- 如果真实 API key 曾被提交过，请先轮换该 key。Git ignore 规则只能防止之后泄露，不能从已有 Git 历史中移除密钥。

## 故障排查

- API Key 或 Base URL 缺失：请在应用内点击「API 设置」，配置你自己的 API Key 和 Base URL。不配置则无法生成图像。
- 缺少模型访问权限：确认配置的 API Key 可以访问当前配置的图像模型（默认 `gpt-image-2`）。如果兼容端点需要不同模型名，请联系 API Key 提供方确认支持的模型名。
- 高分辨率生成超时：默认上游请求超时为 20 分钟，可在 `.env` 中调大 `OPENAI_IMAGE_TIMEOUT_MS`。
- 端口已被占用：为 API/Docker 运行时设置 `.env` 中的 `PORT`；如果 Web 的 `5173` 被占用，请先关闭占用进程，或显式运行 `pnpm web:dev -- --port 5174` 并打开打印出来的地址。
- Docker 构建无法拉取 Node 基础镜像：在 macOS/Linux 可用 `NODE_IMAGE=node:23-bullseye-slim docker compose up --build` 使用本地缓存镜像；在 Windows PowerShell 可先运行 `$env:NODE_IMAGE = 'node:23-bullseye-slim'`，再运行 `docker compose up --build`；也可以恢复 Docker Hub 访问后重新运行 `docker compose up --build`。
- Docker config 默认会输出 `.env` 值。真实凭证存在时，请使用 `docker compose config --quiet --no-env-resolution` 做验证，不要分享展开后的 config 输出。
- Docker 中出现 SQLite `SQLITE_IOERR_SHMOPEN`：保留 Compose 默认的 `SQLITE_JOURNAL_MODE=DELETE` 和 `SQLITE_LOCKING_MODE=EXCLUSIVE`，重新构建，并确认没有本地 API 进程同时占用同一个 `data/` 数据库。
- SQLite `SQLITE_CORRUPT`：停止所有应用进程，备份 `data/`，再从备份恢复，或删除 SQLite 文件让应用创建新数据库。`data/assets/` 下的生成图片文件可以保留。
- `/api/project` 自动保存返回 400：查看 Docker 日志中的 `Project save rejected`。大画布快照支持到 100 MB；导入的 data URL 图片仍可能让快照变得很大。
- 本地状态过期或不需要：停止应用并删除 `data/` 下的文件。这会删除本地项目状态、历史记录和生成资产。

## 许可证

MIT

## 友情链接

- [LINUX DO - 新的理想型社区](https://linux.do/)
