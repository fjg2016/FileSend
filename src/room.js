// Durable Object: 管理一个房间的 WebSocket 连接
// 每个房间码对应一个 Durable Object 实例

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set(); // 存储所有 WebSocket 连接
    this.roomCode = null;
  }

  async fetch(request) {
    // 处理 WebSocket 升级
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // 从 URL 提取房间码
    const url = new URL(request.url);
    const roomMatch = url.pathname.match(/^\/ws\/([0-9]{6})$/i);
    if (!roomMatch) {
      return new Response('Invalid room code', { status: 400 });
    }

    this.roomCode = roomMatch[1].toUpperCase();

    // 创建 WebSocket 连接对
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 接受 WebSocket 连接
    this.handleSession(server);

    // 返回 WebSocket 响应
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  handleSession(ws) {
    // 接受新的 WebSocket 连接
    ws.accept();
    
    const session = {
      ws,
      roomCode: this.roomCode,
    };

    this.sessions.add(session);
    console.log(`[Room ${this.roomCode}] Client connected. Total: ${this.sessions.size}`);

    // 监听消息
    ws.addEventListener('message', async (event) => {
      try {
        let data = event.data;
        let isString = false;

        // Cloudflare Workers WebSocket 可能返回 ArrayBuffer 或字符串
        if (typeof data === 'string') {
          isString = true;
          // 尝试解析 JSON 控制消息
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'join-room' && typeof msg.room === 'string') {
              session.roomCode = msg.room.trim().toUpperCase();
              console.log(`[Room ${this.roomCode}] Client joined room: ${session.roomCode}`);
              return;
            }
          } catch (e) {
            // 不是 JSON，继续作为普通文本处理
          }
        } else if (data instanceof ArrayBuffer) {
          // 已经是 ArrayBuffer，直接使用
          isString = false;
        } else {
          // 可能是其他格式，尝试转换
          console.warn(`[Room ${this.roomCode}] Unexpected data type:`, typeof data);
          return;
        }

        // 广播消息到同一房间的其他客户端
        let sent = 0;
        for (const otherSession of this.sessions) {
          if (
            otherSession !== session &&
            otherSession.ws.readyState === 1 && // WebSocket.OPEN
            otherSession.roomCode === session.roomCode
          ) {
            try {
              // 发送消息（支持文本和二进制）
              otherSession.ws.send(data);
              sent += 1;
            } catch (e) {
              console.error(`[Room ${this.roomCode}] Error sending to client:`, e);
              // 如果发送失败，可能是连接已关闭，从 sessions 中移除
              this.sessions.delete(otherSession);
            }
          }
        }

        if (sent === 0) {
          console.log(`[Room ${this.roomCode}] Broadcast dropped: no peers in room ${session.roomCode}`);
        }
      } catch (e) {
        console.error(`[Room ${this.roomCode}] Error handling message:`, e);
      }
    });

    // 监听连接关闭
    ws.addEventListener('close', () => {
      this.sessions.delete(session);
      console.log(`[Room ${this.roomCode}] Client disconnected. Total: ${this.sessions.size}`);
    });

    // 监听错误
    ws.addEventListener('error', (error) => {
      console.error(`[Room ${this.roomCode}] WebSocket error:`, error);
      this.sessions.delete(session);
    });
  }
}

