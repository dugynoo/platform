//
// Copyright © 2025 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import postgres from 'postgres'
import { AccountUuid, Ref, Space, WorkspaceUuid } from '@hcengineering/core'
import { ActivityMessage } from '@hcengineering/activity'

import config from './config'
import {
  ChannelId,
  ChannelRecord,
  ForumTopicKind,
  ForumTopicRecord,
  MessageRecord,
  OtpRecord,
  ReplyRecord
} from './types'

export async function getDb (): Promise<PostgresDB> {
  const sql = postgres(config.DbUrl, {
    connection: {
      application_name: config.ServiceId
    },
    fetch_types: true,
    prepare: true
  })

  return await PostgresDB.create(sql)
}

const otpTable = 'telegram_bot.otp'
const messagesTable = 'telegram_bot.messages'
const channelsTable = 'telegram_bot.channels'
const repliesTable = 'telegram_bot.replies'
const forumTopicsTable = 'telegram_bot.forum_topics'
const forumTopicsCleanupTable = 'telegram_bot.forum_topics_cleanup'

type DBFlavor = 'cockroach' | 'postgres' | 'unknown'

async function getDbFlavor (client: postgres.Sql): Promise<DBFlavor> {
  const [{ version }] = await client`SELECT version()`

  // CockroachDB's string contains "Cockroach" (case-insensitive)
  if (/cockroach/i.test(version)) {
    return 'cockroach'
  }

  // Anything else that looks like a PostgreSQL version string
  if (/postgresql/i.test(version)) {
    return 'postgres'
  }

  // Fallback
  return 'unknown'
}

export class PostgresDB {
  constructor (private readonly client: postgres.Sql) {}

  static async create (client: postgres.Sql): Promise<PostgresDB> {
    await this.init(client)
    return new PostgresDB(client)
  }

  static async init (client: postgres.Sql): Promise<void> {
    const flavor = await getDbFlavor(client)

    // Use appropriate syntax for rowid based on database flavor
    const rowidDefinition =
      flavor === 'postgres' ? 'rowid BIGINT GENERATED ALWAYS AS IDENTITY' : 'rowid INT8 NOT NULL DEFAULT unique_rowid()'

    const sql = `
        CREATE SCHEMA IF NOT EXISTS telegram_bot;
        
        CREATE TABLE IF NOT EXISTS ${otpTable} (
          telegram_id INT8 NOT NULL,
          telegram_username TEXT NOT NULL,
          code VARCHAR(255) NOT NULL,
          expires TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (code)
        );
        
        CREATE TABLE IF NOT EXISTS ${messagesTable} (
          message_id VARCHAR(255) NOT NULL,
          workspace UUID NOT NULL,
          account UUID NOT NULL,
          telegram_message_id INT8 NOT NULL,
          PRIMARY KEY (workspace, account, message_id)
        );

        CREATE TABLE IF NOT EXISTS ${channelsTable} (
          ${rowidDefinition},
          workspace UUID NOT NULL,
          _id VARCHAR(255) NOT NULL,
          _class VARCHAR(255) NOT NULL,
          name TEXT NOT NULL,
          account UUID NOT NULL,
          PRIMARY KEY (rowid),
          UNIQUE (workspace, _id, account)
        );

        CREATE TABLE IF NOT EXISTS ${repliesTable} (
          message_id VARCHAR(255) NOT NULL,
          telegram_user_id INT8 NOT NULL,
          reply_id INT8 NOT NULL,
          PRIMARY KEY (message_id, telegram_user_id, reply_id)
        );

        CREATE TABLE IF NOT EXISTS ${forumTopicsTable} (
          workspace UUID NOT NULL,
          account UUID NOT NULL,
          channel_id VARCHAR(255) NOT NULL,
          forum_chat_id INT8 NOT NULL,
          topic_id INT8 NOT NULL,
          kind TEXT NOT NULL DEFAULT 'chunter',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workspace, forum_chat_id, channel_id),
          UNIQUE (forum_chat_id, topic_id)
        );

        CREATE TABLE IF NOT EXISTS ${forumTopicsCleanupTable} (
          forum_chat_id INT8 NOT NULL,
          topic_id INT8 NOT NULL,
          enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (forum_chat_id, topic_id)
        );
  `

    await client.unsafe(sql)
    await this.migrateForumTopicsV4(client)
  }

