/**
 * Payout history service refactored to read from PostgreSQL database (#321).
 */

import { getDataSource } from "./database.js";
import { TransactionRecord } from "../entities/Transaction.js";
import { logger } from "./logger.js";
import { Like, type SelectQueryBuilder } from "typeorm";
import type { TransactionCursor } from "../lib/keyset-cursor.js";

export interface PayoutRecord {
  id: string;
  roundId: string;
  recipient: string;
  amount: string;
  token: string;
  timestamp: number;
  txHash: string;
  status: 'pending' | 'completed' | 'failed';
}

export interface PayoutHistoryIndex {
  getPayouts(filters?: PayoutFilters): Promise<PayoutRecord[]>;
  getPayoutsWithCount(filters?: PayoutFilters): Promise<{ records: PayoutRecord[]; total: number }>;
  /** One keyset/offset page plus the metadata needed to request the next one (#1259). */
  getPayoutsPage(filters?: PayoutPageFilters): Promise<PayoutPage>;
  getPayoutById(id: string): Promise<PayoutRecord | null>;
  getPayoutByTxHash(txHash: string): Promise<PayoutRecord | null>;
  getPayoutsByRound(roundId: string): Promise<PayoutRecord[]>;
  getPayoutsByRecipient(recipient: string): Promise<PayoutRecord[]>;
  searchPayouts(query: string): Promise<PayoutRecord[]>;
  /**
   * Walks all payouts matching `filters` in fixed-size batches, for export
   * flows that must not hold an unbounded result set in memory (#1332).
   *
   * Uses the same skip/take pagination as `getPayouts`, so it inherits the
   * usual caveat of offset pagination under concurrent writes (a row
   * inserted or removed mid-walk can shift later pages). That tradeoff is
   * already accepted elsewhere in this service; a keyset cursor would avoid
   * it but is a larger change than this iterator is meant to be.
   */
  iteratePayouts(
    filters?: PayoutFilters,
    batchSize?: number,
  ): AsyncGenerator<PayoutRecord[], void, void>;
  reindex(): Promise<void>;
  backfill(fromRound?: number): Promise<void>;
  /** Release in-memory resources. Call on graceful shutdown. */
  destroy(): void;
}

export interface PayoutFilters {
  startDate?: number;
  endDate?: number;
  recipient?: string;
  status?: 'pending' | 'completed' | 'failed';
  limit?: number;
  offset?: number;
}

export interface PayoutPageFilters extends PayoutFilters {
  /**
   * Continue after this row. When present it takes precedence over `offset`:
   * a keyset page must not skip rows, and mixing the two would make the
   * result depend on how many rows were inserted since the cursor was issued.
   */
  cursor?: TransactionCursor;
}

export interface PayoutPage {
  records: PayoutRecord[];
  /** Total rows matching the filters, ignoring the cursor and page window. */
  total: number;
  /** True when at least one more row follows this page. */
  hasMore: boolean;
}

function applyPayoutFilters(
  query: SelectQueryBuilder<TransactionRecord>,
  filters: PayoutFilters | undefined,
): void {
  if (filters?.recipient) {
    query.andWhere("transaction.recipient = :recipient", { recipient: filters.recipient });
  }
  if (filters?.status) {
    query.andWhere("transaction.status = :status", { status: filters.status });
  }
  if (filters?.startDate !== undefined) {
    query.andWhere("transaction.timestamp >= :startDate", { startDate: filters.startDate });
  }
  if (filters?.endDate !== undefined) {
    query.andWhere("transaction.timestamp <= :endDate", { endDate: filters.endDate });
  }
}

/**
 * `timestamp` alone is not a total order: two payouts can share a second.
 * `id` is the tie-breaker, and the keyset cursor uses the same pair, so a
 * row can never be returned twice or skipped between pages.
 */
function applyStableOrder(query: SelectQueryBuilder<TransactionRecord>): void {
  query.orderBy("transaction.timestamp", "DESC").addOrderBy("transaction.id", "DESC");
}

export interface PayoutIndexConfig {
  storageFile: string;
  reindexInterval: number;
  maxCacheSize: number;
}

