// 前端逻辑（重写版）：自动生成配对码+二维码，任意一端发送，其它端自动接收；
// 记录全部收/发文件；已发送可重新发送；已接收可手动下载（并尝试自动触发下载）。

(() => {
  const log = (...args) => console.log('[LAN-XFER]', ...args);

  const roomCodeText = document.getElementById('roomCodeText');
  const qrContainer = document.getElementById('qrcode');

  const btnPickFile = document.getElementById('btnPickFile');
  const btnCopyLink = document.getElementById('btnCopyLink');
  const fileInput = document.getElementById('fileInput');
  const currentSendInfo = document.getElementById('currentSendInfo');
  const sendProgressGroup = document.getElementById('sendProgressGroup');
  const sendFileNameEl = document.getElementById('sendFileName');
  const sendPercentEl = document.getElementById('sendPercent');
  const sendProgressEl = document.getElementById('sendProgress');

  const fileListEl = document.getElementById('fileList');
  const encryptionStatusEl = document.getElementById('encryptionStatus');
  const noEncryptionStatusEl = document.getElementById('noEncryptionStatus');
  const encryptionStatusTextEl = document.getElementById('encryptionStatusText');

  const CHUNK_SIZE = 64 * 1024; // 64KB 分片，兼顾性能与内存

  let ws = null;
  let sending = false;
  let receiving = false;
  let currentRoomCode = null;
  let nextFileId = 1;

  // transfers：记录本设备已知的收/发文件
  // { id, name, size, mime, status: 'pending' | 'received' | 'sent', direction: 'in' | 'out', fileRef?, blobUrl?, receivedBytes?, chunks? }
  const transfers = new Map();

  // ========== 端到端加密模块 ==========
  // 加密密钥（随机生成，存储在客户端）
  let encryptionKey = null;
  let encryptionKeyString = null; // Base64编码的密钥字符串，用于URL分享
  let encryptionEnabled = false; // 是否启用加密功能

  /**
   * 检查 Web Crypto API 是否可用（不抛出错误，只返回布尔值）
   */
  function isCryptoSupported() {
    return !!(window.crypto && window.crypto.subtle);
  }

  /**
   * 生成随机加密密钥（256位，32字节）
   * 密钥只存在客户端，不会上传到服务器
   */
  function generateEncryptionKey() {
    if (!isCryptoSupported()) {
      log('Web Crypto API 不可用，跳过密钥生成');
      return null;
    }
    
    // 生成32字节（256位）随机密钥
    const keyBytes = window.crypto.getRandomValues(new Uint8Array(32));
    
    // 转换为Base64字符串（URL安全编码）
    // 使用更安全的方法处理大数组
    let binary = '';
    for (let i = 0; i < keyBytes.length; i++) {
      binary += String.fromCharCode(keyBytes[i]);
    }
    const base64Key = btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, ''); // 移除padding，URL更短
    
    encryptionKeyString = base64Key;
    encryptionEnabled = true;
    log('生成新的加密密钥', { length: base64Key.length });
    
    return keyBytes;
  }

  /**
   * 从Base64字符串导入加密密钥
   */
  async function importEncryptionKey(base64Key) {
    if (!isCryptoSupported()) {
      log('Web Crypto API 不可用，跳过密钥导入');
      encryptionEnabled = false;
      return null;
    }
    
    try {
      // 恢复Base64格式（添加padding如果需要）
      let normalizedKey = base64Key.replace(/-/g, '+').replace(/_/g, '/');
      // 添加padding
      while (normalizedKey.length % 4) {
        normalizedKey += '=';
      }
      
      // 解码Base64
      const keyBytes = Uint8Array.from(atob(normalizedKey), c => c.charCodeAt(0));
      
      if (keyBytes.length !== 32) {
        throw new Error('密钥长度不正确');
      }

      // 导入为CryptoKey
      const key = await window.crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM', length: 256 },
        false, // 不可导出
        ['encrypt', 'decrypt']
      );

      encryptionKey = key;
      encryptionKeyString = base64Key;
      encryptionEnabled = true;
      log('导入加密密钥', { length: base64Key.length });
      
      return key;
    } catch (error) {
      log('密钥导入失败', error);
      encryptionEnabled = false;
      throw new Error('无法导入加密密钥: ' + (error.message || '未知错误'));
    }
  }

  /**
   * 获取或生成加密密钥
   */
  async function getEncryptionKey() {
    if (!isCryptoSupported()) {
      log('Web Crypto API 不可用，返回 null');
      encryptionEnabled = false;
      return null;
    }
    
    if (encryptionKey) {
      return encryptionKey;
    }

    // 如果没有密钥，生成新的
    const keyBytes = generateEncryptionKey();
    if (!keyBytes) {
      return null;
    }
    
    encryptionKey = await window.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM', length: 256 },
      false, // 不可导出
      ['encrypt', 'decrypt']
    );

    return encryptionKey;
  }

  /**
   * 加密数据（AES-GCM）
   * 返回格式：IV (12字节) + 密文 + 认证标签 (16字节)
   * 如果不支持加密，直接返回原始数据
   */
  async function encryptData(data) {
    if (!encryptionEnabled) {
      // 不加密模式，直接返回原始数据
      return data;
    }
    
    try {
      const key = await getEncryptionKey();
      if (!key) {
        // 密钥获取失败，返回原始数据
        return data;
      }

      // 生成随机 IV（12字节，AES-GCM 推荐）
      const iv = window.crypto.getRandomValues(new Uint8Array(12));

      // 加密数据
      const encrypted = await window.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv,
        },
        key,
        data
      );

      // 组合 IV + 密文（密文已包含认证标签）
      const result = new Uint8Array(iv.length + encrypted.byteLength);
      result.set(iv, 0);
      result.set(new Uint8Array(encrypted), iv.length);

      return result.buffer;
    } catch (error) {
      log('加密失败，使用不加密模式', error);
      // 加密失败时，返回原始数据
      return data;
    }
  }

  /**
   * 解密数据（AES-GCM）
   * 输入格式：IV (12字节) + 密文 + 认证标签 (16字节)
   * 如果不支持加密或解密失败，尝试作为原始数据返回
   */
  async function decryptData(encryptedData) {
    if (!encryptionEnabled) {
      // 不加密模式，直接返回原始数据
      return encryptedData;
    }
    
    try {
      const key = await getEncryptionKey();
      if (!key) {
        // 密钥获取失败，返回原始数据
        return encryptedData;
      }

      const data = new Uint8Array(encryptedData);

      // 检查数据格式：如果数据太短或不是加密格式，可能是未加密的数据
      if (data.length < 12) {
        log('数据太短，可能是未加密数据，直接返回');
        return encryptedData;
      }

      // 尝试提取 IV 和解密
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);

      // 解密数据
      const decrypted = await window.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv,
        },
        key,
        ciphertext
      );

      return decrypted;
    } catch (error) {
      log('解密失败，可能是未加密数据，直接返回', error);
      // 解密失败时，可能是未加密的数据，直接返回
      return encryptedData;
    }
  }
  // ========== 加密模块结束 ==========

  async function getInitialRoomCodeAndKey() {
    // 从 URL hash 中读取：#code-XXXXXX-key-YYYYYY
    const hash = window.location.hash || '';
    
    // 尝试匹配完整格式：code-ROOMCODE-key-ENCRYPTIONKEY
    const fullMatch = hash.match(/code-([0-9A-Z]{6})(?:-key-([A-Za-z0-9_-]+))?/i);
    
    if (fullMatch) {
      const roomCode = fullMatch[1].toUpperCase();
      const keyString = fullMatch[2];
      
      // 如果URL中包含密钥，尝试导入它（如果支持加密）
      if (keyString && isCryptoSupported()) {
        try {
          await importEncryptionKey(keyString);
          log('已从URL导入加密密钥');
        } catch (err) {
          log('从URL导入密钥失败，将使用不加密模式', err);
          // 清除错误的密钥字符串，使用不加密模式
          encryptionKeyString = null;
          encryptionKey = null;
          encryptionEnabled = false;
        }
      } else if (keyString && !isCryptoSupported()) {
        log('URL包含密钥但当前环境不支持加密，将使用不加密模式');
        encryptionEnabled = false;
      }
      
      return { roomCode, hasKey: !!keyString };
    }
    
    // 兼容旧格式：只有房间码
    const oldMatch = hash.match(/code-([0-9A-Z]{6})/i);
    if (oldMatch) {
      return { roomCode: oldMatch[1].toUpperCase(), hasKey: false };
    }
    
    // 没有则生成新的房间码（密钥会在setRoomCode时生成）
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return { roomCode: code, hasKey: false };
  }

  /**
   * 更新加密状态显示
   */
  function updateEncryptionStatus() {
    const cryptoSupported = isCryptoSupported();
    
    if (encryptionEnabled && cryptoSupported) {
      // 显示加密模式
      if (encryptionStatusEl) {
        encryptionStatusEl.style.display = 'flex';
      }
      if (noEncryptionStatusEl) {
        noEncryptionStatusEl.style.display = 'none';
      }
      if (encryptionStatusTextEl) {
        encryptionStatusTextEl.textContent = '端到端加密';
      }
    } else {
      // 显示不加密模式
      if (encryptionStatusEl) {
        encryptionStatusEl.style.display = 'none';
      }
      if (noEncryptionStatusEl) {
        noEncryptionStatusEl.style.display = 'flex';
      }
    }
  }

  async function setRoomCode(code) {
    currentRoomCode = code;
    roomCodeText.textContent = code;
    
    // 检查是否支持加密
    const cryptoSupported = isCryptoSupported();
    
    // 如果支持加密且没有密钥，生成新的密钥
    if (cryptoSupported && !encryptionKeyString) {
      generateEncryptionKey();
      await getEncryptionKey(); // 确保密钥已导入
    }
    
    // 显示加密状态标识
    updateEncryptionStatus();
    
    // 构造hash：如果支持加密且有密钥，包含密钥；否则只包含房间码
    let newHash;
    if (encryptionEnabled && encryptionKeyString) {
      newHash = `code-${code}-key-${encryptionKeyString}`;
    } else {
      newHash = `code-${code}`;
    }
    
    if (window.location.hash !== `#${newHash}`) {
      window.location.hash = newHash;
    }

    // 构造用于二维码的 URL（包含 hash），使用当前访问的 host 与端口
    const loc = window.location;
    const fullUrl = `${loc.protocol}//${loc.host}${loc.pathname}#${newHash}`;

    // 使用线上 QR 服务生成真实二维码图片
    const img = document.createElement('img');
    img.alt = '加入链接二维码';
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=192x192&data=${encodeURIComponent(
      fullUrl
    )}`;
    img.style.width = '100%';
    img.style.height = '100%';
    qrContainer.innerHTML = '';
    qrContainer.appendChild(img);

    // 绑定复制链接按钮
    if (btnCopyLink) {
      btnCopyLink.onclick = async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(fullUrl);
          } else {
            // 旧浏览器降级方案
            const textarea = document.createElement('textarea');
            textarea.value = fullUrl;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          }
          btnCopyLink.textContent = '已复制';
          setTimeout(() => {
            btnCopyLink.textContent = '复制加入链接';
          }, 2000);
        } catch (err) {
          alert('复制失败，请手动长按链接区域复制：\n' + fullUrl);
        }
      };
    }
  }

  function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      return;
    }

    // 检测是否为本地开发环境
    const isLocalDev = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' ||
                       window.location.hostname.startsWith('192.168.') ||
                       window.location.hostname.startsWith('10.') ||
                       window.location.hostname.startsWith('172.');

    let url;
    if (isLocalDev) {
      // 本地开发：使用端口 3001 的 WebSocket 服务器
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const hostname = window.location.hostname;
      const room = currentRoomCode || '000000';
      url = `${protocol}//${hostname}:3001`;
      // 本地服务器不需要 /ws/ 路径，直接连接
    } else {
      // 生产环境：使用 Cloudflare Workers 的 WebSocket 路径格式
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const currentHost = window.location.host;
      const room = currentRoomCode || '000000';
      url = `${protocol}//${currentHost}/ws/${room}`;
    }

    try {
      ws = new WebSocket(url);
    } catch (e) {
      log('WS 构造失败', e);
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      log('WS 已连接', url, 'room', currentRoomCode);
      // 连接成功后立刻加入当前配对码房间
      const room = currentRoomCode;
      if (!room) {
        alert('配对码为空，请刷新页面重试');
        return;
      }
      const joinPayload = JSON.stringify({
        type: 'join-room',
        room,
      });
      ws.send(joinPayload);
      log('已发送 join-room', room);
    };

    ws.onclose = () => {
      log('WS 断开，准备重连');
      ws = null;
      sending = false;
      receiving = false;
      // 简单重连策略：短暂延时后再尝试一次
      setTimeout(connectWebSocket, 1500);
    };

    ws.onerror = () => {
      // 控制台提示即可，不打扰用户
      log('WS 出错，请检查服务是否已启动');
    };

    ws.onmessage = (event) => {
      handleIncoming(event.data);
    };
  }

  function updateTransfer(id, patch) {
    const prev = transfers.get(id) || {};
    const next = { ...prev, ...patch };
    transfers.set(id, next);
    renderFileList();
    return next;
  }

  function doSendFile(file, existingId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert('请先连接 WebSocket 服务器');
      return;
    }
    if (sending) {
      alert('已有文件在发送，请稍后再试');
      return;
    }

    sending = true;
    sendProgressGroup.hidden = false;
    sendFileNameEl.textContent = file.name;
    sendPercentEl.textContent = '0%';
    sendProgressEl.style.width = '0%';
    currentSendInfo.textContent = `正在发送：${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;

    const fileId = existingId || `${Date.now()}-${nextFileId++}`;

    // 在本机记录这次文件（发送记录）
    updateTransfer(fileId, {
      id: fileId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      status: 'sent',
      direction: 'out',
      fileRef: file,
    });

    // 先发送一个 JSON 元数据包
    const meta = {
      type: 'file-meta',
      id: fileId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
    };
    log('发送 meta', meta);
    ws.send(JSON.stringify(meta));

    // 再分片发送二进制
    let offset = 0;

    function sendNextChunk() {
      if (!sending) return;

      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const slice = file.slice(offset, end);

      const reader = new FileReader();
      reader.onload = async function (e) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          sending = false;
          alert('连接已断开，发送中止');
          return;
        }

        try {
          // 端到端加密：在发送前加密分片（如果不支持加密则直接发送原始数据）
          const plaintext = e.target.result;
          const encrypted = await encryptData(plaintext);
          
          ws.send(encrypted); // 发送数据（加密或原始）
          if (encryptionEnabled) {
            log('发送加密分片', { id: fileId, offset, end, size: file.size, encryptedSize: encrypted.byteLength });
          } else {
            log('发送分片（不加密模式）', { id: fileId, offset, end, size: file.size });
          }

          offset = end;
          const percent = Math.floor((offset / file.size) * 100);
          sendPercentEl.textContent = `${percent}%`;
          sendProgressEl.style.width = `${percent}%`;

          if (offset < file.size) {
            // 使用 setTimeout 避免长时间主线程卡顿
            setTimeout(sendNextChunk, 0);
          } else {
            sending = false;
            // 通知结束
            const endMsg = { type: 'file-end', id: fileId };
            ws.send(JSON.stringify(endMsg));
            log('发送完成', { id: fileId, size: file.size });
            currentSendInfo.textContent = '发送完成，可以再次选择文件发送。';
          }
        } catch (error) {
          sending = false;
          log('加密或发送失败', error);
          alert('发送失败：' + (error.message || '未知错误'));
        }
      };

      reader.onerror = function () {
        sending = false;
        alert('读取文件时出错');
      };

      reader.readAsArrayBuffer(slice);
    }

    currentSendInfo.textContent = '正在发送，请保持页面常亮，不要锁屏或切到后台太久。';
    sendNextChunk();
  }

  // 发送：选择文件并立即发送
  btnPickFile.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert('正在连接服务，请稍后再试…');
      return;
    }
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    doSendFile(file);
    // 重置 input，方便连续选择同名文件也能触发 change
    fileInput.value = '';
  });

  function renderFileList() {
    fileListEl.innerHTML = '';
    const entries = Array.from(transfers.values()).sort((a, b) => {
      // 按时间排序（较新在前）；id 是时间戳前缀
      return b.id.localeCompare(a.id);
    });

    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'file-list-empty';
      li.textContent = '暂无文件记录';
      fileListEl.appendChild(li);
      return;
    }

    entries.forEach((f) => {
      const li = document.createElement('li');
      li.className = 'file-list-item';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-name';
      nameSpan.textContent = f.name;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'file-meta';
      metaSpan.textContent = `${(f.size / 1024 / 1024).toFixed(2)} MB`;

      const statusSpan = document.createElement('span');
      statusSpan.className = `file-status ${f.status}`;
      statusSpan.textContent =
        f.status === 'pending'
          ? '未接收'
          : f.status === 'received'
          ? f.direction === 'out'
            ? '已发送'
            : '已接收'
          : f.status === 'error'
          ? '错误'
          : '已发送';
      
      // 如果有错误信息，添加提示
      if (f.status === 'error' && f.error) {
        statusSpan.title = f.error;
      }

      li.appendChild(nameSpan);
      li.appendChild(metaSpan);
      li.appendChild(statusSpan);

      // 已发送的文件支持重新发送
      if (f.status === 'sent' && f.fileRef) {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'file-action';
        actionBtn.textContent = '重新发送';
        actionBtn.onclick = () => doSendFile(f.fileRef);
        li.appendChild(actionBtn);
      }

      // 已接收且有 blobUrl，提供下载
      if (f.status === 'received' && f.blobUrl) {
        const actionBtn = document.createElement('button');
        actionBtn.className = 'file-action';
        actionBtn.textContent = '下载';
        actionBtn.onclick = () => {
          const a = document.createElement('a');
          a.href = f.blobUrl;
          a.download = f.name || 'download';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        };
        li.appendChild(actionBtn);
      }

      fileListEl.appendChild(li);
    });
  }

  function handleIncoming(data) {
    // 某些浏览器可能返回 Blob，这里统一转换为 ArrayBuffer 处理
    if (data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buf) => handleIncoming(buf))
        .catch(() => {
          log('Blob 转 ArrayBuffer 失败');
        });
      return;
    }

    // 可能是文本（JSON 控制信息），也可能是二进制片段
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'file-meta') {
          // 开始接收新文件
          log('收到 meta', msg);
          const entry = updateTransfer(msg.id, {
            id: msg.id,
            name: msg.name,
            size: msg.size,
            mime: msg.mime || 'application/octet-stream',
            status: 'pending',
            direction: 'in',
            chunks: [],
            receivedBytes: 0,
          });
          receiving = true;
        } else if (msg.type === 'file-end') {
          // 文件接收结束，合并并触发下载（尽量兜底，即便 receiving 标志异常也尝试完成）
          const entry = transfers.get(msg.id);
          if (entry && entry.chunks && entry.chunks.length) {
            log('收到 file-end，开始合并', { id: msg.id, chunks: entry.chunks.length, size: entry.size });
            const blob = new Blob(entry.chunks, { type: entry.mime || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);

            // 使用改进的下载方法，避免打开新标签页
            // 检测移动设备
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
            
            try {
              if (isMobile && !isIOS) {
                // Android 等移动设备：使用隐藏的 iframe 方法，避免打开新窗口
                const iframe = document.createElement('iframe');
                iframe.style.position = 'fixed';
                iframe.style.top = '-9999px';
                iframe.style.left = '-9999px';
                iframe.style.width = '1px';
                iframe.style.height = '1px';
                iframe.style.opacity = '0';
                document.body.appendChild(iframe);
                
                // 等待 iframe 加载
                iframe.onload = () => {
                  try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const a = iframeDoc.createElement('a');
                    a.href = url;
                    a.download = entry.name || 'download';
                    iframeDoc.body.appendChild(a);
                    a.click();
                    
                    // 延迟清理
                    setTimeout(() => {
                      try {
                        document.body.removeChild(iframe);
                      } catch (e) {
                        // 忽略错误
                      }
                    }, 1000);
                  } catch (e) {
                    log('iframe 下载失败', e);
                    document.body.removeChild(iframe);
                  }
                };
                
                // 设置 iframe src 以触发加载
                iframe.src = 'about:blank';
                
                // 延迟释放 blob URL（给 iframe 足够时间）
                setTimeout(() => {
                  try {
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    // 忽略错误
                  }
                }, 5000);
              } else if (isIOS) {
                // iOS 设备：由于安全限制，不自动下载，只提示用户
                log('iOS 设备：文件已准备好，请在文件记录中手动下载');
                // 显示提示（可选）
                if (window.Notification && Notification.permission === 'granted') {
                  new Notification('文件接收完成', {
                    body: `文件 ${entry.name} 已准备好，请在文件记录中下载`,
                    icon: '/favicon.ico'
                  });
                }
              } else {
                // 桌面设备：使用标准方法
                const a = document.createElement('a');
                a.href = url;
                a.download = entry.name || 'download';
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                
                // 延迟移除和清理
                setTimeout(() => {
                  try {
                    document.body.removeChild(a);
                  } catch (e) {
                    // 如果已经被移除，忽略错误
                  }
                  // 延迟释放 blob URL，确保下载已开始
                  setTimeout(() => {
                    try {
                      URL.revokeObjectURL(url);
                    } catch (e) {
                      // 忽略错误
                    }
                  }, 2000);
                }, 200);
              }
            } catch (e) {
              log('自动下载失败，文件已保存到文件记录中，可手动下载', e);
              // 如果所有方法都失败，至少保留 blobUrl 供手动下载
            }

            receiving = false;

            // 标记为已接收并保留 blobUrl 以便手动下载
            updateTransfer(msg.id, {
              status: 'received',
              blobUrl: url,
              chunks: [],
              receivedBytes: entry.size,
            });
          }
          // 重置接收缓冲
          receiving = false;
        }
      } catch (e) {
        // 非本应用 JSON，忽略
        log('JSON 解析失败或非本协议消息', e);
      }
    } else if (data instanceof ArrayBuffer) {
      // 接收二进制片段（加密的）
      if (!receiving) {
        log('收到二进制但未在接收状态，丢弃');
        return;
      }
      // 将当前正在接收的最新 pending 记录提取出来（按最后创建的 pending）
      const pendingList = Array.from(transfers.values()).filter(
        (t) => t.status === 'pending' && t.direction === 'in'
      );
      if (!pendingList.length) {
        log('无 pending 记录，忽略分片');
        return;
      }
      // 最新的 pending 当做当前传输
      const current = pendingList.sort((a, b) => b.id.localeCompare(a.id))[0];
      
      // 端到端解密：在接收后解密分片（如果不支持加密则直接使用原始数据）
      (async () => {
        try {
          const decrypted = await decryptData(data);
          const chunk = new Uint8Array(decrypted);
          
          const updated = updateTransfer(current.id, {
            chunks: [...(current.chunks || []), chunk],
            receivedBytes: (current.receivedBytes || 0) + chunk.byteLength,
          });
          
          if (encryptionEnabled) {
            log('收到并解密分片', {
              id: current.id,
              encryptedSize: data.byteLength,
              decryptedSize: chunk.byteLength,
              receivedBytes: updated.receivedBytes,
              total: updated.size,
            });
          } else {
            log('收到分片（不加密模式）', {
              id: current.id,
              size: chunk.byteLength,
              receivedBytes: updated.receivedBytes,
              total: updated.size,
            });
          }

          if (updated.size > 0) {
            const percent = Math.floor(((updated.receivedBytes || 0) / updated.size) * 100);
            sendPercentEl.textContent = `${percent}%`;
            sendProgressEl.style.width = `${percent}%`;
          }
        } catch (error) {
          log('处理分片失败', error);
          // 处理失败时，标记传输错误但不中断整个流程
          updateTransfer(current.id, {
            status: 'error',
            error: '接收失败：' + (error.message || '未知错误')
          });
          receiving = false;
          // 显示错误提示（非阻塞）
          setTimeout(() => {
            if (encryptionEnabled) {
              alert('文件接收失败：解密错误\n\n可能的原因：\n1. 房间码不匹配\n2. 数据损坏\n3. 加密密钥不一致\n\n请确保双方使用相同的房间码和密钥。');
            } else {
              alert('文件接收失败：' + (error.message || '未知错误'));
            }
          }, 100);
        }
      })();
    }
  }

  // 初始化：生成房间码、渲染二维码并建立连接
  window.addEventListener('load', async () => {
    try {
      // 检查加密支持（不强制要求）
      const cryptoSupported = isCryptoSupported();
      if (!cryptoSupported) {
        log('Web Crypto API 不可用，将以不加密模式运行');
        encryptionEnabled = false;
      }
      
      const { roomCode, hasKey } = await getInitialRoomCodeAndKey();
      await setRoomCode(roomCode);
      updateEncryptionStatus(); // 确保状态显示正确
      connectWebSocket();
      renderFileList();
    } catch (error) {
      log('初始化失败', error);
      // 即使出错，也尝试以不加密模式继续运行
      try {
        // 从URL提取房间码（不包含密钥）
        const hash = window.location.hash || '';
        const match = hash.match(/code-([0-9A-Z]{6})/i);
        const roomCode = match ? match[1].toUpperCase() : null;
        
        if (roomCode) {
          currentRoomCode = roomCode;
          roomCodeText.textContent = roomCode;
          // 更新URL（移除密钥部分）
          window.location.hash = `code-${roomCode}`;
        } else {
          // 生成新房间码
          const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
          let code = '';
          for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          currentRoomCode = code;
          roomCodeText.textContent = code;
          window.location.hash = `code-${code}`;
        }
        
        // 重新生成二维码
        const loc = window.location;
        const fullUrl = `${loc.protocol}//${loc.host}${loc.pathname}#code-${currentRoomCode}`;
        const img = document.createElement('img');
        img.alt = '加入链接二维码';
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=192x192&data=${encodeURIComponent(fullUrl)}`;
        img.style.width = '100%';
        img.style.height = '100%';
        qrContainer.innerHTML = '';
        qrContainer.appendChild(img);
        
        // 更新加密状态显示
        updateEncryptionStatus();
        
        connectWebSocket();
        renderFileList();
      } catch (fallbackError) {
        log('降级模式也失败', fallbackError);
        alert('应用无法启动，请刷新页面重试。');
      }
    }
  });
})();


