# 文件传输应用

一个支持跨网络文件传输的 Web 应用，通过链接分享即可在不同设备间传输文件。支持电脑、手机等各类设备，无需安装任何软件。

## 项目介绍

### 功能特点

- ✅ **跨网络传输**：支持不同网络环境下的文件传输
- ✅ **链接分享**：通过链接或二维码即可加入房间
- ✅ **自动配对**：自动生成房间码（6位数字+字母），同一房间内的设备自动连接
- ✅ **端到端加密**：支持 AES-GCM 256位加密，密钥通过链接分享，服务器无法查看文件内容
- ✅ **实时传输**：基于 WebSocket 的实时文件传输
- ✅ **大文件支持**：支持大文件分片传输（64KB 分片）
- ✅ **传输记录**：记录所有收/发文件，支持重新发送和下载
- ✅ **智能降级**：不支持加密的环境自动降级为不加密模式，确保功能可用

### 技术架构

- **前端**：纯 HTML/CSS/JavaScript，无需框架
- **后端**：Cloudflare Workers + Durable Objects
- **传输协议**：WebSocket（wss://）
- **加密算法**：AES-GCM 256位（使用 Web Crypto API）
- **密钥管理**：客户端随机生成，通过 URL 分享
- **部署平台**：Cloudflare Pages + Workers

### 项目结构

```
FileSend/
├── client/             # 前端静态文件
│   ├── index.html      # 主页面
│   ├── app.js          # 前端逻辑
│   └── style.css       # 样式文件
├── src/                # Cloudflare Workers 代码
│   ├── index.js        # Workers 主入口
│   └── room.js         # Durable Object（房间管理）
├── wrangler.toml       # Workers 配置文件
└── package.json        # 项目配置
```

## 部署方式

### 本地部署（开发测试）

#### 前置要求

1. **Node.js**：安装 Node.js 16 或更高版本
2. **npm**：Node.js 自带，或使用 yarn/pnpm

#### 快速开始

1. **安装依赖**

```bash
npm install
```

2. **启动本地服务器**

```bash
npm start
```

服务器启动后会显示：
- HTTP 服务器：`http://0.0.0.0:3000`
- WebSocket 服务器：`ws://0.0.0.0:3001`

3. **访问应用**

- **本地访问**：打开浏览器访问 `http://localhost:3000`
- **局域网访问**：在同一网络下的其他设备访问 `http://你的IP地址:3000`
  - Windows: 在命令行运行 `ipconfig` 查看 IP 地址
  - Mac/Linux: 在终端运行 `ifconfig` 或 `ip addr` 查看 IP 地址

4. **测试文件传输**

- 在同一网络下的两台设备上打开应用
- 使用相同的房间码（通过链接或二维码分享）
- 在一台设备上选择文件发送，另一台设备会自动接收
- **注意**：HTTP 环境下会以不加密模式运行，HTTPS 或 localhost 环境下会自动启用端到端加密

#### 本地开发说明

- **端口配置**：
  - HTTP 服务器：3000 端口（可通过 `PORT` 环境变量修改）
  - WebSocket 服务器：3001 端口（可通过 `WS_PORT` 环境变量修改）

- **环境变量**：
  ```bash
  # 自定义端口
  PORT=8080 WS_PORT=8081 npm start
  ```

- **自动检测**：前端代码会自动检测本地开发环境，使用正确的 WebSocket 连接方式

---

### Cloudflare 部署（生产环境）

#### 前置要求

