import { Dwg_Color } from '../types';
/**
 * Converts a libredwg {@link Dwg_Color} (CMC) to the DXF MLEADER raw-color int32
 * used by group codes 91/92/93/94 and {@link decodeMLeaderStyleRawColor}.
 *
 * Libredwg stores MLeader component colors as packed int32 in {@link Dwg_Color.rgb}
 * with {@link Dwg_Color.method} mirroring the high-byte type flag (0xC0..0xC8).
 */
export declare function dwgColorToMLeaderRawColor(color: Dwg_Color | undefined | null): number | undefined;
//# sourceMappingURL=dwgColorToMLeaderRawColor.d.ts.map