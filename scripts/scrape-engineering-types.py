#!/usr/bin/env python3
"""
Scrapes Apple's "Engineering Type Reference" chapter from the Instruments
developer help book (https://help.apple.com/instruments/developer/mac/current/).

The help viewer is a client-rendered SPA ("eagle" framework) - the real content
is served as a navigation.json manifest (id -> {name, href, summary} for leaf
topics, and a separate "sections" tree for chapter/category nesting) plus one
plain HTML fragment per topic, all under:

    https://help.apple.com/instruments/developer/mac/current/en.lproj/

Usage:
    python3 scrape_engineering_types.py [output.json]
"""
import json
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser

BASE = "https://help.apple.com/instruments/developer/mac/current/en.lproj/"
NAV_URL = BASE + "navigation.json"
ENGINEERING_TYPE_REFERENCE_ID = "dev6df2abf96"  # confirmed via navigation.json's sections tree
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) engineering-type-scraper/1.0"
REQUEST_DELAY_SECONDS = 0.15  # be polite


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_json(url: str):
    return json.loads(fetch(url))


class TopicHTMLParser(HTMLParser):
    """Parses one engineering-type topic page into structured fields.

    Real page shape (verified against dev132645102.html and dev63504527.html):
      <h1>NAME Engineering Type</h1>
      <p>DESCRIPTION</p>
      <div class="Subhead"><h2>Usage</h2><table>...Attribute/Value rows (always 2 cols, td)...</table></div>
      <div class="Subhead"><h2>SECTION NAME</h2><p>free text</p></div>  (0+ more, e.g. "Encoding Notes")
      <div class="Subhead"><h2>SECTION NAME</h2><table>...N-col rows, th header row, td data rows...</table></div>
        (e.g. "Special Value Treatments" on Energy Impact: Value/Color/Icon, 3 cells/row via colspan)

    A non-"Usage" section can carry prose (<p> text, no table), a table (no <p> text),
    or in principle both — captured separately so neither clobbers the other. An
    earlier version of this parser only ever captured the "Usage" table and treated
    every other table as invisible, silently dropping Energy Impact's whole "Special
    Value Treatments" table — fixed by capturing ANY table's rows, not just Usage's.
    """

    def __init__(self):
        super().__init__()
        self.title = None
        self.description = None
        self.usage = {}  # Attribute -> Value, from the "Usage" table specifically
        self.sections = {}  # other Subhead section name -> {"text": str, "table": {"columns": [...], "rows": [[...]]}}
        self._stack = []
        self._current_h_level = None
        self._capturing_h1 = False
        self._capturing_desc_p = False
        self._seen_first_p = False
        self._current_section_name = None
        self._in_table = False
        self._in_row = False
        self._in_cell = False
        self._row_cells = []
        self._row_is_header = False
        self._cell_text = []
        self._text_buffer = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "h1":
            self._capturing_h1 = True
            self._text_buffer = []
        elif tag == "h2":
            self._text_buffer = []
            self._capturing_section_h2 = True
        elif tag == "p":
            if self.title is not None and not self._seen_first_p and not self._in_table:
                self._capturing_desc_p = True
                self._text_buffer = []
            elif self._current_section_name and not self._in_table:
                self._text_buffer = []
        elif tag == "table":
            self._in_table = True
        elif tag == "tr":
            self._in_row = True
            self._row_cells = []
            self._row_is_header = False
        elif tag in ("td", "th"):
            self._in_cell = True
            self._cell_text = []
            if tag == "th":
                self._row_is_header = True
        elif tag == "div" and attrs_dict.get("class", "").find("Subhead") != -1:
            self._current_section_name = None  # reset; set when h2 closes

    def _section_slot(self):
        return self.sections.setdefault(self._current_section_name, {})

    def handle_endtag(self, tag):
        if tag == "h1":
            self._capturing_h1 = False
            self.title = "".join(self._text_buffer).strip()
        elif tag == "h2":
            self._capturing_section_h2 = False
            self._current_section_name = "".join(self._text_buffer).strip()
        elif tag == "p":
            text = "".join(self._text_buffer).strip()
            if self._capturing_desc_p:
                self.description = text
                self._capturing_desc_p = False
                self._seen_first_p = True
            elif self._current_section_name and self._current_section_name != "Usage" and text and not self._in_table:
                slot = self._section_slot()
                slot.setdefault("text", [])
                slot["text"].append(text)
        elif tag == "table":
            self._in_table = False
        elif tag == "tr":
            self._in_row = False
            if self._current_section_name == "Usage":
                if len(self._row_cells) == 2:
                    key, val = self._row_cells
                    if key.lower() != "attribute":  # skip header row
                        self.usage[key] = val
            elif self._current_section_name and self._row_cells:
                slot = self._section_slot()
                if self._row_is_header:
                    slot["columns"] = self._row_cells
                else:
                    slot.setdefault("rows", [])
                    slot["rows"].append(self._row_cells)
        elif tag in ("td", "th"):
            self._in_cell = False
            self._row_cells.append("".join(self._cell_text).strip())

    def handle_data(self, data):
        if self._in_cell:
            self._cell_text.append(data)
        else:
            self._text_buffer.append(data)

    def finalize(self):
        for name, slot in self.sections.items():
            out = {}
            if "text" in slot:
                out["text"] = " ".join(t.strip() for t in slot["text"] if t.strip())
            if "rows" in slot:
                out["table"] = {"columns": slot.get("columns", []), "rows": slot["rows"]}
            self.sections[name] = out
        return {
            "title": self.title,
            "description": self.description,
            "usage": self.usage,
            "sections": self.sections,
        }


