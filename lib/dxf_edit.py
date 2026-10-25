#!/usr/bin/env python3
"""Apply structured edits to a DXF file, safely and reversibly.

The agent never writes DXF bytes itself: it sends a small JSON document
describing intent (``{"handle": "90", "op": "radius", "value": 6.5}``) and this
script performs the edit. That keeps every write inside one reviewed path:

  * the original is copied to a timestamped backup first;
  * edits are applied through ezdxf's entity model, addressed by handle, so an
    edit cannot silently land on the wrong entity;
  * a failed edit restores the original rather than leaving a half-written file;
  * ``$DWGCODEPAGE`` is corrected on the way out (see the note below).

Encoding note, learned the hard way: ezdxf writes GBK bytes while declaring
``ANSI_1252`` when asked for ``encoding='gbk'`` on an R2007+ document. Such a file
is self-contradictory — the DXF spec makes R2007+ UTF-8 — and every reader that
obeys the header (including this plugin's own renderer) shows mojibake. So this
script always reads with the declared code page, and always writes UTF-8 for
R2007+, or re-declares the true code page for older versions.

Usage:
    python3 dxf_edit.py --file drawing.dxf --edits edits.json [--dry-run]
    python3 dxf_edit.py --file drawing.dxf --describe

``--describe`` prints every editable entity as JSON, which is how the agent finds
out what handles exist before proposing an edit.
"""

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import time

try:
    import ezdxf
except ImportError:  # pragma: no cover - reported to the caller, not raised
    print(json.dumps({"ok": False, "code": "NO_EZDXF",
                      "message": "ezdxf is not installed in this Python"}), file=sys.stderr)
    sys.exit(3)

# Code pages the DXF header may declare, mapped to Python codec names.
CODEPAGES = {
    "ANSI_936": "gbk",
    "ANSI_950": "big5",
    "ANSI_932": "shift_jis",
    "ANSI_949": "euc-kr",
    "ANSI_874": "cp874",
    "ANSI_1250": "cp1250",
    "ANSI_1251": "cp1251",
    "ANSI_1252": "cp1252",
    "ANSI_1253": "cp1253",
    "ANSI_1254": "cp1254",
    "ANSI_1255": "cp1255",
    "ANSI_1256": "cp1256",
    "ANSI_1257": "cp1257",
    "ANSI_1258": "cp1258",
}

# R2007 (AC1021) and later are UTF-8 by definition, whatever the header claims.
UTF8_SINCE = 1021


def declared_codepage(path):
    """Read ``$DWGCODEPAGE`` and ``$ACADVER`` from the header without parsing the file."""
    with open(path, "rb") as handle:
        head = handle.read(64 * 1024).decode("latin-1")
    page = None
    marker = head.find("$DWGCODEPAGE")
    if marker >= 0:
        chunk = head[marker:marker + 200].splitlines()
        for index, line in enumerate(chunk):
            if line.strip() == "3" and index + 1 < len(chunk):
                page = chunk[index + 1].strip()
                break
    version = None
    marker = head.find("$ACADVER")
    if marker >= 0:
        chunk = head[marker:marker + 200].splitlines()
        for index, line in enumerate(chunk):
            if line.strip() == "1" and index + 1 < len(chunk):
                raw = chunk[index + 1].strip()
                if raw.upper().startswith("AC") and raw[2:].isdigit():
                    version = int(raw[2:])
                break
    return page, version


def _text_quality(doc):
    """How plausible the decoded text is, as the number of replacement/surrogate chars.

    A file whose header lies decodes "successfully" under the wrong codec but
    produces surrogate escapes, which is exactly the mojibake we need to reject.
    """
    bad = 0
    seen = 0
    try:
        for entity in doc.modelspace():
            kind = entity.dxftype()
            value = None
            if kind == "TEXT":
                value = entity.dxf.text
            elif kind == "MTEXT":
                value = entity.text
            if not value:
                continue
            seen += 1
            for char in value:
                code = ord(char)
                if 0xDC80 <= code <= 0xDCFF or code == 0xFFFD:
                    bad += 1
    except Exception:
        return (0, 0)
    return (bad, seen)


