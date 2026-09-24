#!/usr/bin/env python3
"""Shared page chrome, stamped into every page after the generators run. Idempotent.

1. Theme: a tiny script in <head> applies the visitor's saved theme before first paint
   (no flash), and a single header button flips light/dark (behaviour in assets/js/site.js).
2. Icons: every inline Lucide icon carries its own size and stroke attributes, so a stale or
   missing stylesheet can never render them huge or as black blobs (CSS still wins when loaded).
3. Cache-busting: site.css and site.js are referenced as ?v=<content hash>, so a deploy that
   changes them is fetched fresh instead of mixing new HTML with an old cached stylesheet.

    python3 scripts/build_projects.py && python3 scripts/add_icons.py \
      && python3 scripts/add_logos.py && python3 scripts/stamp_chrome.py
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from add_icons import icon  # noqa: E402

INIT = ('<script id="theme-init">try{var t=localStorage.getItem("portfolio:theme");'
        'if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>')
LABELS = {"en": ("Switch to dark theme", "Switch to light theme"),
          "es": ("Cambiar a tema oscuro", "Cambiar a tema claro")}
# Header links: an icon plus a label; on phones the label is visually hidden (still read by screen
# readers) so the whole header fits on one row.
NAV_ICONS = (("#work", "briefcase"), ("#experience", "history"), ("#contact", "mail"), ("cv.pdf", "file-text"))
ICON_ATTRS = ('width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" '
              'stroke-linecap="round" stroke-linejoin="round" ')


def digest(rel: str) -> str:
    return hashlib.sha1((ROOT / rel).read_bytes()).hexdigest()[:8]


def main() -> int:
    css_v, js_v = digest("assets/css/site.css"), digest("assets/js/site.js")
    counts = {"init": 0, "button": 0, "nav": 0, "icons": 0, "busted": 0}
    for path in sorted(ROOT.rglob("*.html")):
        if ".git" in path.parts or path.name.startswith("_"):
            continue
        s = path.read_text(encoding="utf-8")
        lang = "es" if '<html lang="es">' in s else "en"
        if 'id="theme-init"' not in s:
            i = s.index('<link rel="stylesheet"')
            s = s[:i] + INIT + "\n  " + s[i:]
            counts["init"] += 1
        if 'class="theme-toggle"' not in s:
            to_dark, to_light = LABELS[lang]
            button = (f'<button type="button" class="theme-toggle" data-to-dark="{to_dark}" data-to-light="{to_light}" '
                      f'aria-label="{to_dark}" title="{to_dark}">{icon("moon", "i moon")}{icon("sun", "i sun")}</button>')
            s, n = re.subn(r'(<span class="lang"[^>]*>(?:(?!</nav>).)*?</span>)(\s*</nav>)',
                           lambda m: m.group(1) + button + m.group(2), s, count=1, flags=re.S)
            assert n == 1, f"{path}: language switch not found"
            counts["button"] += 1
        def link(a: re.Match) -> str:
            # Only plain-text links match, so a link that already has its icon is left alone.
            href, attrs, label = a.group(1), a.group(2), a.group(3)
            for suffix, name in NAV_ICONS:
                if href.endswith(suffix):
                    counts["nav"] += 1
                    return f'<a href="{href}"{attrs}>{icon(name)}<span class="nav-label">{label}</span></a>'
            return a.group(0)

        def nav_links(m: re.Match) -> str:
            return re.sub(r'<a href="([^"]+)"([^>]*)>([^<]+)</a>', link, m.group(0))
        s = re.sub(r'<nav class="nav"[^>]*>.*?</nav>', nav_links, s, count=1, flags=re.S)
        s, n = re.subn(r'<svg class="(i[^"]*)" viewBox="0 0 24 24" aria-hidden="true"',
                       lambda m: f'<svg class="{m.group(1)}" viewBox="0 0 24 24" {ICON_ATTRS}aria-hidden="true"', s)
        counts["icons"] += n
        s, a = re.subn(r'(href="(?:\.\./)*assets/css/site\.css)(?:\?v=[0-9a-f]+)?"', rf'\1?v={css_v}"', s)
        s, b = re.subn(r'(src="(?:\.\./)*assets/js/site\.js)(?:\?v=[0-9a-f]+)?"', rf'\1?v={js_v}"', s)
        counts["busted"] += a + b
        path.write_text(s, encoding="utf-8")
    print(counts, {"css": css_v, "js": js_v})
    return 0


if __name__ == "__main__":
    sys.exit(main())
