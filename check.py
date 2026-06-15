import csv
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
POS_FILE = SCRIPT_DIR / "pos.csv"
RECIPE_FILE = SCRIPT_DIR / "recipe.csv"
MENU_HEADER = "統一商品名"
MAX_HEADER_SCAN_ROWS = 20
SEP_LINE = "\n" + "=" * 50


def open_text_file(path):
    """UTF-8(BOM付き) → CP932 の順で読み込む。"""
    for encoding in ("utf-8-sig", "utf-8", "cp932"):
        try:
            return open(path, mode="r", encoding=encoding, newline="")
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("", b"", 0, 1, "対応する文字コードがありません")


def detect_delimiter(line):
    return "\t" if "\t" in line else ","


def find_header_row(rows, required_headers):
    for i, row in enumerate(rows[:MAX_HEADER_SCAN_ROWS]):
        cells = [str(cell).strip() for cell in row]
        if all(header in cells for header in required_headers):
            return i, cells
    return None, None


def read_menu_names(path, required_headers=(MENU_HEADER,)):
    with open_text_file(path) as f:
        sample = f.readline()
        if not sample:
            return set(), []

        delimiter = detect_delimiter(sample)
        f.seek(0)
        rows = list(csv.reader(f, delimiter=delimiter))

    header_idx, headers = find_header_row(rows, required_headers)
    if header_idx is None:
        raise ValueError(
            f"{path.name} に「{'」「'.join(required_headers)}」の見出し行が見つかりません。"
        )

    name_idx = headers.index(MENU_HEADER)
    menus, duplicates = set(), []

    for row in rows[header_idx + 1 :]:
        if not row or name_idx >= len(row):
            continue
        name = str(row[name_idx]).strip()
        if not name:
            continue
        if name in menus:
            duplicates.append(name)
        menus.add(name)

    return menus, duplicates


def print_section(title, items, empty_msg, item_prefix):
    print(SEP_LINE)
    print(title)
    print("=" * 50)
    if not items:
        print(empty_msg)
    else:
        for item in items:
            print(f"{item_prefix} {item}")


def check_bidirectional_menu_mismatch():
    missing = [p.name for p in (POS_FILE, RECIPE_FILE) if not p.exists()]
    if missing:
        print(f"【エラー】{', '.join(missing)} が見つかりません。")
        print(f"配置先: {SCRIPT_DIR}")
        return 1

    try:
        pos_menus, _ = read_menu_names(POS_FILE)
        recipe_menus, _ = read_menu_names(RECIPE_FILE)
    except ValueError as err:
        print(f"【エラー】{err}")
        return 1

    only_in_recipe = sorted(recipe_menus - pos_menus)

    print(SEP_LINE)
    print(f"POS: {len(pos_menus)} 件 / レシピ: {len(recipe_menus)} 件")
    print("=" * 50)

    print_section(
        f"🔍 レシピ表にはあるが、POSデータに【ない】もの (計 {len(only_in_recipe)} 件)",
        only_in_recipe,
        "🎉 該当なし（レシピ表のメニューはすべてPOSに存在します）",
        "🔺",
    )

    print("=" * 50 + "\n")
    return 1 if only_in_recipe else 0


if __name__ == "__main__":
    sys.exit(check_bidirectional_menu_mismatch())