def parse_topic_html(html: str) -> dict:
    parser = TopicHTMLParser()
    parser.feed(html)
    return parser.finalize()


def collect_leaf_topic_ids(nav: dict, root_section_id: str):
    """Walks nav['sections'] from root_section_id, returns {category_name: [topic_id, ...]}."""
    sections = nav["sections"]
    root = sections[root_section_id]
    by_category = {}
    for cat_id in root["children"]:
        cat = sections.get(cat_id)
        if cat is None:
            continue  # shouldn't happen for this book, but don't assume
        by_category[cat["name"]] = list(cat["children"])
    return by_category


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "engineering_types.json"

    print(f"Fetching {NAV_URL} ...", file=sys.stderr)
    nav = fetch_json(NAV_URL)
    topics = nav["topics"]

    by_category = collect_leaf_topic_ids(nav, ENGINEERING_TYPE_REFERENCE_ID)
    total = sum(len(ids) for ids in by_category.values())
    print(f"Found {len(by_category)} categories, {total} engineering types total.", file=sys.stderr)
    for cat, ids in by_category.items():
        print(f"  {cat}: {len(ids)}", file=sys.stderr)

    result = {}
    count = 0
    for category, topic_ids in by_category.items():
        result[category] = []
        for topic_id in topic_ids:
            meta = topics.get(topic_id, {})
            href = meta.get("href")
            if not href:
                print(f"  ! {topic_id} has no href in navigation.json, skipping", file=sys.stderr)
                continue
            url = BASE + href
            try:
                html = fetch(url)
                parsed = parse_topic_html(html)
            except Exception as e:
                print(f"  ! failed to fetch/parse {topic_id} ({url}): {e}", file=sys.stderr)
                parsed = {"title": meta.get("name"), "description": meta.get("summary"), "usage": {}, "sections": {}}
            entry = {
                "id": topic_id,
                "name": parsed.get("title") or meta.get("name"),
                "summary": meta.get("summary"),
                "description": parsed.get("description"),
                "usage": parsed.get("usage", {}),
                "sections": parsed.get("sections", {}),
            }
            result[category].append(entry)
            count += 1
            print(f"  [{count}/{total}] {category} :: {entry['name']} ({entry['usage'].get('Mnemonic', '?')})", file=sys.stderr)
            time.sleep(REQUEST_DELAY_SECONDS)

    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nWrote {count} engineering types to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
