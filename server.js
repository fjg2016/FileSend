// 简单的局域网文件中转服务器
// 使用 Express 提供静态页面，使用 ws 提供 WebSocket 通道

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// 静态文件目录：client
app.use(express.static(path.join(__dirname, 'client')));

// HTTP 服务器（只负责静态资源）
const httpServer = http.createServer(app);

httpServer.listen(PORT, () => {
  console.log(`HTTP server is running at http://0.0.0.0:${PORT}`);
  console.log('在局域网中，其他设备需要访问该 IP 加端口来打开网页，例如：http://你的局域网IP:3000');
});

// WebSocket 服务器（用于转发文件数据）
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`WebSocket server is running at ws://0.0.0.0:${WS_PORT}`);
});

// 基于“配对码”的多房间机制：
// 每个客户端在连接后先发送一条 { type: 'join-room', room: 'XXXX' } 的 JSON 文本
// 服务端把该连接标记到对应房间，之后的二进制/文本消息只会在同一个房间内广播。

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.roomCode = null;

  ws.on('message', (data, isBinary) => {
    if (!isBinary && typeof data === 'string') {
      // 可能是控制类 JSON 消息
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'join-room' && typeof msg.room === 'string') {
          ws.roomCode = msg.room.trim();
          console.log(`Client joined room: ${ws.roomCode}`);
          return;
        }
      } catch (e) {
        // 非本应用 JSON，直接按普通文本广播
      }
    }

    let sent = 0;
    // 只在相同 roomCode 的客户端之间转发
    wss.clients.forEach((client) => {
      if (
        client !== ws &&
        client.readyState === WebSocket.OPEN &&
        client.roomCode === ws.roomCode
      ) {
        client.send(data, { binary: isBinary });
        sent += 1;
      }
    });
    if (sent === 0) {
      console.log(`Broadcast dropped: no peers in room ${ws.roomCode}`);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});


