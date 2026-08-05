from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" if (ROOT / "frontend" / "index.html").exists() else ROOT
INDEX = (FRONTEND / "index.html").read_text(encoding="utf-8")
APP = (FRONTEND / "app.js").read_text(encoding="utf-8")
STYLES = (FRONTEND / "styles.css").read_text(encoding="utf-8")


def test_page_has_mobile_and_landmark_contracts():
    assert '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' in INDEX
    assert '<a class="skip-link" href="#content">' in INDEX
    assert '<header id="topbar">' in INDEX
    assert '<nav id="sidebar" aria-label="因子目录">' in INDEX
    assert '<main id="content" tabindex="-1">' in INDEX
    assert '<label class="visually-hidden" for="factor-search">' in INDEX


def test_analysis_modes_use_keyboard_tab_semantics():
    assert 'id="mode-switch" role="tablist"' in INDEX
    assert INDEX.count('role="tab"') == 4
    assert INDEX.count('role="tabpanel"') == 4
    assert 'b.setAttribute("aria-selected", String(active))' in APP
    assert 'e.key === "ArrowRight" || e.key === "ArrowDown"' in APP
    assert 'if (e.key === "Home") nextIndex = 0' in APP


def test_dynamic_click_targets_are_native_controls():
    assert 'document.createElement("button")' in APP
    assert 'head.setAttribute("aria-expanded", String(!collapsed))' in APP
    assert 'l3Div.setAttribute("aria-pressed", "false")' in APP
    assert '<button type="button" class="n-chip"' in APP
    assert '<button type="button" class="cmp-remove"' in APP
    assert '<button type="button" class="cps-remove"' in APP
    assert '<button type="button" class="cps-saved-rm"' in APP
    assert '<button type="button" class="cps-saved-rename"' in APP
    assert '<button type="button" class="ftag ftag-${t} tagfilter"' in APP
    assert '<button type="button" class="stock-detail-btn"' in APP
    assert '<span class="n-chip"' not in APP
    assert '<span class="cmp-remove"' not in APP
    assert '<span class="cps-remove"' not in APP


def test_sortable_headers_support_keyboard_and_announce_direction():
    assert "function bindSortableHeader(th, handler, sortDirection = null)" in APP
    assert 'th.setAttribute("aria-sort", sortDirection || "none")' in APP
    assert 'event.key !== "Enter" && event.key !== " "' in APP
    assert APP.count("bindSortableHeader(th, () =>") >= 4


def test_stock_modal_traps_and_restores_focus():
    assert 'id="stock-modal" class="modal-overlay" hidden' in INDEX
    assert 'aria-labelledby="stock-modal-title" tabindex="-1"' in INDEX
    assert "function trapStockModalFocus(event)" in APP
    assert "el.inert = true" in APP
    assert "el.inert = false" in APP
    assert "requestAnimationFrame(() => trigger.focus())" in APP
    assert 'overlay.querySelector(".sd-close")?.focus()' in APP


def test_styles_remove_locked_viewport_and_cover_mobile_layout():
    assert "height: 100vh; overflow: hidden" not in STYLES
    assert "grid-template-columns: minmax(190px, 240px) minmax(0, 1fr)" in STYLES
    assert "@media (max-width: 760px)" in STYLES
    assert "#main { display: block; }" in STYLES
    assert "#sidebar { position: static; max-height: 38dvh" in STYLES
    assert "@media (pointer: coarse)" in STYLES
    assert "min-height: 44px" in STYLES
    assert "@media (prefers-reduced-motion: reduce)" in STYLES


def test_contrast_and_focus_tokens_cover_old_muted_text_and_nav():
    assert "--text-muted: #5f6b7a" in STYLES
    assert ".nav-link { color: #fff" in STYLES
    assert ':where(a, button, input, select, summary, [tabindex]):focus-visible' in STYLES
    for old_color in ("#777", "#888", "#999", "#aaa", "#bbb"):
        assert f'[style*="color:{old_color}"]' in STYLES
    for accessible_tag_color in ("#9f2d23", "#24663f", "#76500d", "#17623f", "#14636b", "#7d4f0a", "#9c3c13", "#4b5563"):
        assert accessible_tag_color in STYLES
