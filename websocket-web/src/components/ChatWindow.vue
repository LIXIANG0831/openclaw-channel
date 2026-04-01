<template>
  <div class="chat-container">
    <!-- 头部 -->
    <header class="chat-header">
      <h2>🤖 OpenClaw AI 助手</h2>
      <div class="status-indicator" :class="connectionStatus">
        <span class="dot"></span>
        {{ statusText }}
      </div>
    </header>

    <!-- 消息列表 -->
    <div class="message-list" ref="messageListRef">
      <div v-if="messages.length === 0" class="empty-state">
        <p>👋 您好！连接成功后，请输入消息开始对话。</p>
        <p class="hint">后端：Python WebSocket Hub | AI：OpenClaw</p>
      </div>

      <div
        v-for="(msg, index) in messages"
        :key="index"
        class="message-item"
        :class="msg.role"
      >
        <div class="avatar">
          {{ msg.role === 'user' ? '🧑‍💻' : msg.role === 'tool' ? '⚙️' : '🤖' }}
        </div>
        <div class="bubble">
          <!-- 工具调用卡片 -->
          <div v-if="msg.role === 'tool'" class="tool-card">
            <!-- 头部：工具名称 + 状态 -->
            <div class="tool-header">
              <span class="tool-icon">🔧</span>
              <span class="tool-name">{{ msg.content.name || '工具调用' }}</span>
              <span class="tool-status" :class="msg.content.status">
                <span v-if="msg.content.status === 'starting'">启动中...</span>
                <span v-else-if="msg.content.status === 'running'" class="status-running">
                  <span class="spinner"></span>
                  执行中
                </span>
                <span v-else-if="msg.content.status === 'completed'">✓ 已完成</span>
              </span>
            </div>

            <!-- 命令信息 -->
            <div v-if="msg.content.command" class="tool-command">
              <div class="command-label">命令:</div>
              <code>{{ msg.content.command }}</code>
            </div>

            <!-- 工作目录和进程信息 -->
            <div v-if="msg.content.cwd || msg.content.pid" class="tool-info">
              <span v-if="msg.content.cwd" class="info-item">
                📁 {{ msg.content.cwd }}
              </span>
              <span v-if="msg.content.pid" class="info-item">
                🔢 PID: {{ msg.content.pid }}
              </span>
            </div>

            <!-- 输出结果 -->
            <div v-if="msg.content.output" class="tool-output">
              <div class="output-label">
                {{ msg.content.status === 'completed' ? '输出结果:' : '实时输出:' }}
              </div>
              <pre class="output-content">{{ msg.content.output }}</pre>
            </div>

            <!-- 元信息：退出码和耗时 -->
            <div v-if="msg.content.status === 'completed'" class="tool-meta">
              <span class="meta-item" :class="{ success: msg.content.exitCode === 0, error: msg.content.exitCode !== 0 }">
                {{ msg.content.exitCode === 0 ? '✓ 成功' : `✗ 失败 (退出码: ${msg.content.exitCode})` }}
              </span>
              <span class="meta-item">
                ⏱️ {{ msg.content.duration }}ms
              </span>
            </div>
          </div>
          <!-- 普通消息 -->
          <div v-else class="content markdown-body" v-html="renderMarkdown(msg.content)"></div>
          <div class="timestamp">{{ msg.time }}</div>
        </div>
      </div>
      
      <!-- 加载中状态 -->
      <div v-if="isThinking" class="message-item ai thinking">
        <div class="avatar">🤖</div>
        <div class="bubble">
          <span class="typing-indicator">AI 正在思考...</span>
        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="input-area">
      <input 
        v-model="inputMessage" 
        @keyup.enter="sendMessage" 
        placeholder="输入消息并回车发送..." 
        :disabled="connectionStatus !== 'connected'"
        class="chat-input"
      />
      <button 
        @click="sendMessage" 
        :disabled="connectionStatus !== 'connected' || !inputMessage.trim()"
        class="send-btn"
      >
        发送
      </button>
      <button @click="toggleConnection" class="control-btn">
        {{ connectionStatus === 'connected' ? '断开' : '重连' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick, computed, onMounted, onUnmounted } from 'vue';
import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

// 配置 marked 使用 highlight.js
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (err) {}
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true
});

// --- 状态定义 ---
const inputMessage = ref('');
const messages = reactive([]);
const isThinking = ref(false);
const ws = ref(null);
const messageListRef = ref(null);
const activeToolCalls = reactive({}); // 存储进行中的工具调用