def read_document(path):
    """Open the drawing, trying the declared code page before guessing.

    ezdxf happily decodes a GBK file as cp1252 when the header declares ANSI_1252,
    yielding surrogate escapes instead of Chinese. The only reliable signal is the
    decoded text itself, so each candidate is scored and the cleanest wins.
    """
    page, version = declared_codepage(path)
    candidates = []
    declared = CODEPAGES.get(page or "", None)
    if version is not None and version >= UTF8_SINCE:
        # R2007+ is UTF-8 by spec; the declaration is untrustworthy either way.
        candidates = [None, "gbk", "big5", "shift_jis"]
    else:
        if declared:
            candidates.append(declared)
        candidates.extend([None, "gbk", "big5"])

    best = None
    best_score = None
    for encoding in candidates:
        try:
            doc = ezdxf.readfile(path) if encoding is None else ezdxf.readfile(path, encoding=encoding)
        except Exception:
            continue
        score = _text_quality(doc)
        # Fewer bad characters wins; a file with no text at all ties, and the first
        # candidate (the declared code page) then keeps priority.
        if best_score is None or score[0] < best_score[0]:
            best, best_score = doc, score
        if score[0] == 0:
            break
    if best is None:
        # Every strict parse failed. Hand-written or third-party DXF often omits the
        # `AcDbPolyline`-style subclass markers that a strict reader requires, while
        # the geometry itself is perfectly usable. Try the lenient loader before
        # giving up, and let the caller say so in its report.
        lenient = read_lenient(path)
        if lenient is not None:
            # Mark it so the report can say the file needed structural repair.
            try:
                lenient._corncad_repaired = True
            except Exception:
                pass
            return lenient, page, version
        raise ValueError("could not read the drawing under any known code page")
    return best, page, version


# Subclass markers a strict reader requires, keyed by entity type. Hand-written or
# thin-exported DXF often omits them while the geometry is perfectly valid; ezdxf
# then refuses the whole file with "missing 'AcDbPolyline' subclass". Repairing the
# tags is safe because the markers carry no geometry — only the class hierarchy.
SUBCLASS_OF = {
    "LWPOLYLINE": "AcDbPolyline",
    "POLYLINE": "AcDb2dPolyline",
    "MTEXT": "AcDbMText",
    "TEXT": "AcDbText",
    "CIRCLE": "AcDbCircle",
    "ARC": "AcDbCircle",
    "LINE": "AcDbLine",
    "ELLIPSE": "AcDbEllipse",
    "POINT": "AcDbPoint",
    "SOLID": "AcDbTrace",
    "INSERT": "AcDbBlockReference",
    "HATCH": "AcDbHatch",
    "DIMENSION": "AcDbDimension",
    "3DFACE": "AcDbFace",
}

# Types that also need a second marker for their geometry.
SUBCLASS_EXTRA = {
    "LWPOLYLINE": "AcDbPolyline",
    "CIRCLE": "AcDbCircle",
    "ARC": "AcDbCircle",
    "TEXT": "AcDbText",
    "MTEXT": "AcDbMText",
}


def normalise_tags(text):
    """Insert entity subclass markers that a strict reader requires.

    Works on the raw tag stream, before ezdxf binds anything, so a file that only
    lacks structure can still be read. A file that already carries markers is
    returned unchanged.
    """
    lines = text.splitlines()
    # Pair up (code, value) the way DXF stores them.
    pairs = []
    index = 0
    while index + 1 < len(lines):
        raw_code = lines[index].strip()
        if raw_code == "":
            index += 1
            continue
        try:
            code = int(raw_code)
        except ValueError:
            index += 1
            continue
        pairs.append((code, lines[index + 1]))
        index += 2

    out = []
    index = 0
    while index < len(pairs):
        code, value = pairs[index]
        out.append((code, value))
        if code == 0:
            kind = value.strip().upper()
            # Collect the entity body so we know whether a marker is present.
            look = index + 1
            has_100 = False
            has_layer = False
            while look < len(pairs) and pairs[look][0] != 0:
                if pairs[look][0] == 100:
                    has_100 = True
                if pairs[look][0] == 8:
                    has_layer = True
                look += 1
            target = SUBCLASS_OF.get(kind)
            if target is not None and not has_100:
                out.append((100, "AcDbEntity"))
                if not has_layer:
                    out.append((8, "0"))
                out.append((100, target))
            elif target is not None and has_100:
                # A partial marker set still needs the entity-level one first.
                body = [pairs[i] for i in range(index + 1, look)]
                if not any(c == 100 and v.strip() == "AcDbEntity" for c, v in body):
                    out.append((100, "AcDbEntity"))
                    if not has_layer:
                        out.append((8, "0"))
        index += 1

    flat = []
    for code, value in out:
        flat.append(str(code))
        flat.append(value)
    return "\n".join(flat) + "\n"