  /**
   * v4 migration: forum_topics PK changes from (workspace, account, channel_id) to
   * (workspace, forum_chat_id, channel_id) so multiple users sharing a supergroup
   * reuse the same topic per Huly channel. Also adds the `kind` column.
   *
   * Idempotent: detects old PK shape via information_schema and skips if migrated.
   * Duplicate topic_ids encountered during dedup are enqueued into the cleanup table
   * so the worker can delete them from Telegram after startup.
   */
  private static async migrateForumTopicsV4 (client: postgres.Sql): Promise<void> {
    const kindCol = await client.unsafe(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'telegram_bot' AND table_name = 'forum_topics' AND column_name = 'kind'`
    )

    const pkAccount = await client.unsafe(
      `SELECT 1 FROM information_schema.key_column_usage
       WHERE table_schema = 'telegram_bot' AND table_name = 'forum_topics'
         AND constraint_name LIKE '%pkey%' AND column_name = 'account'`
    )

    if (kindCol.length > 0 && pkAccount.length === 0) return

    if (kindCol.length === 0) {
      await client.unsafe(
        `ALTER TABLE ${forumTopicsTable} ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chunter'`
      )
    }

    if (pkAccount.length > 0) {
      await client.unsafe(
        `INSERT INTO ${forumTopicsCleanupTable} (forum_chat_id, topic_id)
         SELECT t1.forum_chat_id, t1.topic_id FROM ${forumTopicsTable} t1
         WHERE EXISTS (
           SELECT 1 FROM ${forumTopicsTable} t2
           WHERE t2.created_at < t1.created_at
             AND t2.workspace = t1.workspace
             AND t2.forum_chat_id = t1.forum_chat_id
             AND t2.channel_id = t1.channel_id
         )
         ON CONFLICT DO NOTHING`
      )

      await client.unsafe(
        `DELETE FROM ${forumTopicsTable} t1 USING ${forumTopicsTable} t2
         WHERE t1.created_at > t2.created_at
           AND t1.workspace = t2.workspace
           AND t1.forum_chat_id = t2.forum_chat_id
           AND t1.channel_id = t2.channel_id`
      )

      await client.unsafe(
        `ALTER TABLE ${forumTopicsTable} ALTER PRIMARY KEY USING COLUMNS (workspace, forum_chat_id, channel_id)`
      )
    }
  }

  async insertOtp (otp: OtpRecord): Promise<void> {
    const sql = `
      INSERT INTO ${otpTable} (telegram_id, telegram_username, code, expires)
      VALUES ($1::int8, $2::text, $3::text, $4::timestamptz)`
    await this.client.unsafe(sql, [otp.telegramId, otp.telegramUsername ?? null, otp.code, otp.expires])
  }

  async getOtpByCode (code: string): Promise<OtpRecord | undefined> {
    const sql = `
      SELECT * FROM ${otpTable} WHERE code = $1::text LIMIT 1`
    const res = await this.client.unsafe(sql, [code])
    return res.map(toOtpRecord)[0]
  }

  async getOtpByTelegramId (telegramId: number): Promise<OtpRecord | undefined> {
    const sql = `
      SELECT * FROM ${otpTable} WHERE telegram_id = $1::int8 ORDER BY created_at DESC LIMIT 1`
    const res = await this.client.unsafe(sql, [telegramId])
    return res.map(toOtpRecord)[0]
  }

  async removeOtp (code: string): Promise<void> {
    const sql = `DELETE FROM ${otpTable} WHERE code = $1::text`
    await this.client.unsafe(sql, [code])
  }

  async removeExpiredOtp (): Promise<void> {
    const sql = `DELETE FROM ${otpTable} WHERE expires < NOW();`
    await this.client.unsafe(sql)
  }

  async getChannels (account: AccountUuid, workspace: WorkspaceUuid): Promise<ChannelRecord[]> {
    const sql = `
      SELECT * FROM ${channelsTable} WHERE account = $1::uuid AND workspace = $2::uuid ORDER BY name ASC`
    const res = await this.client.unsafe(sql, [account, workspace])
    return res.map(toChannelRecord)
  }

  async getChannel (account: AccountUuid, channelId: ChannelId): Promise<ChannelRecord | undefined> {
    const sql = `
      SELECT * FROM ${channelsTable} WHERE account = $1::uuid AND _id = $2::varchar`
    const res = await this.client.unsafe(sql, [account, channelId])
    return res.map(toChannelRecord)[0]
  }

  async insertChannel (records: Omit<ChannelRecord, 'rowId'>): Promise<void> {
    const sql = `
      INSERT INTO ${channelsTable} (
        workspace, account, _id, _class, name
      )
      VALUES ($1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::text)`
    await this.client.unsafe(sql, [records.workspace, records.account, records._id, records._class, records.name])
  }

  async removeChannels (ids: ChannelId[]): Promise<void> {
    const sql = `DELETE FROM ${channelsTable} WHERE rowid = ANY($1::int8[])`
    await this.client.unsafe(sql, [ids])
  }

  async updateChannelName (id: ChannelId, name: string): Promise<void> {
    const sql = `UPDATE ${channelsTable} SET name = $2::text WHERE rowid = $1::int8`
    await this.client.unsafe(sql, [id, name])
  }

  async insertMessage (record: MessageRecord): Promise<void> {
    const sql = `
      INSERT INTO ${messagesTable} (
        message_id, workspace, account, telegram_message_id
      )
      VALUES ($1::varchar, $2::uuid, $3::uuid, $4::int8)
      ON CONFLICT DO NOTHING`
    await this.client.unsafe(sql, [record.messageId, record.workspace, record.account, record.telegramMessageId])
  }

  async getMessageByRef (account: AccountUuid, messageId: Ref<ActivityMessage>): Promise<MessageRecord | undefined> {
    const sql = `
      SELECT * FROM ${messagesTable} WHERE account = $1::uuid AND message_id = $2::varchar LIMIT 1`
    const res = await this.client.unsafe(sql, [account, messageId])
    return res.map(toMessageRecord)[0]
  }

  async getMessageByTgId (account: AccountUuid, telegramId: number): Promise<MessageRecord | undefined> {
    const sql = `
      SELECT * FROM ${messagesTable} WHERE telegram_message_id = $1::int8 AND account = $2::uuid LIMIT 1`
    const res = await this.client.unsafe(sql, [telegramId, account])
    return res.map(toMessageRecord)[0]
  }

  async insertReply (record: ReplyRecord): Promise<void> {
    const sql = `
      INSERT INTO ${repliesTable} (
        message_id, telegram_user_id, reply_id
      )
      VALUES ($1::varchar, $2::int8, $3::int8)`
    await this.client.unsafe(sql, [record.messageId, record.telegramUserId, record.replyId])
  }

  async getReply (tgUserId: number, replyTo: number): Promise<ReplyRecord | undefined> {
    const sql = `
      SELECT * FROM ${repliesTable} WHERE telegram_user_id = $1::int8 AND reply_id = $2::int8 LIMIT 1`
    const res = await this.client.unsafe(sql, [tgUserId, replyTo])
    return res.map(toReplyRecord)[0]
  }

  async getForumTopic (
    workspace: WorkspaceUuid,
    forumChatId: number,
    channelId: Ref<Space>
  ): Promise<ForumTopicRecord | undefined> {
    const sql = `
      SELECT * FROM ${forumTopicsTable}
      WHERE workspace = $1::uuid AND forum_chat_id = $2::int8 AND channel_id = $3::varchar
      LIMIT 1`
    const res = await this.client.unsafe(sql, [workspace, forumChatId, channelId])
    return res.map(toForumTopicRecord)[0]
  }

  async insertForumTopic (record: Omit<ForumTopicRecord, 'createdAt'>): Promise<void> {
    const sql = `
      INSERT INTO ${forumTopicsTable} (
        workspace, account, channel_id, forum_chat_id, topic_id, kind
      )
      VALUES ($1::uuid, $2::uuid, $3::varchar, $4::int8, $5::int8, $6::text)
      ON CONFLICT (workspace, forum_chat_id, channel_id) DO NOTHING`
    await this.client.unsafe(sql, [
      record.workspace,
      record.account,
      record.channelId,
      record.forumChatId,
      record.topicId,
      record.kind
    ])
  }

  async getForumTopicByThread (forumChatId: number, topicId: number): Promise<ForumTopicRecord | undefined> {
    const sql = `
      SELECT * FROM ${forumTopicsTable}
      WHERE forum_chat_id = $1::int8 AND topic_id = $2::int8
      LIMIT 1`
    const res = await this.client.unsafe(sql, [forumChatId, topicId])
    return res.map(toForumTopicRecord)[0]
  }

  async listAllForumTopics (): Promise<ForumTopicRecord[]> {
    const res = await this.client.unsafe(`SELECT * FROM ${forumTopicsTable}`)
    return res.map(toForumTopicRecord)
  }

  async deleteForumTopic (
    workspace: WorkspaceUuid,
    forumChatId: number,
    channelId: Ref<Space>
  ): Promise<void> {
    const sql = `
      DELETE FROM ${forumTopicsTable}
      WHERE workspace = $1::uuid AND forum_chat_id = $2::int8 AND channel_id = $3::varchar`
    await this.client.unsafe(sql, [workspace, forumChatId, channelId])
  }

  async getCleanupPending (): Promise<Array<{ forumChatId: number, topicId: number }>> {
    const res = await this.client.unsafe(
      `SELECT forum_chat_id, topic_id FROM ${forumTopicsCleanupTable} ORDER BY enqueued_at ASC LIMIT 500`
    )
    return res.map((r: any) => ({ forumChatId: Number(r.forum_chat_id), topicId: Number(r.topic_id) }))
  }

  async removeCleanupPending (forumChatId: number, topicId: number): Promise<void> {
    await this.client.unsafe(
      `DELETE FROM ${forumTopicsCleanupTable} WHERE forum_chat_id = $1::int8 AND topic_id = $2::int8`,
      [forumChatId, topicId]
    )
  }

  async enqueueCleanup (forumChatId: number, topicId: number): Promise<void> {
    await this.client.unsafe(
      `INSERT INTO ${forumTopicsCleanupTable} (forum_chat_id, topic_id) VALUES ($1::int8, $2::int8) ON CONFLICT DO NOTHING`,
      [forumChatId, topicId]
    )
  }

  async close (): Promise<void> {
    await this.client.end({ timeout: 0 })
  }
}