// 连接状态: 'disconnected', 'connecting', 'connected'
const connectionStatus = ref('disconnected');

const statusText = computed(() => {
  switch(connectionStatus.value) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中...';
    default: return '未连接';
  }
});

// --- WebSocket 逻辑 ---

const connectWebSocket = () => {
  if (ws.value && ws.value.readyState === WebSocket.OPEN) return;

  connectionStatus.value = 'connecting';
  
  // 【关键】连接 Python 服务的根路径 '/'
  // Python 会根据路径识别此为 'frontend' 客户端
  // 使用环境变量配置，支持 ngrok 等外部服务
  // 默认值: ws://localhost:8765/
  const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:8765/'; 
  
  console.log(`正在连接: ${wsUrl}`);
  ws.value = new WebSocket(wsUrl);

  ws.value.onopen = () => {
    connectionStatus.value = 'connected';
    addSystemMessage('✅ 已连接到 Python 服务，可以开始对话了！');
    scrollToBottom();
  };

  ws.value.onmessage = (event) => {
    try {
      const packet = JSON.parse(event.data);

      // 【核心协议】处理来自 OpenClaw 的转发消息
      if (packet.type === 'from_openclaw') {
        // 停止思考动画
        isThinking.value = false;

        // 检查是否是工具调用消息
        if (packet.data?.type === 'tool_call') {
          handleToolCallMessage(packet.data.data);
        } else {
          // 提取内容：兼容多种数据结构
          const content = packet.data?.content
                       || packet.data?.text
                       || packet.data?.reply
                       || JSON.stringify(packet.data);

          addMessage('ai', content);
        }
      }
      // 处理工具调用消息
      else if (packet.type === 'tool_call') {
        handleToolCallMessage(packet.data);
      }
      // 处理错误消息
      else if (packet.type === 'error') {
        addSystemMessage(`⚠️ 服务器错误: ${packet.message}`);
        isThinking.value = false;
      }
      // 处理确认消息 (可选)
      else if (packet.type === 'message_received') {
        console.log('服务器已接收:', packet);
      }
      // 兼容旧格式或非 JSON 字符串
      else {
        addMessage('ai', event.data);
        isThinking.value = false;
      }

      scrollToBottom();
    } catch (e) {
      console.error('解析消息失败:', e);
      addSystemMessage('收到无法解析的消息格式');
      isThinking.value = false;
    }
  };

  ws.value.onclose = () => {
    connectionStatus.value = 'disconnected';
    addSystemMessage('❌ 连接已断开，请检查 Python 服务是否运行。');
    isThinking.value = false;
  };

  ws.value.onerror = (err) => {
    console.error('WS Error:', err);
    // 错误通常伴随 close 事件
  };
};

const disconnectWebSocket = () => {
  if (ws.value) {
    ws.value.close();
    ws.value = null;
  }
};

const toggleConnection = () => {
  if (connectionStatus.value === 'connected') {
    disconnectWebSocket();
  } else {
    connectWebSocket();
  }
};

const sendMessage = () => {
  const text = inputMessage.value.trim();
  if (!text || connectionStatus.value !== 'connected') return;

  // 1. 显示用户消息
  addMessage('user', text);
  inputMessage.value = '';
  isThinking.value = true; // 显示 AI 思考中
  scrollToBottom();

  // 2. 构造发送给 Python 的协议包
  const payload = {
    type: 'chat',          // 消息类型
    content: text,         // 实际内容
    timestamp: new Date().toISOString(),
    source: 'vue_frontend'
  };

  // 3. 发送
  ws.value.send(JSON.stringify(payload));
  console.log('已发送:', payload);
};

// --- 辅助函数 ---

const addMessage = (role, content) => {
  messages.push({
    role, // 'user' or 'ai'
    content,
    time: new Date().toLocaleTimeString()
  });
};

const addSystemMessage = (content) => {
  messages.push({
    role: 'system',
    content,
    time: new Date().toLocaleTimeString()
  });
};

