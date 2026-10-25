import { DwgDatabase } from '../database';
import { LibreDwgEx } from '../libredwg';
import { Dwg_Data_Ptr } from '../types';
/**
 * Class used to convert Dwg_Data instance to DwgDatabase instance.
 */
export declare class LibreDwgConverter {
    private libredwg;
    private entityConverter;
    /**
     * Entity object indices keyed by owning BLOCK_HEADER object pointer.
     * Built lazily when an ownership walk returns no entities (LibreDWG
     * https://github.com/LibreDWG/libredwg/issues/1199).
     */
    private orphanEntitiesByBlock;
    /** Entity indices whose ownerhandle does not resolve to any object. */
    private ownerlessOrphanIndices;
    private orphanIndexDataPtr;
    constructor(instance: LibreDwgEx);
    convert(data: Dwg_Data_Ptr): DwgDatabase;
    getConversionStats(): {
        unknownEntityCount: number;
    };
    private safeObjectTio;
    private convertHeader;
    private convertClasses;
    private convertAppId;
    private convertBlockRecord;
    private convertEntities;
    /**
     * Builds (once) a map of BLOCK_HEADER object pointer → entity object indices
     * for entities that are not reachable through the ownership chain, then
     * converts the entities owned by `blockHeaderPtr`.
     *
     * @param includeOwnerless - When true (only for *Model_Space), also convert
     *   entities that still have no resolvable owner after ownerhandle + entmode
     *   fallback via dwg_entity_owner.
     */
    private convertOrphanOwnedEntities;
    private ensureOrphanEntityIndex;
    private convertDimStyle;
    private convertLayer;
    private convertLineType;
    private convertLineTypePattern;
    private convertStyle;
    private convertViewport;
    private getCommonTableEntryAttrs;
    private convertDictionary;
    private convertImageDef;
    private convertLayerFilter;
    private convertLayerIndex;
    private convertLayout;
    private convertMLeaderStyle;
    private convertSpatialFilter;
    private convertXRecord;
    private getCommonObjectAttrs;
}
//# sourceMappingURL=converter.d.ts.map