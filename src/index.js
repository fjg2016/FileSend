// Cloudflare Workers 主入口
// 处理 WebSocket 升级请求（/ws/* 路径）
// 静态文件由 Cloudflare Pages 处理

import { Room } from './room.js';

// 导出 Durable Object 类（必须导出，Cloudflare 才能识别）
export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 处理 WebSocket 升级请求
    if (request.headers.get('Upgrade') === 'websocket') {
      // 从 URL 路径中提取房间码，例如 /ws/A1B2C3
      const roomMatch = url.pathname.match(/^\/ws\/([0-9A-Z]{6})$/i);
      if (!roomMatch) {
        return new Response('Invalid room code', { status: 400 });
      }

      const roomCode = roomMatch[1].toUpperCase();
      
      // 获取或创建对应的 Durable Object
      const id = env.ROOM.idFromName(roomCode);
      const stub = env.ROOM.get(id);

      // 将请求转发到 Durable Object
      return stub.fetch(request);
    }

    // 非 WebSocket 请求应该由 Cloudflare Pages 处理
    // 如果请求到达这里，说明路由配置可能有问题
    // 返回 404，让 Cloudflare Pages 处理（如果配置了回退）
    return new Response('Not found. This Worker only handles WebSocket connections at /ws/*', { 
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};