function toOtpRecord (raw: any): OtpRecord {
  return {
    telegramId: Number(raw.telegram_id),
    telegramUsername: raw.telegram_username,
    code: raw.code,
    expires: new Date(raw.expires),
    createdAt: new Date(raw.created_at)
  }
}

function toChannelRecord (raw: any): ChannelRecord {
  return {
    rowId: String(raw.rowid) as ChannelId,
    workspace: raw.workspace,
    _id: raw._id,
    _class: raw._class,
    name: raw.name,
    account: raw.account
  }
}

function toReplyRecord (raw: any): ReplyRecord {
  return {
    messageId: raw.message_id,
    telegramUserId: Number(raw.telegram_user_id),
    replyId: Number(raw.reply_id)
  }
}

function toMessageRecord (raw: any): MessageRecord {
  return {
    messageId: raw.message_id,
    workspace: raw.workspace,
    account: raw.account,
    telegramMessageId: Number(raw.telegram_message_id)
  }
}

function toForumTopicRecord (raw: any): ForumTopicRecord {
  return {
    workspace: raw.workspace,
    account: raw.account,
    channelId: raw.channel_id,
    forumChatId: Number(raw.forum_chat_id),
    topicId: Number(raw.topic_id),
    kind: ((raw.kind as ForumTopicKind | undefined) ?? 'chunter'),
    createdAt: new Date(raw.created_at)
  }
}