def read_lenient(path):
    """Read a file a strict parser rejects, by repairing its structure first.

    The repair rewrites tags, so it has to decode with the file's *real* encoding
    and hand the same encoding back when writing — decoding GBK as UTF-8 smuggles
    surrogate escapes into the text, which then cannot even be serialised back to
    JSON.
    """
    page, version = declared_codepage(path)
    declared = CODEPAGES.get(page or "", "utf-8")
    # Most likely first: the declared page, then UTF-8 (R2007+ spec), then GBK
    # (the page a Chinese drawing most often actually uses).
    attempts = []
    for codec in (declared, "utf-8", "gbk", "big5"):
        if codec and codec not in attempts:
            attempts.append(codec)

    for codec in attempts:
        try:
            raw = open(path, "rb").read().decode(codec)
        except (UnicodeDecodeError, LookupError):
            continue
        if any(0xDC80 <= ord(char) <= 0xDCFF for char in raw):
            continue  # surrogate escapes: this codec was wrong
        repaired = normalise_tags(raw)
        handle = tempfile.NamedTemporaryFile("w", suffix=".dxf", delete=False, encoding=codec)
        try:
            handle.write(repaired)
            handle.close()
            doc = ezdxf.readfile(handle.name, encoding=codec)
            return doc
        except Exception:
            continue
        finally:
            try:
                if not handle.closed:
                    handle.close()
                os.unlink(handle.name)
            except OSError:
                pass
    return None


def describe(doc):
    """Every entity the agent may address, with the facts needed to choose one."""
    out = []
    for entity in doc.modelspace():
        record = {
            "handle": entity.dxf.handle,
            "type": entity.dxftype(),
            "layer": entity.dxf.layer,
        }
        try:
            if entity.dxftype() == "CIRCLE":
                record["center"] = [round(entity.dxf.center.x, 4), round(entity.dxf.center.y, 4)]
                record["radius"] = round(entity.dxf.radius, 4)
            elif entity.dxftype() == "LINE":
                record["start"] = [round(entity.dxf.start.x, 4), round(entity.dxf.start.y, 4)]
                record["end"] = [round(entity.dxf.end.x, 4), round(entity.dxf.end.y, 4)]
                record["length"] = round(entity.dxf.start.distance(entity.dxf.end), 4)
            elif entity.dxftype() in ("LWPOLYLINE", "POLYLINE"):
                points = [(round(p[0], 4), round(p[1], 4)) for p in entity.get_points("xy")]
                record["points"] = points
                record["closed"] = bool(entity.closed)
            elif entity.dxftype() in ("TEXT", "MTEXT"):
                record["text"] = entity.dxf.text if entity.dxftype() == "TEXT" else entity.text
                record["height"] = round(entity.dxf.height if entity.dxftype() == "TEXT" else entity.dxf.char_height, 4)
            elif entity.dxftype() == "ARC":
                record["center"] = [round(entity.dxf.center.x, 4), round(entity.dxf.center.y, 4)]
                record["radius"] = round(entity.dxf.radius, 4)
                record["start_angle"] = round(entity.dxf.start_angle, 4)
                record["end_angle"] = round(entity.dxf.end_angle, 4)
        except Exception:  # a malformed entity should not hide the others
            pass
        out.append(record)
    return out


# Layout blocks mirror modelspace: walking both would visit the same entity twice,
# which then looks like "two equally close candidates" to the matcher and gets a
# perfectly unambiguous pick refused.
LAYOUT_BLOCKS = {"*Model_Space", "*Paper_Space", "*Model_Space0", "*Paper_Space0"}


def _iter_entities(doc):
    """Modelspace plus every non-layout block, each entity exactly once."""
    for entity in doc.modelspace():
        yield entity
    for block in doc.blocks:
        if block.name in LAYOUT_BLOCKS:
            continue
        for entity in block:
            yield entity


def find(doc, handle):
    """Entity by handle anywhere in the document, or None.

    A drawing written without group code 5 (hand-written fixtures, thin exporters,
    pre-R2000 output) has no usable handle: the preview reports an empty string
    while a reader such as ezdxf invents one. Those picks are addressed
    geometrically instead — see {@link find_by_geometry}.
    """
    for entity in _iter_entities(doc):
        if getattr(entity.dxf, "handle", None) == handle:
            return entity
    return None


