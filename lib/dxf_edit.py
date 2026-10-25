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
        if kind == "LWPOLYLINE":
            return [(float(p[0]), float(p[1])) for p in entity.get_points("xy")]
        if kind == "POLYLINE":
            if not entity.is_2d_polyline:
                return []
            return [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in entity.vertices]
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
    """Resolve a colour request to ("index", n) or ("rgb", 0xRRGGBB), or None.

    The two kinds must not be conflated: 16746496 is a valid RGB value and an
    impossible AutoCAD colour index, so a bare int has to say which it is. An
    explicit "#..." is RGB; a plain number or a name is an index.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return ("index", value) if 0 <= value <= 255 else None
    text = str(value).strip().lower()
    if text == "":
        return None
    if text.startswith("#"):
        digits = text[1:]
        if len(digits) == 3:
            digits = "".join(char * 2 for char in digits)
        if len(digits) != 6:
            return None
        try:
            return ("rgb", int(digits, 16))
        except ValueError:
            return None
    if text.isdigit():
        number = int(text)
        return ("index", number) if 0 <= number <= 255 else None
    if text in COLOR_NAMES:
        return ("index", COLOR_NAMES[text])
    return None


# The standard AutoCAD palette, indexed 1..9 plus the ones people actually name.
# Used only to approximate a true colour on a DXF too old to store one.
PALETTE = {
    1: (255, 0, 0), 2: (255, 255, 0), 3: (0, 255, 0), 4: (0, 255, 255),
    5: (0, 0, 255), 6: (255, 0, 255), 7: (0, 0, 0), 8: (128, 128, 128),
    9: (192, 192, 192), 30: (255, 127, 0), 32: (127, 63, 0), 200: (128, 0, 128),
}


def nearest_color_index(r, g, b):
    """Closest palette entry to an RGB triple, by squared distance."""
    best, best_distance = 7, None
    for index, (pr, pg, pb) in PALETTE.items():
        distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2
        if best_distance is None or distance < best_distance:
            best, best_distance = index, distance
    return best


def apply_edit(doc, edit):
    """Apply one edit. Returns a human-readable note, or raises ValueError."""
    handle = str(edit.get("handle") or "").strip()
    op = str(edit.get("op") or "").strip()
    if op in DOCUMENT_OPS:
        return apply_document_edit(doc, edit, op)
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
        return f"{kind} ({how}) height -> {value}"

    if op == "layer":
        entity.dxf.layer = str(edit["value"])
        return f"{kind} ({how}) layer -> {edit['value']}"

    if op == "color":
        resolved = color_index(edit["value"])
        if resolved is None:
            raise ValueError(
                f"unknown color {edit['value']!r}; give a name, an AutoCAD index (1-255), or #RRGGBB")
        mode, target = resolved
        if mode == "index":
            # BYLAYER (256) or BYBLOCK (0) would hide the change, so refuse them:
            # the user asked for a colour, not for a layer lookup.
            if target in (0, 256):
                raise ValueError("0 and 256 mean BYBLOCK/BYLAYER, not a colour")
            entity.dxf.color = target
            # A true colour left behind would win over the index, so clear it.
            try:
                if entity.dxf.hasattr("true_color"):
                    del entity.dxf.true_color
            except Exception:
                pass
            return f"{kind} ({how}) color -> AutoCAD index {target}"
        # True colour needs DXF R2004+ (group code 420). Older files silently drop
        # it, which would look like the edit did nothing, so fall back to the
        # nearest AutoCAD index and say so.
        if doc.dxfversion is not None and doc.dxfversion < "AC1018":
            rgb = ((target >> 16) & 0xFF, (target >> 8) & 0xFF, target & 0xFF)
            nearest = nearest_color_index(*rgb)
            entity.dxf.color = nearest
            return (f"{kind} ({how}) color -> AutoCAD index {nearest} "
                    f"(nearest to #{target:06X}; this DXF version cannot store true colour)")
        entity.dxf.true_color = target
        # The index has to stop overriding the true colour.
        try:
            if entity.dxf.hasattr("color"):
                del entity.dxf.color
        except Exception:
            pass
        return f"{kind} ({how}) color -> #{target:06X}"

    if op == "move":
        dx = float(edit.get("dx", 0.0))
        dy = float(edit.get("dy", 0.0))
        entity.translate(dx, dy, 0)
        return f"{kind} ({how}) moved by ({dx}, {dy})"

    if op == "center":
        if kind not in ("CIRCLE", "ARC"):
            raise ValueError(f"{kind} has no center")
        x, y = float(edit["x"]), float(edit["y"])
        entity.dxf.center = (x, y, 0)
        return f"{kind} ({how}) center -> ({x}, {y})"

    if op == "delete":
        doc.modelspace().delete_entity(entity)
        return f"{kind} ({how}) deleted"

    if op == "linetype":
        name = str(edit.get("value") or "").strip()
        if name == "":
            raise ValueError("linetype needs a value")
        ensure_linetype(doc, name)
        entity.dxf.linetype = name
        return f"{kind} ({how}) linetype -> {name}"

    if op == "lineweight":
        value = int(edit["value"])
        if value not in (-1, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53,
                         60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211):
            raise ValueError(f"{value} is not an AutoCAD lineweight (use -1 for BYLAYER)")
        entity.dxf.lineweight = value
        return f"{kind} ({how}) lineweight -> {value}"

    if op == "scale":
        # Scale about the entity's own centre unless a base point is given: asking
        # to enlarge a hole means that hole grows in place, not that it flies away
        # from the origin.
        sx = float(edit.get("sx", edit.get("value", edit.get("factor", 1.0))))
        sy = float(edit.get("sy", edit.get("value", edit.get("factor", sx))))
        if sx == 0 or sy == 0:
            raise ValueError("a scale factor of 0 collapses the entity")
        base = edit.get("base")
        if isinstance(base, (list, tuple)) and len(base) >= 2:
            bx, by = float(base[0]), float(base[1])
        else:
            xs, ys = entity_bounds(entity)
            if xs is None:
                raise ValueError("cannot find the entity's centre; give a base point")
            bx, by = (xs[0] + xs[1]) / 2.0, (ys[0] + ys[1]) / 2.0
        entity.scale(sx, sy, 1.0)
        # `scale` works about the world origin, so shift back around the base point.
        entity.translate(bx * (1 - sx), by * (1 - sy), 0)
        return f"{kind} ({how}) scaled by ({sx}, {sy}) about ({bx:.3f}, {by:.3f})"

    if op == "rotate":
        angle = float(edit.get("angle", edit.get("value", 0)))
        base = edit.get("base")
        if isinstance(base, (list, tuple)) and len(base) >= 2:
            bx, by = float(base[0]), float(base[1])
        else:
            xs, ys = entity_bounds(entity)
            if xs is None:
                raise ValueError("cannot find the entity's centre; give a base point")
            bx, by = (xs[0] + xs[1]) / 2.0, (ys[0] + ys[1]) / 2.0
        entity.rotate_z(math.radians(angle))
        # rotate_z turns about the world origin; move the result back about the base.
        cos_a, sin_a = math.cos(math.radians(angle)), math.sin(math.radians(angle))
        entity.translate(bx - (bx * cos_a - by * sin_a), by - (bx * sin_a + by * cos_a), 0)
        return f"{kind} ({how}) rotated {angle}° about ({bx:.3f}, {by:.3f})"

    if op == "mirror":
        # Mirroring an entity across a line through its own centre is a no-op for a
        # circle (and for a symmetric shape), so what the user means is usually a
        # mirror across a *scene* axis. Default to the drawing's X axis (y = the
        # entity's centre), and accept an explicit axis position.
        axis = str(edit.get("axis") or "x").strip().lower()
        xs, ys = entity_bounds(entity)
        if xs is None:
            raise ValueError("cannot find the entity's bounds")
        cx, cy = (xs[0] + xs[1]) / 2.0, (ys[0] + ys[1]) / 2.0
        if axis in ("x", "horizontal"):
            py = float(edit.get("at", cy))
            flip = (lambda x, y: (x, 2 * py - y))
            return f"{kind} ({how}) " + mirror_geometry(entity, flip) + f" (axis y = {py:.3f})"
        if axis in ("y", "vertical"):
            px = float(edit.get("at", cx))
            flip = (lambda x, y: (2 * px - x, y))
            return f"{kind} ({how}) " + mirror_geometry(entity, flip) + f" (axis x = {px:.3f})"
        raise ValueError('mirror axis must be "x" or "y" (the axis it flips across)')

    if op == "copy":
        count = int(edit.get("count", 1))
        if count < 1 or count > 100:
            raise ValueError("count must be between 1 and 100")
        dx = float(edit.get("dx", 0.0))
        dy = float(edit.get("dy", 0.0))
        msp = doc.modelspace()
        made = 0
        for step in range(1, count + 1):
            clone = entity.copy()
            clone.translate(dx * step, dy * step, 0)
            msp.add_entity(clone)
            made += 1
        return f"{kind} ({how}) copied {made}x with offset ({dx}, {dy}) per copy"

    if op == "replace":
        # Swap the entity for one of another type, keeping its place: layer, colour
        # and whatever geometry the new type can express. "Make this arc a line"
        # cannot be done by mutating the entity, so the replacement is explicit.
        return replace_entity(doc, entity, edit, how)

    raise ValueError(f"unknown op {op!r}")


# The linetypes worth offering by name; AUTO-CAD's standard library rather than a
# numeric lookup, so "dashed" means the same thing in every drawing.
LINETYPE_PATTERNS = {
    "CONTINUOUS": [],
    "DASHED": [0.5, -0.25],
    "DOT": [0.0, -0.25],
    "DASHDOT": [0.5, -0.25, 0.0, -0.25],
    "CENTER": [1.25, -0.25, 0.25, -0.25],
    "PHANTOM": [1.25, -0.25, 0.25, -0.25, 0.25, -0.25],
    "HIDDEN": [0.25, -0.125],
    "BORDER": [0.5, -0.25, 0.5, -0.25],
}


def ensure_linetype(doc, name):
    """Add a linetype definition when the drawing does not already carry it."""
    upper = name.upper()
    if doc.linetypes.has_entry(upper):
        return True
    pattern = LINETYPE_PATTERNS.get(upper)
    if pattern is None:
        return False
    doc.linetypes.add(upper, pattern=pattern, description=f"Corn CAD {upper}")
    return True


def ensure_layer(doc, name, color=7):
    """Add a layer when missing. Returns True when it had to be created."""
    if doc.layers.has_entry(name):
        return False
    doc.layers.add(name, color=color)
    return True


def entity_bounds(entity):
    """World-space (xs, ys) extent tuples, or (None, None) when unknown."""
    points = entity_points(entity)
    if not points:
        return None, None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), max(xs)), (min(ys), max(ys))


# Operations that change the drawing rather than one entity. They take no handle.
DOCUMENT_OPS = {"add_layer", "layer_visible", "layer_color", "add_linetype", "purge_layer"}


def apply_document_edit(doc, edit, op):
    """Layer/linetype management, which is document-scoped, not entity-scoped."""
    if op == "add_layer":
        name = str(edit.get("name") or "").strip()
        if name == "":
            raise ValueError("add_layer needs a name")
        color = int(edit.get("color", 7))
        created = ensure_layer(doc, name, color)
        return f"layer {name} {'created' if created else 'already exists'}"

    if op == "layer_visible":
        name = str(edit.get("name") or "").strip()
        layer = doc.layers.get(name) if name else None
        if layer is None:
            raise ValueError(f"no layer named {name!r}")
        visible = bool(edit.get("value", True))
        # DXF stores visibility as the SIGN of the layer colour: a negative index is
        # an off layer. ezdxf's `.off` setter looks like it does this but does not
        # persist (is_off() still reports False after assigning), so the sign is
        # the only representation that survives a round trip.
        magnitude = abs(layer.dxf.color) or 7
        if magnitude in (0, 256):
            magnitude = 7
        layer.dxf.color = magnitude if visible else -magnitude
        return f"layer {name} {'shown' if visible else 'hidden'}"

    if op == "layer_color":
        name = str(edit.get("name") or "").strip()
        layer = doc.layers.get(name) if name else None
        if layer is None:
            raise ValueError(f"no layer named {name!r}")
        resolved = color_index(edit.get("value", 7))
        if resolved is None or resolved[0] != "index":
            raise ValueError("a layer colour must be an AutoCAD index or a colour name")
        index = resolved[1]
        if index in (0, 256):
            raise ValueError("a layer needs a concrete colour, not BYBLOCK/BYLAYER")
        # Keep the hidden state: a negative colour means the layer is off.
        layer.dxf.color = -index if layer.is_off() else index
        return f"layer {name} colour -> index {index}"

    if op == "add_linetype":
        name = str(edit.get("name") or "").strip()
        if name == "":
            raise ValueError("add_linetype needs a name")
        if name.upper() not in LINETYPE_PATTERNS:
            raise ValueError(f"unknown linetype {name!r}; known: {sorted(LINETYPE_PATTERNS)}")
        created = ensure_linetype(doc, name)
        return f"linetype {name} {'added' if created else 'already exists'}"

    if op == "purge_layer":
        name = str(edit.get("name") or "").strip()
        layer = doc.layers.get(name) if name else None
        if layer is None:
            raise ValueError(f"no layer named {name!r}")
        used = [e for e in doc.modelspace() if e.dxf.layer == name]
        if used:
            raise ValueError(f"layer {name!r} still holds {len(used)} entities; move them first")
        doc.layers.remove(name)
        return f"layer {name} removed"

    raise ValueError(f"unknown document op {op!r}")


def _arc_endpoints(entity):
    """World-space endpoints of an arc or circle, in sweep order."""
    center = entity.dxf.center
    radius = float(entity.dxf.radius)
    if entity.dxftype() == "CIRCLE":
        return (center.x + radius, center.y), (center.x - radius, center.y)
    start = float(entity.dxf.start_angle)
    end = float(entity.dxf.end_angle)
    return (
        (center.x + radius * math.cos(math.radians(start)), center.y + radius * math.sin(math.radians(start))),
        (center.x + radius * math.cos(math.radians(end)), center.y + radius * math.sin(math.radians(end))),
    )


def _polyline_points(entity):
    if entity.dxftype() == "LWPOLYLINE":
        return [(float(point[0]), float(point[1])) for point in entity.get_points("xy")]
    return [(float(vertex.dxf.location.x), float(vertex.dxf.location.y)) for vertex in entity.vertices]


def mirror_geometry(entity, flip):
    """Move an entity through an arbitrary reflection, by rewriting its geometry.

    ezdxf's own transforms cannot be trusted here: `scale(1, -1, 1)` on a circle
    also negates its centre x, and a mirror matrix does the same, so a plain
    y-reflection walks the entity sideways. Rewriting the points is exact and
    leaves no such surprise.
    """
    kind = entity.dxftype()
    if kind in ("CIRCLE", "ARC"):
        cx, cy = entity.dxf.center.x, entity.dxf.center.y
        nx, ny = flip(cx, cy)
        if kind == "ARC":
            # A reflection reverses the sweep, so swap the angles it runs between.
            a0, a1 = float(entity.dxf.start_angle), float(entity.dxf.end_angle)
            if (nx - cx) * (ny - cy) != 0 and (abs(nx - cx) > 1e-9) != (abs(ny - cy) > 1e-9):
                entity.dxf.start_angle, entity.dxf.end_angle = a1, a0
        entity.dxf.center = (nx, ny, entity.dxf.center.z)
        return "mirrored"
    if kind == "LINE":
        start, end = entity.dxf.start, entity.dxf.end
        entity.dxf.start = (*flip(start.x, start.y), start.z)
        entity.dxf.end = (*flip(end.x, end.y), end.z)
        return "mirrored"
    if kind == "LWPOLYLINE":
        moved = [flip(float(x), float(y)) for x, y in entity.get_points("xy")]
        entity.set_points(moved, format="xy")
        return "mirrored"
    if kind == "POLYLINE":
        for vertex in entity.vertices:
            location = vertex.dxf.location
            vertex.dxf.location = (*flip(location.x, location.y), location.z)
        return "mirrored"
    if kind in ("TEXT", "MTEXT"):
        insert = entity.dxf.insert
        entity.dxf.insert = (*flip(insert.x, insert.y), insert.z)
        return "moved"
    if kind == "POINT":
        location = entity.dxf.location
        entity.dxf.location = (*flip(location.x, location.y), location.z)
        return "moved"
    raise ValueError(f"mirroring {kind} is not supported")


def replace_entity(doc, entity, edit, how):
    """Replace an entity with another type at the same place.

    A conversion that would lose meaning (anything into an ARC without a sweep) is
    refused rather than guessed: silently changing a drawing is worse than saying
    what is supported.
    """
    source = entity.dxftype()
    target = str(edit.get("to") or "").strip().upper()
    if target == "":
        raise ValueError('replace needs a "to" type, for example {"op":"replace","to":"LINE"}')
    if source == target:
        raise ValueError(f"{source} is already {target}")

    msp = doc.modelspace()
    attribs = {"layer": entity.dxf.layer}
    for name in ("color", "linetype"):
        try:
            if entity.dxf.hasattr(name):
                attribs[name] = entity.dxf.get(name)
        except Exception:
            pass

    created = None
    if source in ("ARC", "CIRCLE") and target in ("LINE", "LWPOLYLINE"):
        start, end = _arc_endpoints(entity)
        created = (msp.add_line(start, end, dxfattribs=attribs) if target == "LINE"
                   else msp.add_lwpolyline([start, end], dxfattribs=attribs))
    elif source in ("LINE", "LWPOLYLINE") and target in ("LINE", "LWPOLYLINE"):
        points = (_polyline_points(entity) if source == "LWPOLYLINE" else
                  [(entity.dxf.start.x, entity.dxf.start.y), (entity.dxf.end.x, entity.dxf.end.y)])
        if len(points) != 2:
            raise ValueError(f"{source} has {len(points)} points; only a 2-point entity becomes one {target}")
        created = (msp.add_line(points[0], points[1], dxfattribs=attribs) if target == "LINE"
                   else msp.add_lwpolyline(points, dxfattribs=attribs))
    elif source == "LINE" and target == "CIRCLE":
        start, end = entity.dxf.start, entity.dxf.end
        radius = start.distance(end) / 2.0
        if radius <= 0:
            raise ValueError("a zero-length line has no circle")
        created = msp.add_circle(((start.x + end.x) / 2.0, (start.y + end.y) / 2.0), radius, dxfattribs=attribs)
    elif target == "ARC":
        raise ValueError(f"{source} -> ARC needs a sweep; add the arc explicitly instead")

    if created is None:
        raise ValueError(f"cannot convert {source} to {target}")

    # True colour lives outside dxfattribs, so it has to be copied separately.
    try:
        if entity.dxf.hasattr("true_color"):
            created.dxf.true_color = entity.dxf.true_color
    except Exception:
        pass

    msp.delete_entity(entity)
    return f"{source} ({how}) replaced by {target}"


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