export function createPayoutHistoryService(_config?: Partial<PayoutIndexConfig>): PayoutHistoryIndex {
  return {
    async getPayouts(filters) {
      try {
        const repo = getDataSource().getRepository(TransactionRecord);
        const query = repo.createQueryBuilder("transaction");

        applyPayoutFilters(query, filters);
        applyStableOrder(query);

        if (filters?.offset !== undefined) {
          query.skip(filters.offset);
        }
        if (filters?.limit !== undefined) {
          query.take(filters.limit);
        }

        const records = await query.getMany();
        return records as PayoutRecord[];
      } catch (error) {
        logger.error("Error fetching payouts from database", { error });
        return [];
      }
    },

    async getPayoutsWithCount(filters?: PayoutFilters) {
      try {
        const repo = getDataSource().getRepository(TransactionRecord);
        const query = repo.createQueryBuilder("transaction");

        applyPayoutFilters(query, filters);
        applyStableOrder(query);

        if (filters?.offset !== undefined) {
          query.skip(filters.offset);
        }
        if (filters?.limit !== undefined) {
          query.take(filters.limit);
        }

        const [records, total] = await query.getManyAndCount();
        return { records: records as PayoutRecord[], total };
      } catch (error) {
        logger.error("Error fetching payouts with count from database", { error });
        return { records: [], total: 0 };
      }
    },

    async getPayoutsPage(filters?: PayoutPageFilters) {
      const limit = filters?.limit ?? 20;

      try {
        const repo = getDataSource().getRepository(TransactionRecord);

        // `total` describes the whole filtered set, not the remainder after
        // the cursor, so the count query deliberately omits cursor/offset.
        const countQuery = repo.createQueryBuilder("transaction");
        applyPayoutFilters(countQuery, filters);
        const total = await countQuery.getCount();

        const pageQuery = repo.createQueryBuilder("transaction");
        applyPayoutFilters(pageQuery, filters);
        applyStableOrder(pageQuery);

        if (filters?.cursor) {
          pageQuery.andWhere(
            `(
              transaction.timestamp < :cursorTimestamp
              OR (transaction.timestamp = :cursorTimestamp AND transaction.id < :cursorId)
            )`,
            {
              cursorTimestamp: filters.cursor.timestamp,
              cursorId: filters.cursor.id,
            },
          );
        } else if (filters?.offset !== undefined && filters.offset > 0) {
          pageQuery.skip(filters.offset);
        }

        // Fetch one extra row to learn whether another page exists without a
        // second count query, then discard it before responding.
        pageQuery.take(limit + 1);
        const rows = (await pageQuery.getMany()) as PayoutRecord[];
        const hasMore = rows.length > limit;
        const records = hasMore ? rows.slice(0, limit) : rows;

        return { records, total, hasMore };
      } catch (error) {
        logger.error("Error fetching payouts page from database", { error });
        return { records: [], total: 0, hasMore: false };
      }
    },

    async getPayoutById(id) {
      try {
        const repo = getDataSource().getRepository(TransactionRecord);
        const record = await repo.findOneBy({ id });
        return (record as PayoutRecord) ?? null;
      } catch (error) {
        logger.error("Error fetching payout by ID", { id, error });
        return null;
      }
    },

    async getPayoutByTxHash(txHash) {
      const repo = getDataSource().getRepository(TransactionRecord);
      return repo.findOneBy({ txHash });
    },

    async getPayoutsByRound(roundId) {
      try {
        const repo = getDataSource().getRepository(TransactionRecord);
        const records = await repo.findBy({ roundId });
        return records as PayoutRecord[];
      } catch (error) {
        logger.error("Error fetching payouts by round", { roundId, error });
        throw error;
      }
    },

    async getPayoutsByRecipient(recipient) {
      return this.getPayouts({ recipient });
    },

    async searchPayouts(query) {
      try {
        const repo = getDataSource().getRepository(TransactionRecord);
        const records = await repo.find({
          where: [
            { recipient: Like(`%${query}%`) },
            { txHash: Like(`%${query}%`) },
            { roundId: Like(`%${query}%`) }
          ]
        });
        return records as PayoutRecord[];
      } catch (error) {
        logger.error("Error searching payouts", { query, error });
        return [];
      }
    },

    async *iteratePayouts(filters, batchSize = 500) {
      const startOffset = filters?.offset ?? 0;
      let offset = startOffset;

      while (true) {
        try {
          const repo = getDataSource().getRepository(TransactionRecord);
          const query = repo.createQueryBuilder("transaction");

          if (filters?.recipient) {
            query.andWhere("transaction.recipient = :recipient", { recipient: filters.recipient });
          }
          if (filters?.status) {
            query.andWhere("transaction.status = :status", { status: filters.status });
          }
          if (filters?.startDate !== undefined) {
            query.andWhere("transaction.timestamp >= :startDate", { startDate: filters.startDate });
          }
          if (filters?.endDate !== undefined) {
            query.andWhere("transaction.timestamp <= :endDate", { endDate: filters.endDate });
          }

          // Secondary sort by id: timestamps can collide across records, and
          // an unstable order between batches can duplicate or skip rows.
          query.orderBy("transaction.timestamp", "DESC").addOrderBy("transaction.id", "ASC");
          query.skip(offset).take(batchSize);

          const batch = (await query.getMany()) as PayoutRecord[];
          if (batch.length === 0) {
            return;
          }

          yield batch;

          if (batch.length < batchSize) {
            return;
          }
          offset += batch.length;
        } catch (error) {
          logger.error("Error iterating payouts", { offset, error });
          return;
        }
      }
    },

    async reindex() {
      logger.info("Reindexing database payout history...");
    },

    async backfill(fromRound) {
      logger.info(`Backfilling from round ${fromRound ?? 0}`);
    },

    destroy() {
      // Database connection lifetime is managed globally. No-op.
    }
  };
}