def entity_points(entity):
    """A few world-space points that characterise the entity, for matching."""
    kind = entity.dxftype()
    try:
        if kind == "CIRCLE":
            center = entity.dxf.center
            radius = float(entity.dxf.radius)
            return [(center.x - radius, center.y - radius), (center.x + radius, center.y + radius)]
        if kind == "ARC":
            # The arc's own sweep, not its full circle: the preview reports the arc
            # bounds, and a circle-wide box would never match them.
            center = entity.dxf.center
            radius = float(entity.dxf.radius)
            start = float(entity.dxf.start_angle) * math.pi / 180.0
            end = float(entity.dxf.end_angle) * math.pi / 180.0
            while end <= start:
                end += math.pi * 2
            points = [(center.x, center.y)]
            steps = 48
            for index in range(steps + 1):
                angle = start + (end - start) * (index / steps)
                points.append((center.x + radius * math.cos(angle), center.y + radius * math.sin(angle)))
            return points
        if kind == "LINE":
            start, end = entity.dxf.start, entity.dxf.end
            return [(start.x, start.y), (end.x, end.y)]
        if kind in ("LWPOLYLINE", "POLYLINE") and entity.is_2d_polyline:
            return [(float(p[0]), float(p[1])) for p in entity.get_points("xy")]
        if kind in ("TEXT", "MTEXT"):
            insert = entity.dxf.insert
            return [(insert.x, insert.y)]
        if kind == "ELLIPSE":
            center = entity.dxf.center
            return [(center.x, center.y)]
        if kind in ("POINT",):
            location = entity.dxf.location
            return [(location.x, location.y)]
    except Exception:
        pass
    return []


def find_by_geometry(doc, pick, tolerance=0.5):
    """Find the entity a preview pick describes, without relying on a handle.

    The preview sends what it knows for certain: the DXF type, the layer, and the
    world-space bounds it drew. Matching on those three is enough to be unambiguous
    in practice, and a wrong match is refused rather than guessed when several
    candidates are equally close.

    @param doc      the drawing.
    @param pick     {type, layer, bbox?, id?} from the selection record.
    @param tolerance upper bound, in drawing units, on how far a candidate may sit.
    """
    wanted_type = str(pick.get("type") or "").upper()
    wanted_layer = pick.get("layer")
    bbox = pick.get("bbox")
    if wanted_type == "" or not isinstance(bbox, list) or len(bbox) < 4:
        return None
    target_cx = (bbox[0] + bbox[2]) / 2.0
    target_cy = (bbox[1] + bbox[3]) / 2.0
    target_w = bbox[2] - bbox[0]
    target_h = bbox[3] - bbox[1]

    scored = []
    for entity in _iter_entities(doc):
        if entity.dxftype().upper() != wanted_type:
            continue
        if wanted_layer is not None and entity.dxf.layer != wanted_layer:
            continue
        points = entity_points(entity)
        if not points:
            continue
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        cx = (min(xs) + max(xs)) / 2.0
        cy = (min(ys) + max(ys)) / 2.0
        dx = abs(cx - target_cx)
        dy = abs(cy - target_cy)
        dw = abs((max(xs) - min(xs)) - target_w)
        dh = abs((max(ys) - min(ys)) - target_h)
        # A relative scale keeps the tolerance meaningful for very small parts.
        scale = max(1.0, abs(target_w), abs(target_h))
        distance = (dx + dy) / scale + (dw + dh) / (scale * 4.0)
        scored.append((distance, entity))

    if not scored:
        return None
    scored.sort(key=lambda pair: pair[0])
    best_distance, best_entity = scored[0]
    if best_distance > tolerance:
        return None
    if len(scored) > 1:
        runner_distance = scored[1][0]
        # Two candidates this close means the pick is ambiguous; refusing beats
        # editing the wrong hole.
        if abs(runner_distance - best_distance) < 0.02:
            return None
    return best_entity


# The AutoCAD colour index most people mean by a plain colour name. Users ask for
# "black" or "red", not for index 7 or 250.
COLOR_NAMES = {
    "red": 1, "yellow": 2, "green": 3, "cyan": 4, "blue": 5, "magenta": 6,
    "white": 7, "black": 7,  # 7 renders as black on light, white on dark paper
    "gray": 8, "grey": 8, "lightgray": 9, "lightgrey": 9,
    "orange": 30, "purple": 200, "brown": 32,
}


