#!/usr/bin/env python3
"""Add trailing semicolons to top-level const arrow function declarations in .gs files."""

import glob
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
TOP_CONST_ARROW_RE = re.compile(r"^const \w+ = .*=> \{")


def add_semicolons(content: str) -> str:
    lines = content.splitlines(keepends=True)
    out = []
    depth = 0
    in_top_arrow = False

    for line in lines:
        stripped = line.rstrip("\r\n")
        bare = stripped.strip()

        if depth == 0 and TOP_CONST_ARROW_RE.match(bare):
            in_top_arrow = True

        open_count = bare.count("{")
        close_count = bare.count("}")

        if in_top_arrow and depth == 1 and bare == "}" and not stripped.endswith(";"):
            out.append(stripped + ";\n")
            in_top_arrow = False
            depth = 0
            continue

        out.append(line)
        depth += open_count - close_count
        if depth <= 0:
            depth = 0
            in_top_arrow = False

    return "".join(out)


def main():
    for path in sorted(glob.glob(os.path.join(ROOT, "*.gs"))):
        with open(path, "r", encoding="utf-8") as f:
            original = f.read()
        updated = add_semicolons(original)
        if updated != original:
            with open(path, "w", encoding="utf-8") as f:
                f.write(updated)
            print(f"semicolons: {os.path.basename(path)}")


if __name__ == "__main__":
    main()
