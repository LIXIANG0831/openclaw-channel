// extensions/websocket-channel/index.ts
// WebSocket Channel 插件实现
// 提供基于 WebSocket 的双向通信能力，支持 AI 回复和主动消息

/** WebSocket 连接实例 */
const WebSocketChannelConnection = {};

/** WebSocket 账户配置（运行时对象） */
const WebSocketChannelAccount = {};

// 存储所有活跃的 WebSocket 连接
const connections = new Map();

// 保存完整的 runtime（在 register 中设置）
let pluginRuntime = null;

const WebSocketChannel = {
  id: "websocket-channel",

  /** 通道元数据 */
  meta: {
    id: "websocket-channel",
    label: "Websocket Channel",
    selectionLabel: "Websocket Channel (Custom)",
    docsPath: "/channels/websocket-channel",
    blurb: "WebSocket based messaging channel.",
    aliases: ["ws"],
  },

  /** 通道能力定义 */
  capabilities: {
    chatTypes: ["direct", "group"],
    media: {
      maxSizeBytes: 10 * 1024 * 1024,
      supportedTypes: ["image/jpeg", "image/png", "video/mp4"],
    },
    supports: {
      threads: true,
      reactions: false,
      mentions: true,
    },
  },

  /** 配置 Schema 定义 */
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        config: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            wsUrl: { type: "string" },
            groupPolicy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
          },
          required: ["wsUrl"],
        },
      },
    },
    uiHints: {
      enabled: { label: "Enabled", description: "Enable WebSocket Channel" },
      config: { label: "Configuration", description: "WebSocket connection configuration" },
      "config.enabled": { label: "Enabled", description: "Enable this configuration" },
      "config.wsUrl": { label: "WebSocket URL", placeholder: "ws://localhost:8765/openclaw", help: "WebSocket server URL" },
      "config.groupPolicy": { label: "Group Policy", description: "Message policy for group chats" },
    },
  },

  /** 通道配置适配器 */
  config: {
    listAccountIds: (cfg) => ["default"],
    resolveAccount: (cfg, accountId) => {
      const channelCfg = cfg.channels?.["websocket-channel"];
      if (!channelCfg || !channelCfg.config) return undefined;
      const config = channelCfg.config;
      return {
        accountId: "default",
        wsUrl: config.wsUrl || "ws://localhost:8765/openclaw",
        enabled: config.enabled !== false,
        groupPolicy: config.groupPolicy || "open",
      };
    },
    isConfigured: async (account, cfg) => Boolean(account.wsUrl && account.wsUrl.trim() !== ""),
  },

  /** 状态管理适配器 */
  status: {
    /** 默认运行时状态模板 */
    defaultRuntime: {
      accountId: "default",
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      wsUrl: null,
      groupPolicy: null,
    },

    /** 构建通道摘要（用于 UI 显示） */
    buildChannelSummary: ({ snapshot }) => ({
      wsUrl: snapshot.wsUrl ?? null,
      connected: snapshot.connected ?? null,
      groupPolicy: snapshot.groupPolicy ?? null,
    }),

    /** 构建账户完整快照 */
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      groupPolicy: runtime?.groupPolicy ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  /** 出站消息适配器（主动消息） */
  outbound: {
    deliveryMode: "direct",

    sendText: async ({ to, text, accountId }) => {
      const conn = connections.get(accountId ?? "default");
      if (!conn || !conn.ws || conn.ws.readyState !== 1) return { ok: false, error: "No connection" };
      conn.ws.send(JSON.stringify({ type: "message", to, content: text }));
      return { ok: true };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const conn = connections.get(accountId ?? "default");
      if (!conn || !conn.ws || conn.ws.readyState !== 1) return { ok: false, error: "No connection" };
      conn.ws.send(JSON.stringify({ type: "media", to, content: text, mediaUrl }));
      return { ok: true };
    },
  },

  /** 网关适配器（长连接管理） */
  gateway: {
    startAccount: async (ctx) => {
      const { log, account, abortSignal, cfg } = ctx;
      log?.info(`[websocket-channel] Starting WebSocket Channel for ${account.accountId}`);
      const runtime = pluginRuntime;

      if (!runtime?.channel?.reply?.withReplyDispatcher) {
        log?.error("[websocket-channel] runtime.channel.reply API not available");
        throw new Error("Runtime API not available");
      }

      ctx.setStatus({
        accountId: account.accountId,
        wsUrl: account.wsUrl,
        running: true,
        connected: true,
        groupPolicy: account.groupPolicy || "open",
      });
      log?.info(`[websocket-channel] Status set: connected=true, running=true`);

      const WebSocketLib = await import("ws");
      const ws = new WebSocketLib.default(account.wsUrl);

      connections.set(account.accountId, { ws, accountId: account.accountId });

      // === 订阅工具调用事件 ===
      const unsubscribeAgentEvent = runtime.events.onAgentEvent((evt) => {
        // 只处理工具调用事件
        if (evt.stream !== "tool") return;

        const toolData = evt.data;
        log?.info(`[websocket-channel] Tool called: ${toolData?.tool}`);

        // 通过 WebSocket 发送给客户端
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: "tool_call",
            data: {
              tool: toolData?.tool,
              input: toolData?.input,
              result: toolData?.result,
              partialResult: toolData?.partialResult,
              runId: evt.runId,
              sessionKey: evt.sessionKey,
              seq: evt.seq,
            }
          }));
        }
      });
      // ===========================

      const connectionPromise = new Promise((resolve, reject) => {
        ws.on("open", () => {
          log?.info(`[websocket-channel] Connected to ${account.wsUrl}`);
        });

        ws.on("message", async (data) => {
          try {
            const rawData = data.toString();
            const eventData = JSON.parse(rawData);
            const innerData = eventData.data || {};

            const normalizedMessage = {
              id: `${eventData.source || "websocket"}-${Date.now()}`,
              channel: "websocket-channel",
              accountId: account.accountId,
              senderId: innerData.source || eventData.source || "unknown",
              senderName: innerData.source || eventData.source || "Unknown",
              text: innerData.content || innerData.text || "",
              timestamp: innerData.timestamp || Date.now(),
              isGroup: false,
              groupId: undefined,
              attachments: [],
              metadata: {},
            };

            log?.info(`[websocket-channel] Received: "${normalizedMessage.text}" from ${normalizedMessage.senderId}`);

            const route = runtime.channel.routing.resolveAgentRoute({
              cfg,
              channel: "websocket-channel",
              accountId: account.accountId,
              peer: { kind: "direct", id: normalizedMessage.senderId },
            });

            log?.info(`[websocket-channel] Route resolved sessionKey:${route.sessionKey}, accountId:${route.accountId}, matchedBy: ${route.matchedBy}`);

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
              Body: normalizedMessage.text,
              BodyForAgent: normalizedMessage.text,
              From: normalizedMessage.senderId,
              To: undefined,
              SessionKey: route.sessionKey,
              AccountId: route.accountId,
              ChatType: "direct",
              SenderName: normalizedMessage.senderName,
              SenderId: normalizedMessage.senderId,
              Provider: "websocket-channel",
              Surface: "websocket-channel",
              MessageSid: normalizedMessage.id,
              Timestamp: Date.now(),
            });

            const result = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg: cfg,
              dispatcherOptions: {
                deliver: async (payload, { kind }) => {
                  log?.info(`[websocket-channel] Delivering ${kind} reply via WebSocket...`);
                  const currentConn = connections.get(account.accountId);
                  if (!currentConn || !currentConn.ws || currentConn.ws.readyState !== 1) {
                    throw new Error("No WebSocket connection available");
                  }
                  currentConn.ws.send(JSON.stringify({ type: "reply", content: payload.text || "", kind }));
                },
                onError: (err, { kind }) => {
                  log?.error(`[websocket-channel] Delivery error for ${kind}: ${err.message || String(err)}`);
                },
              },
            });

            log?.info(`[websocket-channel] Message dispatched successfully`);
          } catch (err) {
            log?.error(`[websocket-channel] Failed to process message: ${err.message || String(err)}`);
          }
        });

        ws.on("error", (err) => {
          log?.error(`[websocket-channel] WebSocket error: ${err.message}`);
          connections.delete(account.accountId);
          reject(err);
        });

        ws.on("close", () => {
          log?.info(`[websocket-channel] Connection closed`);
          unsubscribeAgentEvent();
          connections.delete(account.accountId);
          resolve();
        });

        abortSignal.addEventListener("abort", () => {
          log?.info(`[websocket-channel] Abort requested`);
          unsubscribeAgentEvent();
          ws.close();
          resolve();
        });
      });

      await Promise.race([
        connectionPromise,
        new Promise((resolve) => { abortSignal.addEventListener("abort", () => resolve()); }),
      ]);

      connections.delete(account.accountId);
    },

    stopAccount: async (ctx) => {
      const { log, account } = ctx;
      log?.info(`[websocket-channel] Stopping WebSocket Channel for ${account.accountId}`);
      const conn = connections.get(account.accountId);
      if (conn) {
        conn.ws.close();
        connections.delete(account.accountId);
      }
    },
  },

  /** 安全策略适配器 */
  security: {
    getDmPolicy: (account) => account.dmPolicy ?? "open",
    getAllowFrom: (account) => account.allowFrom ?? [],
    checkGroupAccess: (account, groupId) => {
      const groups = account.groups ?? {};
      return "*" in groups || groupId in groups;
    },
  },
};

/**
 * 注册插件入口
 * @param api - 插件 API
 */
export default function register(api) {
  console.log("[websocket-channel] Registering WebSocket Channel plugin");
  pluginRuntime = api.runtime;
  api.registerChannel({ plugin: WebSocketChannel });
}
