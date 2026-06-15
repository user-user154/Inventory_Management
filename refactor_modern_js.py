#!/usr/bin/env python3
"""Convert GAS .gs files to modern JS style (arrow helpers, ===).

Logger.log auto-conversion is intentionally disabled — partial matches broke nested ${...}.
"""

import re
import glob
import os

ROOT = os.path.dirname(os.path.abspath(__file__))

KEEP_FUNCTION_DECL = {
    "onOpen",
    "onEdit",
    "onEditInstallable",
    "syncBudgetWeekdaysFromD2",
    "resetBacklogRelatedHistory",
}

FUNC_RE = re.compile(r"^function (\w+)(\((?:[^()]|\([^()]*\))*\)) \{", re.MULTILINE)
EQ_RE = re.compile(r"(?<![!=<>])==(?!=)")


def convert_functions(content: str) -> str:
    def repl(m: re.Match) -> str:
        name, args = m.group(1), m.group(2)
        if name in KEEP_FUNCTION_DECL:
            return m.group(0)
        return f"const {name} = {args} => {{"

    return FUNC_RE.sub(repl, content)


def convert_logger(content: str) -> str:
    return content


def convert_equals(content: str) -> str:
    content = content.replace("== null", "\0EQNULL\0")
    content = content.replace("!= null", "\0NEQNULL\0")
    content = EQ_RE.sub("===", content)
    content = content.replace("\0EQNULL\0", "== null")
    content = content.replace("\0NEQNULL\0", "!= null")
    return content


def process_file(path: str) -> None:
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    original = content
    content = convert_functions(content)
    content = convert_logger(content)
    content = convert_equals(content)
    if content != original:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"updated: {os.path.basename(path)}")


def main():
    for path in sorted(glob.glob(os.path.join(ROOT, "*.gs"))):
        process_file(path)


if __name__ == "__main__":
    main()
