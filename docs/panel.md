# The panel

The SephiOGame panel is a floating window over the OGame page. This page covers how to open it, how it is placed, its tabs and layout, the visual design, and the update notice.

- [Opening the panel](#opening-the-panel)
- [Position, size and collapse](#position-size-and-collapse)
- [Header](#header)
- [Tabs](#tabs)
- [Responsive layout](#responsive-layout)
- [Visual design](#visual-design)
- [Update check](#update-check)
- [Additions to OGame’s own pages](#additions-to-ogames-own-pages)

---

## Opening the panel

- **Open by default**: the panel opens on every game page in the main window. Hidden worker frames never show it.
- **« Fermer »** hides it until the next page load (OGame reloads the page on almost every click, so it comes back).
- **Menu entry « SephiOGame »**: added to OGame’s left menu, right after « Simulation de combat ». Clicking it opens the panel.
- **Launcher button** « SephiOGame · Frigos » (bottom right): shown only when the left menu entry could not be added; toggles the panel.
- **Tampermonkey menu**: « Ouvrir SephiOGame », « Sauvegardes SephiOGame » (opens the Sauvegardes tab) and « Diagnostic de démarrage SephiOGame ».
- Some features open the panel on the relevant tab by themselves: an error, a discovery scan start, a campaign start, the « File automatique · détails » link under the construction queue.

The panel lives in a Shadow DOM attached to `#sephi-root`, so OGame’s styles do not affect it and its styles do not leak into the game.

---

## Position, size and collapse

Handled by `Panel.makeFloating()`.

- **Default place**: right below the Gameforge bar at the top of the page, centred in the free space to the left of the OGame layout, and using the full height down to the bottom margin. If that space is too narrow, it sits 16 px from the left edge.
- **Margins**: the panel always stays at least **16 px** from every edge of the window and never covers the Gameforge bar (`#mmonetbar`). The bar is added by OGame a moment after the page loads, so the script assumes its usual 32 px height until it exists, and checks the position again once the page has finished loading.
- **Move**: drag the header (buttons and links in the header stay clickable).
- **Resize**: drag the bottom-right corner. Minimum 300 × 140 px; never taller than the window.
- **Collapse**: « Réduire » (or a double-click on the header) keeps only the header; « Agrandir » restores it.
- **Memory**: position, size and collapsed state are saved in `<account>:window` and restored on the next page. Positions saved by older versions (which could sit in the corner over the bar) are ignored once and replaced by the default place.
- The position is re-checked when the browser window is resized.

---

## Header

- **SephiOGame** title (gradient text, pulsing dot), version and « userscript privé ».
- **Update notice** « ⬆ Mise à jour x.y.z » next to the title when a newer version is published (see [Update check](#update-check)).
- Countdown « Temps restant avant la prochaine auto attaque : … » (see [Auto-attacks](auto-attacks.md)).
- Account badge: player name · universe.
- « Fermer » and « Réduire » / « Agrandir », kept together on the right.

The header stays visible at the top while the panel content scrolls.

---

## Tabs

| Tab | Documentation |
|---|---|
| Frigos | [Frigos and reports](frigos-and-reports.md#the-frigos-tab) |
| Espionnage | [Frigos and reports](frigos-and-reports.md#the-espionnage-tab) |
| Découverte | [Discovery](discovery.md) |
| Auto-attaques | [Auto-attacks](auto-attacks.md) |
| Expéditions | [Auto expeditions](auto-expeditions.md) |
| Constructions | [Constructions](constructions.md) |
| Paramètres | [Settings](settings-backups-diagnostic.md#paramètres) and [Auto-éject](auto-eject.md) |
| Sauvegardes | [Backups](settings-backups-diagnostic.md#sauvegardes) |
| Diagnostic | [Diagnostic](settings-backups-diagnostic.md#diagnostic) |

A status line under the tabs shows the last message (green) or error (red); it disappears when empty.

---

## Responsive layout

The layout follows the **panel’s own width** (CSS container queries on `sephi`), not the browser window:

- **Wider than 600 px**: tables (for example the frigos) are shown as tables.
- **Up to 600 px**: each frigo becomes a card — name and coordinates on top, then « Butin estimé », « Dernier scan » and « État » with small labels, then the buttons in full-width rows.
- **Up to 380 px**: card details go to 2 columns.
- Forms use a grid that goes from 3 columns to 1 as the panel narrows; the header wraps instead of overflowing.
- Action buttons are grouped in rows that wrap with even spacing (`.btns`).

A small-screen rule (browser window under 650 px) also makes the panel nearly full-screen.

---

## Visual design

A dark « glass » theme defined in the `styles` constant (pure CSS, no images, fonts or libraries):

- **Panel**: translucent dark background with a light blur of the game behind it, a soft teal and indigo glow in the corners, a thin glowing border.
- **Accent**: a teal → indigo gradient (`--a1` `#46e0c8`, `--a2` `#7f8cff`), used for the active tab, the main buttons and the title.
- **Tabs**: one rounded bar; the active tab is a filled gradient pill.
- **Buttons**: three tones, chosen from the button text in `Panel.button()`:
  - *primary* (gradient) for « Enregistrer… », « Démarrer… », « Analyser », « Calculer », « Lancer… », « Programmer… », « Importer… », « Nouvelle campagne », and form submit buttons;
  - *danger* (reddish text, red glow) for « Supprimer », « Annuler », « Abandonner… », « Terminer… », « Écarter… »;
  - *default* for everything else.
- **Cards**: an accent bar before each title; the border lights up on hover.
- **Fields**: teal glow ring on focus.
- **Tables**: small uppercase headers; rows highlight on hover.
- **Status**: tinted box, red for errors.

Animations:

- the panel fades and rises in when it opens;
- buttons lift slightly on hover and press in on click;
- cards slide in one after another **when the tab changes** — background refreshes of the same tab (a campaign updating, for example) do not replay it;
- constant but light: the sweeping line under the header, the pulsing dot, the launcher’s ring, the update notice’s pulse, the shine on « Envoyer maintenant » in Expéditions.

All animations and transitions are turned off when the system asks for reduced motion (`prefers-reduced-motion`).

---

## Update check

Implemented by `checkForUpdate()`, `compareVersions()`, `Panel.showUpdate()` and `Panel.refreshUpdate()`.

- **Source**: the published file `https://raw.githubusercontent.com/dadoclear/sephi-ogame-reborn/main/sephi-ogame-reborn.user.js`. Its `@version` line is compared with the installed `VERSION`.
- **When**: at page load in the main window, at most once every **6 hours**; the result is cached in `sephiogame:update-check` so the notice shows immediately on the next pages. « Vérifier les mises à jour » in the Diagnostic tab forces a check.
- **How**: with `GM_xmlhttpRequest` under Tampermonkey (header `@grant GM_xmlhttpRequest`, `@connect raw.githubusercontent.com`), which is not subject to the game’s security rules; with a plain `fetch` otherwise.
- **Comparison**: `4.0.0-alpha.49 < 4.0.0-alpha.50 < 4.0.0-alpha.100`, `alpha < beta`, and a final `4.0.0` is newer than any `4.0.0-alpha.*`. A leading `v` is ignored.
- **Notice**: when the published version is newer, a pulsing orange pill « ⬆ Mise à jour x.y.z » appears next to the title (also when the panel is collapsed). Hovering shows the installed version.
- **Click**: opens the raw file in a new tab; Tampermonkey recognises the `.user.js` file and offers the update. The game tab stays as it is.

---

## Additions to OGame’s own pages

Besides the panel, the script adds small elements to the game pages. They are documented with their feature:

| Element | Where | Documentation |
|---|---|---|
| « SephiOGame » menu entry | Left menu | [above](#opening-the-panel) |
| Report toolbar (loot, PT/GT, add to frigos…) | Spy reports in Messages | [Frigos and reports](frigos-and-reports.md#in-the-messages-page) |
| ☆ Frigo / ★ Retirer buttons | Galaxy rows | [Frigos and reports](frigos-and-reports.md#in-the-galaxy) |
| Fleet preparation and notice box | Fleet page, bottom right | [Frigos and reports](frigos-and-reports.md#fleet-preparation-links) |
| Countdown bar | Overview | [Auto-attacks](auto-attacks.md#countdown) |
| Construction queue and « Programmer » buttons | Overview, Ressources, Installations, Recherche, Chantier spatial, Défense | [Constructions](constructions.md) |
| « Ressources en cours de retour » summary | Mouvements | [Frigos and reports](frigos-and-reports.md#returning-resources-summary) |