1. **Cloudflare 账户**：注册 [Cloudflare](https://www.cloudflare.com/) 账户（免费账户即可）
2. **Node.js**：安装 Node.js 16 或更高版本
3. **Wrangler CLI**：用于部署到 Cloudflare

#### 快速部署

#### 1. 安装依赖

```bash
npm install
```

#### 2. 登录 Cloudflare

```bash
npx wrangler login
```

#### 3. 部署静态文件到 Pages

```bash
npx wrangler pages deploy client --project-name=file-send
```

部署完成后会显示 Pages 域名，例如：`https://file-send.pages.dev`

#### 4. 部署 Workers

```bash
npx wrangler deploy
```

部署完成后会显示 Workers 域名，例如：`https://file-send.your-subdomain.workers.dev`

**重要提示**：首次部署需要启用 Durable Objects，免费计划需要使用 SQLite Durable Objects（已在配置中设置）。

#### 5. 配置路由（重要）

路由配置让 `/ws/*` 路径指向 Workers，这是**关键步骤**。

**选项 A：使用自定义域名（推荐）**

1. 在 [Cloudflare Dashboard](https://dash.cloudflare.com/) 中：
   - 进入你的域名设置
   - 进入 **Workers Routes**
   - 添加路由：`yourdomain.com/ws/*` → Worker: `file-send`
2. 在 Pages 项目中添加自定义域名：
   - 进入 Pages 项目的 **Custom domains** 标签
   - 添加你的域名

**选项 B：使用默认域名**

如果使用默认的 `.pages.dev` 域名，需要在域名级别配置路由：
- 在 Cloudflare Dashboard 中进入你的账户设置
- 找到 Workers Routes 配置
- 添加路由：`file-send.pages.dev/ws/*` → Worker: `file-send`

**选项 C：使用 wrangler.toml 配置**

编辑 `wrangler.toml`，取消注释并修改：

```toml
routes = [
  { pattern = "yourdomain.com/ws/*", zone_name = "yourdomain.com" }
]
```

然后重新部署：
```bash
npx wrangler deploy
```

### 访问应用

部署完成后，访问 **Pages 域名**（例如：`https://file-send.pages.dev`）即可使用。

**注意**：请访问 Pages 域名，而不是 Workers 域名。Workers 域名只处理 WebSocket 连接，不能直接访问。

### 更新部署

**更新静态文件：**
```bash
npx wrangler pages deploy client --project-name=file-send
```

**更新 Workers：**
```bash
npx wrangler deploy
```

### 常见问题

**Q: 部署后访问链接显示 404？**  
A: 确保访问的是 Pages 域名（`*.pages.dev`），而不是 Workers 域名（`*.workers.dev`）。

**Q: WebSocket 连接失败？**  
A: 检查路由配置是否正确，确保 `/ws/*` 路径已指向 Workers。

**Q: "Durable Objects not enabled" 错误？**  
A: 确保 `wrangler.toml` 中使用 `new_sqlite_classes` 而不是 `new_classes`（免费计划要求）。

**Q: "Cannot apply new-class migration" 错误？**  
A: 确保 `src/index.js` 中已导出 `Room` 类：`export { Room };`

**Q: 本地开发时 WebSocket 连接失败？**  
A: 确保本地服务器已启动（`npm start`），前端代码会自动检测本地环境并使用正确的连接方式（端口 3001）。

**Q: 本地开发时如何在同一网络的其他设备访问？**  
A: 使用你的局域网 IP 地址访问，例如：`http://192.168.1.100:3000`。确保防火墙允许 3000 和 3001 端口的连接。

**Q: 加密功能如何工作？**  
A: 
- 在支持 Web Crypto API 的环境（HTTPS 或 localhost）下，应用会自动生成随机加密密钥
- 密钥通过 URL 分享（格式：`#code-ROOMCODE-key-ENCRYPTIONKEY`）
- 接收方通过链接或二维码获取密钥，自动解密文件
- 服务器只能看到加密后的数据，无法查看原始文件内容

**Q: HTTP 环境下可以使用吗？**  
A: 可以。HTTP 环境下会自动降级为不加密模式，所有功能正常使用，只是文件传输不加密。建议生产环境使用 HTTPS 以获得加密保护。

**Q: 房间码格式是什么？**  
A: 房间码为 6 位字符，包含数字 0-9 和字母 A-Z，例如：`A1B2C3`、`9X7Y2Z`。

## 安全特性

### 端到端加密

- **密钥生成**：每个会话随机生成 256 位 AES 密钥
- **密钥分享**：密钥通过 URL 参数分享，不发送到服务器
- **加密算法**：AES-GCM 256位，提供数据加密和完整性验证
- **服务器隔离**：服务器只能转发加密数据，无法解密查看文件内容
- **自动降级**：不支持加密的环境自动使用不加密模式，确保功能可用

### 加密模式标识

应用会在界面上显示当前运行模式：
- 🔒 **端到端加密**：支持加密且已启用（HTTPS 或 localhost）
- ⚠️ **不加密模式**：不支持加密或未启用（HTTP 非 localhost）

## 本地开发 vs 生产环境

| 特性 | 本地开发 | 生产环境（Cloudflare） |
|------|---------|---------------------|
| HTTP 服务器 | Express (端口 3000) | Cloudflare Pages |
| WebSocket 服务器 | ws 库 (端口 3001) | Cloudflare Workers + Durable Objects |
| 连接方式 | `ws://localhost:3001` | `wss://domain.com/ws/房间码` |
| 房间管理 | 内存中管理 | Durable Objects |
| 网络限制 | 仅局域网 | 跨网络 |
| 加密支持 | localhost 支持 | HTTPS 支持 |
| 适用场景 | 开发测试 | 生产使用 |

## 使用说明

### 基本使用流程

1. **发送方**：
   - 打开应用，系统自动生成房间码和加密密钥（如果支持）
   - 扫描二维码或复制链接分享给接收方
   - 选择文件并发送

2. **接收方**：
   - 通过链接或二维码加入房间
   - 自动获取加密密钥（如果链接中包含）
   - 自动接收并下载文件

### URL 格式

- **加密模式**：`https://domain.com/#code-ROOMCODE-key-ENCRYPTIONKEY`
- **不加密模式**：`http://domain.com/#code-ROOMCODE`

### 浏览器要求

- **推荐浏览器**：Chrome、Firefox、Safari、Edge（最新版本）
- **加密功能**：需要支持 Web Crypto API（现代浏览器均支持）
- **HTTPS 要求**：生产环境建议使用 HTTPS 以启用加密功能

## 许可证

MIT License