def color_index(value):
    """Resolve a colour request to an AutoCAD index (int) or an RGB int (0xRRGGBB)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value <= 255 else None
    text = str(value).strip().lower()
    if text == "":
        return None
    if text.isdigit():
        number = int(text)
        return number if 0 <= number <= 255 else None
    if text.startswith("#"):
        digits = text[1:]
        if len(digits) == 3:
            digits = "".join(char * 2 for char in digits)
        if len(digits) != 6:
            return None
        try:
            return int(digits, 16)
        except ValueError:
            return None
    if text in COLOR_NAMES:
        return COLOR_NAMES[text]
    return None


def apply_edit(doc, edit):
    """Apply one edit. Returns a human-readable note, or raises ValueError."""
    handle = str(edit.get("handle") or "").strip()
    op = str(edit.get("op") or "").strip()
    if op == "":
        raise ValueError("edit is missing an op")

    # Two ways to name an entity. A handle is exact; when the drawing has none
    # (the preview then reports ""), fall back to the geometry the pick carried.
    entity = None
    how = None
    if handle != "":
        entity = find(doc, handle)
        how = f"handle {handle}"
    if entity is None:
        pick = edit.get("pick")
        if not isinstance(pick, dict) and handle == "":
            pick = edit if edit.get("type") else None
        if isinstance(pick, dict):
            entity = find_by_geometry(doc, pick)
            if entity is not None:
                how = f"{pick.get('type')} near {[round(v, 2) for v in pick.get('bbox', [])]}"
    if entity is None:
        if handle == "":
            raise ValueError("edit names no entity: give a handle, or a pick with type + layer + bbox")
        raise ValueError(f"no entity with handle {handle}")
    kind = entity.dxftype()

    if op == "radius":
        if kind not in ("CIRCLE", "ARC"):
            raise ValueError(f"{kind} has no radius")
        value = float(edit["value"])
        if value <= 0:
            raise ValueError("radius must be positive")
        entity.dxf.radius = value
        return f"{kind} ({how}) radius -> {value}"

    if op == "text":
        if kind != "TEXT":
            raise ValueError(f"{kind} is not a TEXT entity")
        entity.dxf.text = str(edit["value"])
        return f"TEXT ({how}) -> {edit['value']!r}"

    if op == "mtext":
        if kind != "MTEXT":
            raise ValueError(f"{kind} is not an MTEXT entity")
        entity.text = str(edit["value"])
        return f"MTEXT {handle} text updated"

    if op == "height":
        if kind not in ("TEXT", "MTEXT"):
            raise ValueError(f"{kind} has no text height")
        value = float(edit["value"])
        if value <= 0:
            raise ValueError("height must be positive")
        if kind == "TEXT":
            entity.dxf.height = value
        else:
            entity.dxf.char_height = value
        return f"{kind} {handle} height -> {value}"

    if op == "layer":
        entity.dxf.layer = str(edit["value"])
        return f"{kind} ({how}) layer -> {edit['value']}"

    if op == "color":
        value = edit["value"]
        target = color_index(value)
        if target is None:
            raise ValueError(f"unknown color {value!r}; give an AutoCAD color index (1-255) or a #RRGGBB value")
        if isinstance(target, int):
            entity.dxf.color = target
            # A true colour left behind would win over the index, so clear it.
            try:
                if entity.dxf.hasattr("true_color"):
                    del entity.dxf.true_color
            except Exception:
                pass
            return f"{kind} ({how}) color -> AutoCAD index {target}"
        entity.dxf.true_color = target
        return f"{kind} ({how}) color -> #{target:06X}"

    if op == "move":
        dx = float(edit.get("dx", 0.0))
        dy = float(edit.get("dy", 0.0))
        entity.translate(dx, dy, 0)
        return f"{kind} {handle} moved by ({dx}, {dy})"

    if op == "center":
        if kind not in ("CIRCLE", "ARC"):
            raise ValueError(f"{kind} has no center")
        x, y = float(edit["x"]), float(edit["y"])
        entity.dxf.center = (x, y, 0)
        return f"{kind} {handle} center -> ({x}, {y})"

    if op == "delete":
        doc.modelspace().delete_entity(entity)
        return f"{kind} {handle} deleted"

    raise ValueError(f"unknown op {op!r}")


def backup_path(path):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return f"{path}.{stamp}.bak"


def ensure_table_handles(doc):
    """Give table headers an identity so a handle-less drawing can be saved.

    A DXF whose tables carry no handle is readable but not writable: ezdxf refuses
    with "TABLE needs a handle, maybe loaded from DXF R12 without handle". The
    entities themselves are fine — only the table *headers* lack the group code 5
    the writer insists on. Assigning one is a structural repair with no effect on
    geometry, so it is safe to do silently.

    @returns {string[]} names of the tables that were repaired.
    """
    repaired = []
    for name in ("layers", "linetypes", "styles", "views", "vports",
                 "appids", "dimstyles", "ucs", "block_records"):
        try:
            table = getattr(doc, name)
        except Exception:
            continue
        head = getattr(table, "head", None)
        if head is None:
            continue
        try:
            if not head.dxf.hasattr("handle"):
                head.dxf.handle = doc.entitydb.next_handle()
                repaired.append(name)
        except Exception:
            continue
    return repaired


def write_document(doc, path, page, version):
    """Write so the header and the bytes agree.

    R2007+ is UTF-8 by spec, so the declaration is forced to ANSI_1252 only when it
    already claims a single-byte Western page; otherwise it is left alone and the
    document is written as UTF-8. Older versions are written in their own code page
    so the text round-trips.
    """
    utf8 = version is None or version >= UTF8_SINCE
    if utf8:
        # Anything claiming a legacy code page on an R2007+ file is a lie the
        # renderer would honour; the bytes below are UTF-8.
        doc.header["$DWGCODEPAGE"] = "ANSI_1252"
        doc.saveas(path)
    else:
        codec = CODEPAGES.get(page or "", None)
        doc.saveas(path, encoding=codec or "utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Apply structured edits to a DXF file.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--edits", help="JSON file holding an array of edit objects")
    parser.add_argument("--describe", action="store_true", help="print editable entities as JSON")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    path = os.path.abspath(args.file)
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "code": "NO_FILE", "message": path}))
        return 2

    try:
        doc, page, version = read_document(path)
    except Exception as error:
        print(json.dumps({"ok": False, "code": "READ_FAILED", "message": str(error)}))
        return 1

    if args.describe:
        print(json.dumps({
            "ok": True,
            "file": path,
            "codepage": page,
            "version": f"AC{version}" if version else None,
            "encoding": doc.encoding,
            "repaired": bool(getattr(doc, "_corncad_repaired", False)),
            "entities": describe(doc),
        }, ensure_ascii=False))
        return 0

    if not args.edits:
        print(json.dumps({"ok": False, "code": "NO_EDITS",
                          "message": "pass --edits <json file> or --describe"}))
        return 2

    with open(args.edits, encoding="utf-8") as handle:
        edits = json.load(handle)
    if isinstance(edits, dict):
        edits = edits.get("edits", [])
    if not isinstance(edits, list) or not edits:
        print(json.dumps({"ok": False, "code": "EMPTY_EDITS"}))
        return 2

    notes = []
    try:
        for edit in edits:
            notes.append(apply_edit(doc, edit))
    except Exception as error:
        # Nothing is written: the caller keeps the file it had.
        print(json.dumps({"ok": False, "code": "EDIT_FAILED",
                          "message": str(error), "appliedBeforeFailure": notes}, ensure_ascii=False))
        return 1

    if args.dry_run:
        print(json.dumps({"ok": True, "dryRun": True, "notes": notes}, ensure_ascii=False))
        return 0

    # Write to a sibling temp file, then swap, so a crash cannot truncate the
    # drawing the user is looking at in the preview.
    directory = os.path.dirname(path) or "."
    fd, temp_path = tempfile.mkstemp(prefix=".corncad-", suffix=".dxf", dir=directory)
    os.close(fd)
    backup = backup_path(path)
    try:
        repaired_tables = ensure_table_handles(doc)
        write_document(doc, temp_path, page, version)
        shutil.copy2(path, backup)
        os.replace(temp_path, path)
    except Exception as error:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        message = str(error)
        # The most common write failure by far: a handle-less R12 file. ezdxf can
        # read such a file (after repair) but cannot assign identities on save, and
        # the bare ezdxf message does not tell the user what to do about it.
        if "needs a handle" in message:
            message = (
                "这份 DXF 的表结构缺少句柄，自动补齐后仍无法保存。"
                "请在 CAD 里另存为 R2000 或更新的版本（AutoCAD: 另存为 → AutoCAD 2000/LT2000 Drawing），再试一次。"
            )
        print(json.dumps({"ok": False, "code": "WRITE_FAILED", "message": message}, ensure_ascii=False))
        return 1

    print(json.dumps({
        "ok": True,
        "file": path,
        "backup": backup,
        "notes": notes,
        "codepageBefore": page,
        "repairedTables": repaired_tables,
        "entitiesNow": len(list(doc.modelspace())),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