// 处理工具调用消息
const handleToolCallMessage = (data) => {
  const runId = data.runId;

  // 1. 初始工具调用 (seq: 2) - 创建新消息
  if (data.seq && !data.partialResult && !data.result) {
    activeToolCalls[runId] = messages.length; // 记录消息索引
    addMessage('tool', {
      name: '命令执行',
      status: 'starting',
      command: '',
      output: '',
      cwd: '',
      pid: null,
      exitCode: undefined,
      duration: 0,
      startTime: Date.now()
    });
    return;
  }

  // 2. 处理 partialResult (seq: 3, 执行中) - 流式更新
  if (data.partialResult) {
    const details = data.partialResult.details || {};
    const content = data.partialResult.content || [];

    if (activeToolCalls[runId] !== undefined) {
      const msgIndex = activeToolCalls[runId];
      if (messages[msgIndex] && messages[msgIndex].role === 'tool') {
        const toolContent = messages[msgIndex].content;

        // 更新状态
        toolContent.status = details.status || 'running';
        toolContent.pid = details.pid || toolContent.pid;
        toolContent.cwd = details.cwd || toolContent.cwd;

        // 流式输出：使用 tail 获取实时输出
        if (details.tail) {
          toolContent.output = details.tail;
        }

        // 如果有命令内容
        const command = extractCommandFromContent(content);
        if (command) toolContent.command = command;
      }
    }
    return;
  }

  // 3. 处理最终 result (seq: 4, 完成)
  if (data.result) {
    const details = data.result.details || {};
    const content = data.result.content || [];

    // 提取完整结果
    const resultText = details.aggregated || extractTextFromContent(content);

    if (activeToolCalls[runId] !== undefined) {
      const msgIndex = activeToolCalls[runId];
      if (messages[msgIndex] && messages[msgIndex].role === 'tool') {
        const toolContent = messages[msgIndex].content;

        toolContent.status = 'completed';
        toolContent.output = resultText;
        toolContent.exitCode = details.exitCode;
        toolContent.duration = details.durationMs;

        delete activeToolCalls[runId]; // 清理
      }
    } else {
      // 如果没有找到之前的消息，创建新的
      addMessage('tool', {
        name: '命令执行',
        status: 'completed',
        command: '',
        output: resultText,
        cwd: details.cwd,
        exitCode: details.exitCode,
        duration: details.durationMs
      });
    }
  }
};

// 从 content 数组中提取命令
const extractCommandFromContent = (content) => {
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (item.type === 'text' && item.text) {
      return item.text;
    }
  }
  return '';
};

// 从 content 数组中提取文本结果
const extractTextFromContent = (content) => {
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item.type === 'text' && item.text)
    .map(item => item.text)
    .join('\n');
};

// 渲染 Markdown
const renderMarkdown = (text) => {
  if (typeof text !== 'string') return '';
  return marked.parse(text);
};

const scrollToBottom = () => {
  nextTick(() => {
    if (messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight;
    }
  });
};

// --- 生命周期 ---
onMounted(() => {
  connectWebSocket();
});

onUnmounted(() => {
  disconnectWebSocket();
});
</script>

<style scoped>
/* 容器样式 */
.chat-container {
  width: 100%;
  max-width: 600px;
  height: 80vh;
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e0e0e0;
}

