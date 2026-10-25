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
        raise ValueError("could not read the drawing under any known code page")
    return best, page, version


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


def find(doc, handle):
    """Entity by handle anywhere in the document, or None."""
    for entity in doc.modelspace():
        if entity.dxf.handle == handle:
            return entity
    for block in doc.blocks:
        for entity in block:
            if getattr(entity.dxf, "handle", None) == handle:
                return entity
    return None


def apply_edit(doc, edit):
    """Apply one edit. Returns a human-readable note, or raises ValueError."""
    handle = str(edit.get("handle") or "").strip()
    op = str(edit.get("op") or "").strip()
    if handle == "":
        raise ValueError("edit is missing a handle")
    if op == "":
        raise ValueError("edit is missing an op")
    entity = find(doc, handle)
    if entity is None:
        raise ValueError(f"no entity with handle {handle}")
    kind = entity.dxftype()

    if op == "radius":
        if kind not in ("CIRCLE", "ARC"):
            raise ValueError(f"{kind} has no radius")
        value = float(edit["value"])
        if value <= 0:
            raise ValueError("radius must be positive")
        entity.dxf.radius = value
        return f"{kind} {handle} radius -> {value}"

    if op == "text":
        if kind != "TEXT":
            raise ValueError(f"{kind} is not a TEXT entity")
        entity.dxf.text = str(edit["value"])
        return f"TEXT {handle} -> {edit['value']!r}"

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
        return f"{kind} {handle} layer -> {edit['value']}"

    if op == "color":
        entity.dxf.color = int(edit["value"])
        return f"{kind} {handle} color -> {edit['value']}"

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
        write_document(doc, temp_path, page, version)
        shutil.copy2(path, backup)
        os.replace(temp_path, path)
    except Exception as error:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        print(json.dumps({"ok": False, "code": "WRITE_FAILED", "message": str(error)}, ensure_ascii=False))
        return 1

    print(json.dumps({
        "ok": True,
        "file": path,
        "backup": backup,
        "notes": notes,
        "codepageBefore": page,
        "entitiesNow": len(list(doc.modelspace())),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
