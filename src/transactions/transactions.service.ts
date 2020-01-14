import { Transaction } from './transaction.entity';
import { In, LessThan, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Injectable } from '@nestjs/common';
import { TransactionsFilterDto } from './dto/transactions-filter.dto';
import { TransactionType } from './enums/transaction-type.enum';
import { TransactionFilterDto } from './dto/transaction-filter.dto';
import { TransactionState } from './enums/transaction-state.enum';
import { ConfigService, InjectConfig } from 'nestjs-config';
import { BigNumber } from 'bignumber.js';
import { InjectQueue } from 'nest-bull';
import { Queue } from 'bull';
import * as groupBy from 'lodash.groupby';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectConfig()
    private readonly config: ConfigService,
    @InjectRepository(Transaction)
    protected readonly repo: Repository<Transaction>,
    @InjectQueue('transactions')
    protected readonly txQueue: Queue,
  ) {
  }

  find(dto: TransactionsFilterDto): Promise<Transaction[]> {
    const builder = this.repo.createQueryBuilder()
      .where({
        asset: dto.asset_code,
      });

    if (dto.kind) {
      if (dto.kind === TransactionType.deposit) {
        builder.andWhere('Transaction.addressOut = :account', {account: dto.account});
      } else {
        builder.andWhere('Transaction.addressIn = :account', {account: dto.account});
      }
    } else {
      builder.andWhere(
        'Transaction.addressIn = :account OR Transaction.addressOut = :account',
        {account: dto.account},
      );
    }
    if (dto.paging_id) {
      builder.andWhere('Transaction.paging < :paging', {paging: dto.paging_id});
    }
    if (dto.no_older_than) {
      builder.andWhere('Transaction.createdAt > :date', {date: dto.no_older_than});
    }
    builder.orderBy('id', 'DESC');
    // default limit 50, max limit 500
    const limit = dto.limit || 50;
    builder.limit(Math.min(limit, 500));

    return builder.getMany();
  }

  findOne(dto: TransactionFilterDto): Promise<Transaction> {
    const builder = this.repo.createQueryBuilder();
    if (dto.id) {
      builder.where('Transaction.uuid = :id', { id: dto.id });
    } else if (dto.stellar_transaction_id) {
      builder.where('Transaction.txIn = :txId AND Transaction.type = :type',
        { txId: dto.stellar_transaction_id, type: TransactionType.withdrawal });
      builder.orWhere('Transaction.txOut = :txId AND Transaction.type = :type',
        { txId: dto.stellar_transaction_id, type: TransactionType.deposit });
    } else if (dto.external_transaction_id) {
      builder.where('Transaction.txIn = :txId AND Transaction.type = :type',
        { txId: dto.stellar_transaction_id, type: TransactionType.deposit });
      builder.orWhere('Transaction.txOut = :txId AND Transaction.type = :type',
        { txId: dto.stellar_transaction_id, type: TransactionType.withdrawal });
    }
    builder.limit(1);

    return builder.getOne();
  }

  async save(entity: Transaction) {
    try {
      return await this.repo.save(entity);
    } catch (err) {
      if (err.message.includes('duplicate')) {
        // if already exists - just update the state
        return this.repo.update({
          txIn: entity.txIn,
          txInIndex: entity.txInIndex,
          state: In([TransactionState.pending_external, TransactionState.pending_trust]),
        }, {
          state: entity.state,
        });
      } else {
        throw err;
      }
    }
  }

  updateState(entity: { channel: string, sequence: string }, fromState: TransactionState, toState: TransactionState) {
    return this.repo.update({
      channel: entity.channel,
      sequence: entity.sequence,
      state: fromState,
    }, {
      state: toState,
    });
  }

  async enqueuePendingWithdrawals(asset: string) {
    const assetConfig = this.config.get('assets').getAssetConfig(asset);
    if (!assetConfig.withdrawalBatching) {
      return [];
    }
    const sequence = new BigNumber(new Date().getTime() - 5000).dividedToIntegerBy(assetConfig.withdrawalBatching);

    const pendingWithdrawals = await this.repo.find({
      type: TransactionType.withdrawal,
      asset,
      state: In([TransactionState.pending_anchor, TransactionState.error]),
      sequence: LessThan(sequence.toString(10)),
    });
    if (pendingWithdrawals.length) {
      const groups = groupBy(pendingWithdrawals, 'sequence');
      for (const group of Object.values(groups)) {
        await this.txQueue.add({ txs: group }, {
          attempts: 10,
          backoff: {
            type: 'exponential',
          },
          ...this.config.get('queue').defaultJobOptions,
        });
      }
    }
  }
}