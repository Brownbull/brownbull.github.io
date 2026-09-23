#!/usr/bin/env python3
"""Pre-publish gate for the portfolio site.

Run from the repo root before every push (the Pages workflow runs it too):

    python3 scripts/check_site.py            # local checks only
    python3 scripts/check_site.py --external # also HEAD-check external links

Fails (exit 1) on:
  - placeholders still present (class="pending" or data-pending="<id>")
  - broken local links / missing local files / missing #fragment targets
  - root-relative links ("/x") — they break when the site is served under /<repo>/
  - <img> without alt; pages without <html lang>, a head <title>, meta description,
    og:image or rel=canonical
  - anything that looks like a phone number, or an email other than the contact
    address, in page text, attributes, comments, Markdown or PDFs (the site is
    public and indexed)

Warns (exit 0) on:
  - the word "production" — personal projects must never be called production;
    each hit needs a human look (Experian work is the only allowed context)
"""
from __future__ import annotations

import re
import sys
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTACT_EMAIL = "carcamo.gabriel@gmail.com"
SITE_ORIGIN = "https://brownbull.github.io"
# +56 9 XXXX XXXX, or two space-separated 4-digit groups (hyphenated year ranges do not match).
PHONE = re.compile(r"(\+?56[\s-]?9[\s-]?\d{4}[\s-]?\d{4})|((?<![\d-])\d{4} \d{4}(?![\d-]))")
EMAIL = re.compile(r"[\w.+-]+(?:@|&#64;)[\w-]+(?:\.[\w-]+)+")
PRODUCTION = re.compile(r"\bproduction\b", re.IGNORECASE)
SCANNED_ATTRS = ("alt", "title", "aria-label", "content", "href")


class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.refs: list[tuple[str, str, int]] = []  # (attr, value, line)
        self.ids: set[str] = set()
        self.problems: list[str] = []
        self.has_lang = False
        self.has_title = False
        self.has_description = False
        self.has_og_image = False
        self.has_canonical = False
        self.text_chunks: list[tuple[str, int]] = []
        self._in_script_or_style = 0
        self._in_svg = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        line = self.getpos()[0]
        if a.get("id"):
            self.ids.add(a["id"])
        if tag == "html" and a.get("lang"):
            self.has_lang = True
        if tag == "svg":
            self._in_svg += 1
        if tag == "title" and not self._in_svg:  # an SVG <title> is not the page title
            self.has_title = True
        if tag == "meta" and a.get("name") == "description" and a.get("content"):
            self.has_description = True
        if tag == "meta" and a.get("property") == "og:image" and a.get("content"):
            self.has_og_image = True
        if tag == "link" and a.get("rel") == "canonical" and a.get("href"):
            self.has_canonical = True
        if tag in ("script", "style"):
            self._in_script_or_style += 1
        classes = (a.get("class") or "").split()
        if "pending" in classes or "data-pending" in a:
            self.problems.append(f"line {line}: placeholder still present ({a.get('data-pending') or 'pending'})")
        if tag == "img" and a.get("alt") is None:
            self.problems.append(f"line {line}: <img> without alt")
        # A preconnect/dns-prefetch origin or our own canonical URL is not a link a
        # visitor follows; the canonical target is checked locally as a file.
        skip_ref = tag == "link" and (a.get("rel") or "") in ("preconnect", "dns-prefetch", "canonical")
        for attr in ("href", "src", "poster", "srcset"):
            if a.get(attr) and not skip_ref:
                value = a[attr].split(",")[0].strip().split(" ")[0] if attr == "srcset" else a[attr]
                self.refs.append((attr, value, line))
        for k, v in attrs:
            if v and k in SCANNED_ATTRS:
                self.text_chunks.append((v, line))

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._in_script_or_style:
            self._in_script_or_style -= 1
        if tag == "svg" and self._in_svg:
            self._in_svg -= 1

    def handle_data(self, data):
        if not self._in_script_or_style and data.strip():
            self.text_chunks.append((data, self.getpos()[0]))

    def handle_comment(self, data):
        if data.strip():
            self.text_chunks.append((data, self.getpos()[0]))


def scan_text(rel: str, text: str, line: int | str, failures: list[str], warnings: list[str]) -> None:
    where = f"{rel}:{line}"
    if PHONE.search(text):
        failures.append(f"{where}: looks like a phone number → '{text.strip()[:60]}'")
    for addr in EMAIL.findall(text):
        if addr.replace("&#64;", "@").lower() != CONTACT_EMAIL:
            failures.append(f"{where}: email other than the contact address → '{addr}'")
    if PRODUCTION.search(text):
        warnings.append(f"{where}: 'production' — confirm it refers to Experian → '{text.strip()[:80]}'")