/* 头部 */
.chat-header {
  padding: 15px 20px;
  background: #f8f9fa;
  border-bottom: 1px solid #eee;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.chat-header h2 {
  margin: 0;
  font-size: 1.2rem;
  color: #333;
}
.status-indicator {
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  background: #eee;
  color: #666;
}
.status-indicator.connected {
  background: #e6f4ea;
  color: #1e8e3e;
}
.status-indicator.connecting {
  background: #e8f0fe;
  color: #1967d2;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

/* 消息列表 */
.message-list {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 15px;
}
.empty-state {
  text-align: center;
  color: #999;
  margin-top: 50px;
}
.hint {
  font-size: 0.8rem;
  margin-top: 5px;
  opacity: 0.7;
}

/* 消息气泡 */
.message-item {
  display: flex;
  gap: 10px;
  max-width: 85%;
}
.message-item.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.message-item.system {
  align-self: center;
  max-width: 100%;
  justify-content: center;
  font-size: 0.85rem;
  color: #888;
  font-style: italic;
}
.message-item.ai.thinking .bubble {
  background: #f0f0f0;
  color: #666;
  font-style: italic;
}

.avatar {
  font-size: 1.5rem;
  line-height: 1;
}

.bubble {
  padding: 10px 14px;
  border-radius: 12px;
  position: relative;
  word-wrap: break-word;
}
.message-item.user .bubble {
  background: #1967d2;
  color: white;
  border-bottom-right-radius: 2px;
}
.message-item.ai .bubble {
  background: #f1f3f4;
  color: #333;
  border-bottom-left-radius: 2px;
}
.timestamp {
  font-size: 0.7rem;
  margin-top: 4px;
  opacity: 0.7;
  text-align: right;
}

/* 输入区 */
.input-area {
  padding: 15px;
  background: #f8f9fa;
  border-top: 1px solid #eee;
  display: flex;
  gap: 10px;
}
.chat-input {
  flex: 1;
  padding: 10px 15px;
  border: 1px solid #ddd;
  border-radius: 20px;
  outline: none;
  transition: border-color 0.2s;
}
.chat-input:focus {
  border-color: #1967d2;
}
.send-btn {
  padding: 0 20px;
  background: #1967d2;
  color: white;
  border: none;
  border-radius: 20px;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.2s;
}
.send-btn:hover:not(:disabled) {
  background: #1557b0;
}
.send-btn:disabled {
  background: #ccc;
  cursor: not-allowed;
}
.control-btn {
  padding: 0 15px;
  background: transparent;
  border: 1px solid #ccc;
  border-radius: 20px;
  cursor: pointer;
  color: #666;
  font-size: 0.9rem;
}
.control-btn:hover {
  background: #eee;
}

/* 工具调用卡片样式 */
.tool-card {
  min-width: 280px;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid #e0e0e0;
}

.tool-icon {
  font-size: 1.2rem;
}

.tool-name {
  font-weight: 600;
  color: #333;
  flex: 1;
  font-size: 0.95rem;
}

.tool-status {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 5px;
}

.tool-status.starting {
  background: #e3f2fd;
  color: #1976d2;
}

.tool-status.running {
  background: #fff3e0;
  color: #f57c00;
}

.tool-status.completed {
  background: #e8f5e9;
  color: #388e3c;
}

.status-running {
  display: flex;
  align-items: center;
  gap: 6px;
}

.spinner {
  width: 10px;
  height: 10px;
  border: 2px solid #f57c00;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.tool-command {
  background: #f8f9fa;
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 10px;
  border-left: 3px solid #1967d2;
}

.command-label {
  font-size: 0.7rem;
  color: #666;
  margin-bottom: 4px;
  font-weight: 500;
}

.tool-command code {
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 0.85rem;
  color: #d63384;
  word-break: break-all;
}

.tool-info {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 0.8rem;
  color: #666;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tool-output {
  margin-top: 10px;
}

.output-label {
  font-size: 0.75rem;
  color: #555;
  margin-bottom: 6px;
  font-weight: 500;
}

.output-content {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px;
  border-radius: 8px;
  font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
  font-size: 0.85rem;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.5;
}

.tool-meta {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #eee;
  font-size: 0.75rem;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.meta-item.success {
  color: #388e3c;
  font-weight: 500;
}

.meta-item.error {
  color: #d32f2f;
  font-weight: 500;
}

/* Markdown 渲染样式 */
.markdown-body {
  line-height: 1.6;
}

.markdown-body p {
  margin: 0 0 8px 0;
}

.markdown-body p:last-child {
  margin-bottom: 0;
}

.markdown-body code {
  background: rgba(0, 0, 0, 0.06);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 0.9em;
}

.message-item.user .markdown-body code {
  background: rgba(255, 255, 255, 0.2);
}

.markdown-body pre {
  background: #24292e;
  color: #f6f8fa;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 8px 0;
}

.markdown-body pre code {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: 0.85rem;
  line-height: 1.5;
}

.markdown-body ul, .markdown-body ol {
  margin: 8px 0;
  padding-left: 20px;
}

.markdown-body li {
  margin: 4px 0;
}

.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin: 12px 0 8px 0;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-body h1 { font-size: 1.3em; }
.markdown-body h2 { font-size: 1.2em; }
.markdown-body h3 { font-size: 1.1em; }

.markdown-body blockquote {
  border-left: 4px solid #dfe2e5;
  padding-left: 12px;
  margin: 8px 0;
  color: #6a737d;
}

.markdown-body table {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
}

.markdown-body th, .markdown-body td {
  border: 1px solid #dfe2e5;
  padding: 6px 12px;
}

.markdown-body th {
  background: #f6f8fa;
  font-weight: 600;
}

.markdown-body a {
  color: #1967d2;
  text-decoration: none;
}

.markdown-body a:hover {
  text-decoration: underline;
}
</style>