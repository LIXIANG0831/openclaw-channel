# WebSocket Channel Demo

基于 WebSocket 的前后端通信演示项目，支持 OpenClaw 插件集成。

## 项目架构

```
openclaw-demo-master/
├── websocket-service/     # Python 后端 WebSocket 服务
├── websocket-web/         # Vue.js 前端
└── websocket-channel/     # OpenClaw 插件
```

## 模块说明

### 1. WebSocket Service (后端)

Python 实现的 WebSocket 服务器，作为消息转发中枢。

- **技术栈**: Python 3.x + websockets + python-dotenv
- **端口**: 8765
- **功能**:
  - 接收前端消息并转发给 OpenClaw 插件
  - 接收 OpenClaw 插件回复并转发给前端

### 2. WebSocket Web (前端)

Vue.js 实现的前端聊天界面。

- **技术栈**: Vue 3 + Vite
- **端口**: 3000
- **功能**:
  - WebSocket 客户端
  - 实时聊天界面

### 3. OpenClaw Plugin (插件)

OpenClaw 框架的 WebSocket 通道插件。

- **功能**:
  - 接收前端消息
  - AI 自动回复
  - 消息转发

## 快速开始

### 前置要求

- Python 3.11+
- Node.js 18+
- pnpm (推荐)

### 1. 启动后端服务

```bash
cd websocket-service

# 创建并激活虚拟环境 (可选)
python -m venv .venv
source .venv/bin/activate  # Linux/Mac
# 或 .venv\Scripts\activate  # Windows

# 安装依赖
pip install websockets python-dotenv

# 复制并编辑配置文件
cp .env.example .env

# 启动服务
python app.py
```

### 2. 启动前端

```bash
cd websocket-web

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

前端将在 http://localhost:3000 启动。

### 3. 配置 OpenClaw 插件

将 `websocket-channel` 目录复制到 OpenClaw 的插件目录，并配置 `wsUrl`。

## 配置说明

### 后端配置

文件: `websocket-service/.env`

```bash
# 监听地址
WS_HOST=localhost

# 监听端口
WS_PORT=8765

# 调试模式 (true/false)
DEBUG=true
```

| 字段 | 环境变量 | 说明 | 默认值 |
|------|----------|------|--------|
| host | WS_HOST | 监听地址 | localhost |
| port | WS_PORT | 监听端口 | 8765 |
| debug | DEBUG | 调试模式 | true |

也可以直接通过环境变量启动：

```bash
WS_HOST=0.0.0.0 WS_PORT=8765 python app.py
```

### 前端配置

文件: `websocket-web/.env.local`

```
VITE_WS_URL=ws://localhost:8765/
```

### OpenClaw 插件配置

文件: `websocket-channel/openclaw.config.json`

```json
{
  "channels": {
    "websocket-channel": {
      "enabled": true,
      "config": {
        "enabled": true,
        "wsUrl": "ws://localhost:8765/openclaw",
        "groupPolicy": "open"
      }
    }
  }
}
```

## WebSocket 连接路径约定

| 客户端 | 连接路径 | 说明 |
|--------|----------|------|
| 前端 | `/` | Vue 客户端 |
| OpenClaw | `/openclaw` | 插件客户端 |

## 消息流程

```
┌─────────────┐     ws://     ┌─────────────┐    ws://     ┌─────────────┐
│  Vue 前端   │ ─────────────►│  Python     │ ───────────►│  OpenClaw   │
│  :3000      │◄───────────── │  Service    │◄────────────│  Plugin     │
└─────────────┘   :8765      └─────────────┘   :8765      └─────────────┘
```

1. 用户在前端发送消息
2. 消息通过 WebSocket 发送到后端
3. 后端将消息转发给 OpenClaw 插件
4. OpenClaw 处理消息并返回回复
5. 后端将回复转发给前端
6. 前端显示回复

## 许可证

MIT License - 见 LICENSE 文件