def check_external(url: str) -> str | None:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "portfolio-link-check"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return None if resp.status < 400 else f"HTTP {resp.status}"
    except urllib.error.HTTPError as exc:
        # Hosts that refuse HEAD or bots; not broken links. 999 = LinkedIn's bot wall.
        if exc.code in (403, 405, 429, 999):
            return None
        return f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 — report any network failure as a finding
        return type(exc).__name__


def main() -> int:
    external = "--external" in sys.argv
    published = [p for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts and ".github" not in p.parts]
    pages = sorted(p for p in published if p.suffix == ".html")
    parsed: dict[Path, Page] = {}
    for path in pages:
        page = Page()
        page.feed(path.read_text(encoding="utf-8"))
        parsed[path] = page

    failures: list[str] = []
    warnings: list[str] = []
    external_urls: dict[str, list[str]] = {}

    for path, page in parsed.items():
        rel = str(path.relative_to(ROOT))
        failures += [f"{rel}: {p}" for p in page.problems]
        for ok, what in (
            (page.has_lang, "<html> without lang"),
            (page.has_title, "missing head <title>"),
            (page.has_description, "missing meta description"),
            (page.has_og_image, "missing og:image (Q1 · set once the final URL is known)"),
            (page.has_canonical, "missing rel=canonical (Q1 · set once the final URL is known)"),
        ):
            if not ok:
                failures.append(f"{rel}: {what}")

        for attr, value, line in page.refs:
            if value.startswith(("http://", "https://")):
                external_urls.setdefault(value, []).append(f"{rel}:{line}")
                continue
            if value.startswith(("mailto:", "tel:", "data:", "//")):
                if value.startswith("tel:"):
                    failures.append(f"{rel}:{line}: tel: link — no phone numbers on a public site")
                continue
            if value.startswith("/"):
                failures.append(f"{rel}:{line}: root-relative {attr}='{value}' breaks under a /<repo>/ path — use a relative path")
                continue
            target, _, fragment = value.partition("#")
            target = target.split("?")[0]
            if not target:  # same-page fragment
                if fragment and fragment not in page.ids:
                    failures.append(f"{rel}:{line}: #{fragment} has no matching id")
                continue
            resolved = (path.parent / target).resolve()
            if resolved.is_dir():
                resolved = resolved / "index.html"
            if not resolved.exists():
                failures.append(f"{rel}:{line}: {attr}='{value}' → missing file")
            elif fragment and resolved.suffix == ".html":
                other = parsed.get(resolved)
                if other and fragment not in other.ids:
                    failures.append(f"{rel}:{line}: {value} → no id '{fragment}' in target")

        for text, line in page.text_chunks:
            scan_text(rel, text, line, failures, warnings)

    # Markdown and PDFs are published too (README renders on GitHub; cv.pdf is linked).
    for extra in sorted(p for p in published if p.suffix in (".md", ".pdf")):
        rel = str(extra.relative_to(ROOT))
        if extra.suffix == ".pdf":
            try:
                from pypdf import PdfReader
            except ImportError:
                failures.append(f"{rel}: cannot scan PDF (pip install pypdf) — refusing to pass")
                continue
            try:
                text = "\n".join(pg.extract_text() or "" for pg in PdfReader(extra).pages)
            except Exception as exc:  # noqa: BLE001 — an unreadable PDF must not pass silently
                failures.append(f"{rel}: cannot read PDF ({type(exc).__name__}) — refusing to pass")
                continue
            if not text.strip():
                failures.append(f"{rel}: PDF has no extractable text — cannot verify it; refusing to pass")
                continue
        else:
            text = extra.read_text(encoding="utf-8")
        for n, row in enumerate(text.splitlines(), 1):
            scan_text(rel, row, n, failures, warnings)

    if external:
        for url, where in sorted(external_urls.items()):
            if url.startswith(SITE_ORIGIN):  # our own pages: checked above as local files
                continue
            err = check_external(url)
            if err:
                failures.append(f"{url} ({err}) ← {', '.join(where)}")

    for w in warnings:
        print(f"WARN  {w}")
    for f in failures:
        print(f"FAIL  {f}")
    checked = f"{len(pages)} pages, {sum(len(p.refs) for p in parsed.values())} refs"
    if external:
        checked += f", {len(external_urls)} external URLs"
    if failures:
        print(f"\n✗ {len(failures)} failure(s), {len(warnings)} warning(s) — {checked}")
        return 1
    print(f"\n✓ 0 failures, {len(warnings)} warning(s) — {checked}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
