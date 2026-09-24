#!/usr/bin/env python3
"""Shared page chrome, stamped into every page after the generators run. Idempotent.

1. Theme: a tiny script in <head> applies the visitor's saved theme before first paint
   (no flash), and a single header button flips light/dark (behaviour in assets/js/site.js).
2. Motion: no button. On the home pages the name in the header is the pause control (WCAG 2.2.2):
   fondo.js pauses everything and goes to the top, and a second press resumes. Any pause/play button
   an earlier run stamped is removed.
3. Scroll reveal: a tiny script in <head>, before the first stylesheet, marks <html> before first
   paint (mode "bold") so reveal.js never flashes content in and out. It stands down under OS
   reduced motion or the site's saved Pause, and lets everything through after 4 s whatever happens.
4. Fonts: Inter (the Apple layer's stand-in for SF Pro) right after the IBM Plex link.
5. Icons: every inline Lucide icon carries its own size and stroke attributes, so a stale or
   missing stylesheet can never render them huge or as black blobs (CSS still wins when loaded).
6. Scripts, deferred, in this order: site.js, the starfield module, reveal.js, fondo.js.
7. Cache-busting: site.css and every script are referenced as ?v=<content hash>, so a deploy that
   changes them is fetched fresh instead of mixing new HTML with an old cached asset.

The reveal snippet, the Inter link and the scripts after site.js are removed and written again on
every run, so the result depends only on the current assets; the buttons are added once.

    python3 scripts/build_projects.py && python3 scripts/build_experience.py \
      && LUCIDE_DIR=path/to/lucide-react python3 scripts/add_icons.py \
      && python3 scripts/add_logos.py && python3 scripts/stamp_chrome.py && python3 scripts/check_site.py
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
# The stylesheet hides the reveal targets while <html> has .reveal-pending; reveal.js takes over at
# DOMContentLoaded and drops it. Same checks as reveal.js: no reveal under reduced motion or Pause.
REVEAL_INIT = ('<script id="reveal-init">try{var r=document.documentElement;r.setAttribute("data-reveal","bold");'
               'if(!matchMedia("(prefers-reduced-motion: reduce)").matches&&localStorage.getItem("portfolio:motion")!=="off"){'
               'r.classList.add("reveal-pending");setTimeout(function(){r.classList.remove("reveal-pending")},4000)}}catch(e){}</script>')
INTER = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">'
LABELS = {"en": ("Switch to dark theme", "Switch to light theme"),
          "es": ("Cambiar a tema oscuro", "Cambiar a tema claro")}
# Header links: an icon plus a label; on phones the label is visually hidden (still read by screen
# readers) so the whole header fits on one row.
NAV_ICONS = (("#work", "briefcase"), ("#experience", "history"), ("#contact", "mail"), ("cv.pdf", "file-text"))
ICON_ATTRS = ('width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" '
              'stroke-linecap="round" stroke-linejoin="round" ')
# site.js first (fondo.js calls its window.__setMotion), then the starfield module fondo.js starts,
# reveal.js, and fondo.js last, once the module has registered on window.PortfolioBG.
SCRIPTS = ("assets/js/site.js", "assets/js/bg/starfield.js", "assets/js/reveal.js", "assets/js/fondo.js")
BUSTED = ("assets/css/site.css",) + SCRIPTS

# What this script rewrites on every run, each with its line break.
STRIP = (
    re.compile(r'\n[ \t]*<script id="reveal-init">.*?</script>'),
    re.compile(r'\n[ \t]*<link href="https://fonts\.googleapis\.com/css2\?family=Inter[^"]*" rel="stylesheet">'),
    re.compile(r'\n[ \t]*<script src="(?:\.\./)*assets/js/(?:bg/[A-Za-z0-9_-]+|reveal|fondo)\.js[^"]*" defer></script>'),
)
FIRST_STYLESHEET = re.compile(r'<link\b[^>]*\brel="stylesheet"[^>]*>')
PLEX = re.compile(r'<link href="https://fonts\.googleapis\.com/css2\?family=IBM\+Plex[^"]*" rel="stylesheet">')
SITE_JS = re.compile(r'<script src="((?:\.\./)*)assets/js/site\.js[^"]*" defer></script>')


def digest(rel: str) -> str:
    return hashlib.sha1((ROOT / rel).read_bytes()).hexdigest()[:8]


def line_indent(s: str, at: int) -> str:
    return s[s.rfind("\n", 0, at) + 1:at]


def main() -> int:
    missing = [rel for rel in BUSTED if not (ROOT / rel).is_file()]
    if missing:
        print("missing assets, nothing stamped:", ", ".join(missing))
        return 1
    v = {rel: digest(rel) for rel in BUSTED}
    counts = {"init": 0, "button": 0, "motion": 0, "nav": 0, "icons": 0, "busted": 0, "pages": 0, "changed": 0}
    for path in sorted(ROOT.rglob("*.html")):
        if ".git" in path.parts or path.name.startswith("_"):
            continue
        before = s = path.read_text(encoding="utf-8")
        lang = "es" if '<html lang="es">' in s else "en"
        for rx in STRIP:
            s = rx.sub("", s)
        # Reveal snippet: before the first stylesheet link (the IBM Plex font), so no CSS can block it.
        m = FIRST_STYLESHEET.search(s)
        assert m, f"{path}: no stylesheet link"
        s = s[:m.start()] + REVEAL_INIT + "\n" + line_indent(s, m.start()) + s[m.start():]
        m = PLEX.search(s)
        assert m, f"{path}: IBM Plex font link not found"
        s = s[:m.end()] + "\n" + line_indent(s, m.start()) + INTER + s[m.end():]
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
        # The name is the pause control now (fondo.js): drop the button earlier runs stamped.
        s, n = re.subn(r'<button type="button" class="motion-toggle"[^>]*>.*?</button>', "", s, flags=re.S)
        counts["motion"] += n

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
        # Scripts after site.js, at its indentation and with its ../ prefix.
        m = SITE_JS.search(s)
        assert m, f"{path}: site.js not found"
        up, indent = m.group(1), line_indent(s, m.start())
        tags = "".join(f'\n{indent}<script src="{up}{rel}" defer></script>' for rel in SCRIPTS[1:])
        s = s[:m.end()] + tags + s[m.end():]
        for rel in BUSTED:
            attr = "href" if rel.endswith(".css") else "src"
            s, n = re.subn(rf'({attr}="(?:\.\./)*{re.escape(rel)})(?:\?v=[0-9a-f]+)?"', rf'\1?v={v[rel]}"', s)
            assert n == 1, f"{path}: {rel} referenced {n} times"
            counts["busted"] += n
        assert s.count('id="reveal-init"') == 1 and s.count(INTER) == 1, path
        counts["pages"] += 1
        if s != before:
            path.write_text(s, encoding="utf-8")
            counts["changed"] += 1
    print(counts, {rel.rsplit("/", 1)[-1]: h for rel, h in v.items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
