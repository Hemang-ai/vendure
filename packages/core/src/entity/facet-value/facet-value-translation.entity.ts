import { LanguageCode } from '@vendure/common/lib/generated-types';
import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';

import { Translation } from '../../common/types/locale-types';
import { VendureEntity } from '../base/base.entity';
import { CustomFacetValueFieldsTranslation } from '../custom-entity-fields';

import { FacetValue } from './facet-value.entity';

@Entity()
@Unique(['languageCode', 'base'])
export class FacetValueTranslation extends VendureEntity implements Translation<FacetValue> {
    constructor(input?: DeepPartial<Translation<FacetValue>>) {
        super(input);
    }

    @Column('varchar') languageCode: LanguageCode;

    @Column() name: string;

    @Index()
    @ManyToOne(type => FacetValue, base => base.translations, { onDelete: 'CASCADE' })
    base: FacetValue;

    @Column(type => CustomFacetValueFieldsTranslation)
    customFields: CustomFacetValueFieldsTranslation;
}
