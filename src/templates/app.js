export const getServerDbTs = () => `
import { RedisClient } from '@devvit/public-api';

// Enforce types for WebSim records
export type WebSimRecord = {
  id: string;
  type: string;
  username: string;
  user_id?: string;
  avatar_url?: string;
  created_at: string;
  [key: string]: any;
};

export class WebSimDb {
  redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  private getKey(collection: string) {
    return \`websim:data:\${collection}\`;
  }

  async create(collection: string, data: any, user: any): Promise<WebSimRecord> {
    const record: WebSimRecord = {
      ...data,
      // Force authoritative user data from Reddit
      username: user.username || 'Anonymous',
      user_id: user.id,
      avatar_url: user.avatarUrl,
      created_at: new Date().toISOString(),
    };

    // Store in Redis Hash
    await this.redis.hSet(this.getKey(collection), {
      [record.id]: JSON.stringify(record)
    });
    
    return record;
  }

  async update(collection: string, data: any, user: any): Promise<WebSimRecord> {
    const key = this.getKey(collection);
    
    // Fetch existing to merge
    const existingStr = await this.redis.hGet(key, data.id);
    const existing = existingStr ? JSON.parse(existingStr) : {};

    const record = {
      ...existing,
      ...data,
      // Track updates
      updated_at: new Date().toISOString(),
      updated_by: user.username
    };

    await this.redis.hSet(key, {
      [record.id]: JSON.stringify(record)
    });

    return record;
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.redis.hDel(this.getKey(collection), [id]);
  }

  async getAll(collection: string): Promise<Record<string, string>> {
    const data = await this.redis.hGetAll(this.getKey(collection));
    return data || {};
  }
}
`;

export const getMainTsx = (title, webviewPath) => `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel, useAsync } from '@devvit/public-api';
import { WebSimDb } from './server/db';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    const [key, setKey] = useState(0);
    const db = new WebSimDb(context.redis);

    // Fetch Current User
    const { data: currentUser } = useAsync(async () => {
      if (!context.userId) return null;
      try {
        const user = await context.reddit.getUserById(context.userId);
        if (!user) return null;
        return {
          id: user.id,
          username: user.username,
          avatarUrl: user.snoovatarURL || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
        };
      } catch (e) {
        console.error('Error fetching user', e);
        return null;
      }
    });
    
    // Realtime Channel Bridge
    const channel = useChannel({
      name: 'websim_global',
      onMessage: (msg) => {
        context.ui.webView.postMessage('gameview', {
          type: 'WEBSIM_SOCKET_EVT',
          payload: msg
        });
      },
    });

    channel.subscribe();

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="gameview"
          url="${webviewPath}"
          width="100%"
          height="100%"
          key={key.toString()}
          onMessage={(msg) => {
            // 1. Handle Realtime Sends from WebView
            if (msg.type === 'WEBSIM_SOCKET_MSG') {
               const { type, payload, senderId } = msg.payload || {};

               // A. Identity Handshake
               if (type === 'auth_request') {
                  context.ui.webView.postMessage('gameview', {
                    type: 'WEBSIM_SOCKET_EVT',
                    payload: {
                        type: 'auth_user',
                        user: currentUser || { id: senderId, username: 'Guest', avatarUrl: '' }
                    }
                  });
                  return;
               }

               // B. Database Operations (Redis Bridge)
               if (type === 'db_op') {
                 // payload: { cmd: 'create'|'update'|'delete', collection: string, data: object }
                 (async () => {
                   try {
                     const user = currentUser || { id: 'anon', username: 'Anonymous', avatarUrl: '' };
                     let result = payload.data;

                     if (payload.cmd === 'create') {
                        result = await db.create(payload.collection, payload.data, user);
                     } else if (payload.cmd === 'update') {
                        result = await db.update(payload.collection, payload.data, user);
                     } else if (payload.cmd === 'delete') {
                        await db.delete(payload.collection, payload.data.id);
                     }
                     
                     // Broadcast to other clients
                     await channel.send({
                        type: 'db_sync',
                        collection: payload.collection,
                        op: { ...payload, data: result }
                     });
                   } catch(e) {
                     console.error('Redis DB Error:', e);
                   }
                 })();
                 return;
               }

               // C. Initial Data Load Request
               if (type === 'db_load') {
                  (async () => {
                    try {
                      const data = await db.getAll(payload.collection);
                      context.ui.webView.postMessage('gameview', {
                        type: 'WEBSIM_SOCKET_EVT',
                        payload: {
                          type: 'db_dump',
                          collection: payload.collection,
                          data: data 
                        }
                      });
                    } catch(e) {
                      console.error('Redis Load Error:', e);
                    }
                  })();
                  return;
               }

               // D. Standard Realtime Relay
               channel.send(msg.payload);
            }
            
            // 2. Handle Console Logs
            if (msg.type === 'console' && msg.args) {
              const prefix = '[Web]';
              const args = [prefix, ...(msg.args || [])];
              if (msg.level === 'error') console.error(...args);
              else if (msg.level === 'warn') console.warn(...args);
              else if (msg.level === 'info') console.log(...args);
              else console.log(...args);
            }
          }}
        />
        <vstack padding="medium" gap="medium">
            <button icon="refresh" onPress={() => setKey(k => k + 1)}>Reload Game</button>
            <text size="small" color="neutral-content-weak">Logs are piped to terminal</text>
        </vstack>
      </vstack>
    );
  },
});

Devvit.addMenuItem({
  label: 'Create ${title.replace(/'/g, "\\'")}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${title.replace(/'/g, "\\'")}',
        subredditName: subreddit.name,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle">
            <text size="large">Loading Game...</text>
          </vstack>
        ),
      });
      ui.showToast('Game created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;

