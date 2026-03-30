import crypto from 'crypto';
import http from 'http';
import { WebClient } from '@slack/web-api';
import { readEnvFile } from '../env.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import type { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';

const SLACK_PREFIX = 'slack:';
const PORT = parseInt(process.env.SLACK_PORT || '3100', 10);

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const fiveMinutes = 5 * 60;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > fiveMinutes) {
    return false;
  }
  const basestring = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac('sha256', signingSecret)
    .update(basestring)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(`v0=${hmac}`),
    Buffer.from(signature),
  );
}

class SlackChannel implements Channel {
  name = 'slack';
  private client: WebClient;
  private signingSecret: string;
  private botUserId = '';
  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private connected = false;
  // Track the latest message ts per channel for reaction management
  private pendingReactions = new Map<string, string>(); // jid -> message ts
  private pendingThreads = new Map<string, string>(); // jid -> thread_ts to reply in

  constructor(token: string, signingSecret: string, opts: ChannelOpts) {
    this.client = new WebClient(token);
    this.signingSecret = signingSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const auth = await this.client.auth.test();
    this.botUserId = auth.user_id as string;
    logger.info({ botUserId: this.botUserId }, 'Slack bot authenticated');

    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/slack/events') {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const timestamp = req.headers['x-slack-request-timestamp'] as string;
        const signature = req.headers['x-slack-signature'] as string;

        if (
          !timestamp ||
          !signature ||
          !verifySlackSignature(this.signingSecret, timestamp, body, signature)
        ) {
          logger.warn('Slack signature verification failed');
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        const payload = JSON.parse(body);

        if (payload.type === 'url_verification') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(payload.challenge);
          return;
        }

        res.writeHead(200);
        res.end();

        if (payload.type === 'event_callback') {
          this.handleEvent(payload.event).catch((err) =>
            logger.error({ err }, 'Error handling Slack event'),
          );
        }
      });
    });

    this.server.listen(PORT, () => {
      this.connected = true;
      logger.info({ port: PORT }, 'Slack webhook server listening');
    });
  }

  private async handleEvent(event: any): Promise<void> {
    if (event.type !== 'message') return;
    if (event.subtype) return;
    if (event.bot_id) return;
    if (event.user === this.botUserId) return;

    const chatJid = `${SLACK_PREFIX}${event.channel}`;
    const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();

    // Add eyes reaction immediately
    try {
      await this.client.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: 'eyes',
      });
      this.pendingReactions.set(chatJid, event.ts);
      if (event.thread_ts) {
        this.pendingThreads.set(chatJid, event.thread_ts);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to add eyes reaction');
    }

    let senderName = event.user;
    try {
      const userInfo = await this.client.users.info({ user: event.user });
      senderName =
        userInfo.user?.real_name || userInfo.user?.name || event.user;
    } catch {}

    let channelName = event.channel;
    try {
      const info = await this.client.conversations.info({
        channel: event.channel,
      });
      channelName = info.channel?.name || event.channel;
    } catch {}
    this.opts.onChatMetadata(chatJid, timestamp, channelName, 'slack', true);

    const msg: NewMessage = {
      id: event.ts,
      chat_jid: chatJid,
      sender: event.user,
      sender_name: senderName,
      content: event.text || '',
      timestamp,
      is_from_me: false,
      is_bot_message: false,
      thread_id: event.thread_ts || undefined,
    };

    this.opts.onMessage(chatJid, msg);
  }

  private async removeEyesReaction(jid: string): Promise<void> {
    const messageTs = this.pendingReactions.get(jid);
    if (!messageTs) return;
    const channelId = jid.replace(SLACK_PREFIX, '');
    try {
      await this.client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      });
    } catch (err) {
      logger.debug({ err }, 'Failed to remove eyes reaction');
    }
    this.pendingReactions.delete(jid);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Remove eyes reaction on first response
    await this.removeEyesReaction(jid);

    const channelId = jid.replace(SLACK_PREFIX, '');
    const threadTs = this.pendingThreads.get(jid);
    this.pendingThreads.delete(jid);

    const maxLen = 3900;
    const parts =
      text.length <= maxLen
        ? [text]
        : text.match(new RegExp(`[\\s\\S]{1,${maxLen}}`, 'g')) || [text];

    for (const part of parts) {
      await this.client.chat.postMessage({
        channel: channelId,
        text: part,
        thread_ts: threadTs,
        unfurl_links: false,
      });
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Eyes reaction is managed directly: added on message receipt,
    // removed on first sendMessage. setTyping is a no-op.
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(SLACK_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
  const token = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN;
  const signingSecret =
    process.env.SLACK_SIGNING_SECRET || env.SLACK_SIGNING_SECRET;

  if (!token || !signingSecret) {
    return null;
  }

  return new SlackChannel(token, signingSecret, opts);
});
