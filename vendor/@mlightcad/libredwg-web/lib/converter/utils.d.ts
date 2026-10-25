export declare const isModelSpace: (name: string) => boolean | "";
export declare const isPaperSpace: (name: string) => boolean | "";
export declare const idToString: (id: number | bigint) => string;
export declare const uint8ArrayToHexString: (bytes: Uint8Array) => string;
/**
 * OLE2FRAME binary payloads begin with a 0x80-byte Autodesk header, then an
 * MS-CFB compound document. Corner points for DXF groups 10/11 are stored in
 * that header (also decoded by `dwg_decode_ole2`).
 *
 * Layout after a 2-byte unknown prefix (`0x80 0x55` in common files):
 * four WCS corners as little-endian 3D doubles (upper-left, upper-right,
 * lower-right, lower-left). DXF group codes 10/11 store the first and third.
 */
export declare const decodeOle2FrameCornersFromData: (data: Uint8Array) => {
    upperLeft: {
        x: number;
        y: number;
        z: number;
    };
    lowerRight: {
        x: number;
        y: number;
        z: number;
    };
} | null;
//# sourceMappingURL=utils.d.ts.map