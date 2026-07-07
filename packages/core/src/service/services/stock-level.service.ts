import { Injectable } from '@nestjs/common';
import { ID } from '@vendure/common/lib/shared-types';
import { LockNotSupportedOnGivenDriverError } from 'typeorm';

import { RequestContext } from '../../api/common/request-context';
import { Instrument } from '../../common/instrument-decorator';
import { AvailableStock } from '../../config/catalog/stock-location-strategy';
import { ConfigService } from '../../config/config.service';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { ProductVariant } from '../../entity/product-variant/product-variant.entity';
import { StockLevel } from '../../entity/stock-level/stock-level.entity';

import { StockLocationService } from './stock-location.service';

/**
 * @description
 * The StockLevelService is responsible for managing the stock levels of ProductVariants.
 * Whenever you need to adjust the `stockOnHand` or `stockAllocated` for a ProductVariant,
 * you should use this service.
 *
 * @docsCategory services
 * @since 2.0.0
 */
@Injectable()
@Instrument()
export class StockLevelService {
    constructor(
        private connection: TransactionalConnection,
        private stockLocationService: StockLocationService,
        private configService: ConfigService,
    ) {}

    /**
     * @description
     * Returns the StockLevel for the given {@link ProductVariant} and {@link StockLocation}.
     */
    async getStockLevel(ctx: RequestContext, productVariantId: ID, stockLocationId: ID): Promise<StockLevel> {
        const stockLevel = await this.connection.getRepository(ctx, StockLevel).findOne({
            where: {
                productVariantId,
                stockLocationId,
            },
        });
        if (stockLevel) {
            return stockLevel;
        }
        return this.connection.getRepository(ctx, StockLevel).save(
            new StockLevel({
                productVariantId,
                stockLocationId,
                stockOnHand: 0,
                stockAllocated: 0,
            }),
        );
    }

    async getStockLevelsForVariant(ctx: RequestContext, productVariantId: ID): Promise<StockLevel[]> {
        return this.connection
            .getRepository(ctx, StockLevel)
            .createQueryBuilder('stockLevel')
            .leftJoinAndSelect('stockLevel.stockLocation', 'stockLocation')
            .leftJoin('stockLocation.channels', 'channel')
            .where('stockLevel.productVariantId = :productVariantId', { productVariantId })
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId })
            .getMany();
    }

    /**
     * @description
     * Returns the available stock (on hand and allocated) for the given {@link ProductVariant}. This is determined
     * by the configured {@link StockLocationStrategy}.
     */
    async getAvailableStock(ctx: RequestContext, productVariantId: ID): Promise<AvailableStock> {
        const { stockLocationStrategy } = this.configService.catalogOptions;
        const stockLevels = await this.connection.getRepository(ctx, StockLevel).find({
            where: {
                productVariantId,
            },
        });
        return stockLocationStrategy.getAvailableStock(ctx, productVariantId, stockLevels);
    }

    /**
     * @description
     * Updates the `stockOnHand` for the given {@link ProductVariant} and {@link StockLocation}.
     * The write is atomic: the row is locked before reading to prevent lost updates under concurrency.
     * When creating a new StockLevel the initial value is clamped at 0 so the row is never born negative.
     */
    async updateStockOnHandForLocation(
        ctx: RequestContext,
        productVariantId: ID,
        stockLocationId: ID,
        change: number,
    ) {
        await this.connection.withTransaction(ctx, async txCtx => {
            const repo = this.connection.getRepository(txCtx, StockLevel);
            let stockLevel: StockLevel | null;
            try {
                stockLevel = await repo
                    .createQueryBuilder('stockLevel')
                    .setLock('pessimistic_write')
                    .where('stockLevel.productVariantId = :productVariantId', { productVariantId })
                    .andWhere('stockLevel.stockLocationId = :stockLocationId', { stockLocationId })
                    .getOne();
            } catch (e) {
                if (!(e instanceof LockNotSupportedOnGivenDriverError)) {
                    throw e;
                }
                // SQLite serializes writes at the engine level — proceed without the lock
                stockLevel = await repo.findOne({ where: { productVariantId, stockLocationId } });
            }
            if (!stockLevel) {
                await repo.save(
                    new StockLevel({
                        productVariantId,
                        stockLocationId,
                        stockOnHand: Math.max(0, change),
                        stockAllocated: 0,
                    }),
                );
            } else {
                await repo.update(stockLevel.id, { stockOnHand: stockLevel.stockOnHand + change });
            }
        });
    }

    /**
     * @description
     * Updates the `stockAllocated` for the given {@link ProductVariant} and {@link StockLocation}.
     * The write is atomic: the row is locked before reading to prevent lost updates under concurrency.
     * `stockAllocated` is clamped at 0 so a release can never produce a negative value.
     */
    async updateStockAllocatedForLocation(
        ctx: RequestContext,
        productVariantId: ID,
        stockLocationId: ID,
        change: number,
    ) {
        await this.connection.withTransaction(ctx, async txCtx => {
            const repo = this.connection.getRepository(txCtx, StockLevel);
            let stockLevel: StockLevel | null;
            try {
                stockLevel = await repo
                    .createQueryBuilder('stockLevel')
                    .setLock('pessimistic_write')
                    .where('stockLevel.productVariantId = :productVariantId', { productVariantId })
                    .andWhere('stockLevel.stockLocationId = :stockLocationId', { stockLocationId })
                    .getOne();
            } catch (e) {
                if (!(e instanceof LockNotSupportedOnGivenDriverError)) {
                    throw e;
                }
                // SQLite serializes writes at the engine level — proceed without the lock
                stockLevel = await repo.findOne({ where: { productVariantId, stockLocationId } });
            }
            if (stockLevel) {
                await repo.update(stockLevel.id, {
                    stockAllocated: Math.max(0, stockLevel.stockAllocated + change),
                });
            }
        });
    }
}
