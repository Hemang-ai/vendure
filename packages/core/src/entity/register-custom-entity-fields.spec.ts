import { getMetadataArgsStorage } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';

import { CustomFieldConfig } from '../config/custom-field/custom-field-types';
import { VendureConfig } from '../config/vendure-config';

import { registerCustomFieldsForEntity } from './register-custom-entity-fields';

class TestCustomFields {}
class RelatedEntity {}

describe('registerCustomFieldsForEntity()', () => {
    const metadata = getMetadataArgsStorage();
    const originalLengths = {
        columns: metadata.columns.length,
        indices: metadata.indices.length,
        relations: metadata.relations.length,
        joinColumns: metadata.joinColumns.length,
    };

    afterEach(() => {
        metadata.columns.splice(originalLengths.columns);
        metadata.indices.splice(originalLengths.indices);
        metadata.relations.splice(originalLengths.relations);
        metadata.joinColumns.splice(originalLengths.joinColumns);
    });

    it.each(['mysql', 'mariadb', 'postgres', 'sqlite'] as const)(
        'registers one non-unique scalar index for %s',
        dbEngine => {
            register(dbEngine, [{ name: 'reference', type: 'string', index: true }]);

            const indices = getTestIndices('reference');
            expect(indices).toHaveLength(1);
            expect(indices[0].unique).not.toBe(true);
        },
    );

    it.each(['mysql', 'mariadb', 'postgres', 'sqlite'] as const)(
        'does not duplicate a unique index for %s',
        dbEngine => {
            register(dbEngine, [{ name: 'reference', type: 'string', unique: true, index: true }]);

            const indices = getTestIndices('reference');
            if (dbEngine === 'mysql' || dbEngine === 'mariadb') {
                expect(indices).toHaveLength(1);
                expect(indices[0].unique).toBe(true);
            } else {
                expect(indices).toHaveLength(0);
            }
        },
    );

    it.each(['mysql', 'mariadb', 'postgres', 'sqlite'] as const)(
        'registers the index on a single relation property for %s',
        dbEngine => {
            register(dbEngine, [
                {
                    name: 'related',
                    type: 'relation',
                    entity: RelatedEntity,
                    index: true,
                },
            ]);

            const indices = getTestIndices('related');
            expect(indices).toHaveLength(1);
            expect(indices[0].unique).not.toBe(true);
        },
    );

    function register(
        dbEngine: VendureConfig['dbConnectionOptions']['type'],
        fields: CustomFieldConfig[],
    ): void {
        const config = {
            customFields: { Product: fields },
            dbConnectionOptions: { type: dbEngine },
        } as VendureConfig;
        registerCustomFieldsForEntity(config, 'Product', TestCustomFields);
    }

    function getTestIndices(propertyName: string) {
        return metadata.indices.filter(
            index =>
                index.target === TestCustomFields &&
                Array.isArray(index.columns) &&
                index.columns.includes(propertyName),
        );
    }
});
