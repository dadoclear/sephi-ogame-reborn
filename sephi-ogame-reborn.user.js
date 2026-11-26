// ==UserScript==
// @name         SephiOGame
// @namespace    sephiogame:local
// @version      4.0.0-alpha.51
// @description  Frigos, rapports et preparation de flotte directement dans OGame
// @author       Sephizack and contributors
// @match        https://*.ogame.gameforge.com/game/index.php*
// @run-at       document-end
// @sandbox      JavaScript
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/core/model.ts
  var defaults = { smallCargo: 5e3, largeCargo: 25e3, lootFactor: 0.5, defaultProbes: 1, minimumLoot: 1e4, autoAttackIntervalMinutes: 360, fleetWaitTimeoutMinutes: 10, reservedFleetSlots: 1, autoAttackMode: "interval", freeSlotsTrigger: 3, attackIdleSeconds: 60, homePlanetId: "", maxAttackWaves: 10, autoEject: {} };
  var emptyData = () => ({ schemaVersion: 4, targets: [], discoveryBanned: [], discoveryBigFish: [], settings: { ...defaults, autoEject: {} }, legacyArchives: [], constructionQueue: [] });
  function coordinates(galaxy, system, position, type = "planet") {
    const values = [galaxy, system, position].map(Number);
    if (values.some((v) => !Number.isSafeInteger(v) || v < 1) || values[0] > 99 || values[1] > 999 || values[2] > 15)
      throw new Error("Coordonn\xE9es invalides : galaxie 1\u201399, syst\xE8me 1\u2013999, position 1\u201315.");
    if (type !== "planet" && type !== "moon") throw new Error("Type de cible invalide.");
    return { galaxy: values[0], system: values[1], position: values[2], type };
  }
  function parseCoords(text, type = "planet") {
    const match = text.match(/\[?\s*(\d+)\s*:\s*(\d+)\s*:\s*(\d+)\s*\]?/);
    if (!match) throw new Error("Coordonn\xE9es introuvables. Exemple : [2:143:7].");
    return coordinates(match[1], match[2], match[3], /lune|moon/i.test(text) ? "moon" : type);
  }
  var targetId = (c) => `${c.galaxy}:${c.system}:${c.position}:${c.type}`;
  var formatCoords = (c) => `[${c.galaxy}:${c.system}:${c.position}]${c.type === "moon" ? " Lune" : ""}`;
  function createTarget(coords, name, probes = 1) {
    return {
      id: targetId(coords),
      coords,
      name,
      enabled: true,
      probeCount: probes,
      customFleet: "",
      ignore: false,
      notes: "",
      tags: [],
      updatedAt: Date.now(),
      history: []
    };
  }
  function calculateLoot(resources, factor) {
    if (!Number.isFinite(factor) || factor < 0 || factor > 1) throw new Error("Pillage : valeur entre 0 et 100 %.");
    const values = Object.values(resources);
    if (values.some((v) => !Number.isSafeInteger(v) || v < 0)) throw new Error("Ressources invalides.");
    const total = values.reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(total)) throw new Error("Total de ressources trop \xE9lev\xE9.");
    return Math.floor(total * factor);
  }
  function calculateRequiredCargo(loot, capacity) {
    if (!Number.isSafeInteger(loot) || loot < 0 || !Number.isSafeInteger(capacity) || capacity <= 0)
      throw new Error("Butin ou capacit\xE9 invalide.");
    return Math.ceil(loot / capacity);
  }
  function recordReport(target, report) {
    if (targetId(report.coords) !== target.id) throw new Error("Rapport destin\xE9 \xE0 une autre cible.");
    const signature = (r) => JSON.stringify([r.observedAt, r.resources, r.fleet, r.defense, r.lootFactor]);
    const history2 = [...target.history.filter((r) => signature(r) !== signature(report)), report].sort((a, b) => a.observedAt - b.observedAt).slice(-20);
    if (target.lastReport && target.lastReport.observedAt > report.observedAt) return { ...target, history: history2 };
    return {
      ...target,
      lastReport: report,
      history: history2,
      updatedAt: Date.now(),
      ...report.fleet !== void 0 ? { lastObservedFleet: report.fleet, knownFleet: target.knownFleet ?? report.fleet } : {},
      ...report.defense !== void 0 ? { lastObservedDefense: report.defense, knownDefense: target.knownDefense ?? report.defense } : {}
    };
  }
  function targetStatus(t) {
    if (t.ignore) return "Ignor\xE9";
    if (!t.enabled) return "D\xE9sactiv\xE9";
    const r = t.lastReport;
    if (!r || r.fleet === void 0 || r.defense === void 0) return "Informations incompl\xE8tes";
    if (t.knownFleet !== void 0 && r.fleet !== t.knownFleet || t.knownDefense !== void 0 && r.defense !== t.knownDefense)
      return "Flotte / d\xE9fense modifi\xE9e";
    return r.fleet > 0 || r.defense > 0 ? "Flotte / d\xE9fense pr\xE9sente" : "Aucune flotte / d\xE9fense observ\xE9e";
  }
  function attackReportWarning(report) {
    const dangers = [];
    if (report?.fleet > 0) dangers.push(`flotte détectée (${report.fleet})`);
    if (report?.defense > 0) dangers.push(`défenses détectées (${report.defense})`);
    if (dangers.length) return `Attaque bloquée · ${dangers.join(" et ")}`;
    if (report?.fleet !== 0 || report?.defense !== 0) return "Attaque bloquée · flotte ou défenses inconnues; rapport insuffisant";
    return "";
  }

  // src/ogame/selectors.ts
  var selectors = {
    reports: '.msg, .detail_msg, .message[data-msg-id], [data-report-type="espionage"]',
    title: '.msgTitle, .msg_title, .message-title, .detail_msg_head, [data-role="report-title"]',
    actions: '.msg_actions, .message-actions, [data-role="report-actions"]',
    galaxyRows: '#galaxycomponent .galaxyRow.ctContentRow, #galaxyContent .galaxyRow.ctContentRow, #galaxytable .row, #galaxytable tr, .galaxyTable .row, [data-role="galaxy-row"]',
    galaxyPosition: ".cellPosition, .position, [data-position]",
    galaxyName: ".cellPlanetName, .planetname, .planet-name, .cellPlayerName, .playername",
    galaxyInput: "#galaxy_input, #galaxy",
    systemInput: "#system_input, #system",
    galaxyMoon: '.cellMoon [data-moon-id], .moonlink, a[href*="type=3"], .moon img',
    galaxyActions: ".cellAction, .cellActions, .action, .cellPlanetName",
    rawReport: ".rawMessageData",
    resources: {
      metal: '[data-resource="metal"], .resource_list .metal, .resources .metal, .resspan.metal, #resources_metal',
      crystal: '[data-resource="crystal"], .resource_list .crystal, .resources .crystal, .resspan.crystal, #resources_crystal',
      deuterium: '[data-resource="deuterium"], .resource_list .deuterium, .resources .deuterium, .resspan.deuterium, #resources_deuterium'
    },
    moon: 'figure.moon, .moonIcon, [data-target-type="moon"]',
    fleet: '[data-stat="fleet"]',
    defense: '[data-stat="defense"]'
  };

  // src/ogame/adapter.ts
  function getPlayerContext(doc = document, url = new URL(location.href)) {
    const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.content;
    const playerId = meta("ogame-player-id");
    if (!playerId) return void 0;
    return {
      playerId,
      playerName: meta("ogame-player-name") ?? playerId,
      universe: url.host,
      locale: meta("ogame-language") ?? doc.documentElement.lang ?? "fr",
      planetId: meta("ogame-planet-id") ?? url.searchParams.get("cp") ?? "",
      page: url.searchParams.get("component") ?? url.searchParams.get("page") ?? "unknown"
    };
  }
  function actionURL(c, action, planetId = "", base = location.href) {
    const url = new URL("/game/index.php", base);
    if (!/^s[^.]+\.ogame\.gameforge\.com$/.test(url.hostname)) throw new Error("Cette action n\xE9cessite une page OGame.");
    url.searchParams.set("page", "ingame");
    url.searchParams.set("component", action === "galaxy" ? "galaxy" : "fleetdispatch");
    for (const field of ["galaxy", "system", "position"]) url.searchParams.set(field, String(c[field]));
    url.searchParams.set("type", c.type === "moon" ? "3" : "1");
    if (action !== "galaxy") url.searchParams.set("mission", action === "attack" ? "1" : "6");
    if (planetId) url.searchParams.set("cp", planetId);
    return url.href;
  }
  function galaxyTarget(row) {
    if (row.querySelector(".ownPlayerRow")) return void 0;
    const galaxy = row.getAttribute("data-galaxy") ?? document.querySelector(selectors.galaxyInput)?.value;
    const system = row.getAttribute("data-system") ?? document.querySelector(selectors.systemInput)?.value;
    const pos = row.getAttribute("data-position") ?? row.id.match(/^galaxyRow(\d+)$/)?.[1] ?? row.querySelector(selectors.galaxyPosition)?.textContent?.trim();
    const clean = row.cloneNode(true);
    clean.querySelectorAll("[data-sephi-toolbar]").forEach((n) => n.remove());
    const name = clean.querySelector(selectors.galaxyName)?.textContent?.trim();
    if (!name) return void 0;
    try {
      return { coords: coordinates(galaxy, system, pos), name };
    } catch {
      return void 0;
    }
  }
  function observeDOM(callback) {
    let scheduled = false;
    const observer = new MutationObserver((records) => {
      if (records.every((r) => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest("#sephi-root, [data-sephi-toolbar]"))) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        callback();
      });
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-value", "data-galaxy", "data-system", "data-position", "class", "data-messages-filters-metal", "data-messages-filters-crystal", "data-messages-filters-deuterium", "data-messages-filters-coordinates", "data-raw-fleetvalue", "data-raw-defensevalue"]
    });
    callback();
    return () => observer.disconnect();
  }

  // src/ogame/reports.ts
  function parseNumber(input) {
    const clean = input.trim().replace(/[\s\u00a0\u202f]/g, "").replace(/Mn$/i, "M").replace(/Bn$/i, "B");
    const m = clean.match(/^(\d[\d.,]*)([kKmMbB])?$/);
    if (!m) throw new Error(`Nombre non reconnu : ${input}`);
    let digits = m[1];
    if (m[2]) {
      if ((digits.match(/[.,]/g) ?? []).length > 1) throw new Error(`Nombre abr\xE9g\xE9 ambigu : ${input}`);
      digits = digits.replace(",", ".");
    } else {
      if (/[.,]/.test(digits) && !/^\d{1,3}([.,]\d{3})+$/.test(digits)) throw new Error(`Nombre ambigu : ${input}`);
      digits = digits.replace(/[.,]/g, "");
    }
    const multiplier = m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1 : 1;
    const result = Math.round(Number(digits) * multiplier);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error("Nombre trop \xE9lev\xE9.");
    return result;
  }
  var labels = { metal: "m\xE9tal|metal", crystal: "cristal|crystal", deuterium: "deut\xE9rium|deuterium" };
  function labeled(text, label) {
    const m = text.match(new RegExp(`(?:${label})\\s*:?\\s*(\\d[\\d.,\\s\\u00a0\\u202f]*[kKmMbB]?)`, "i"));
    if (!m) return void 0;
    try {
      return parseNumber(m[1]);
    } catch {
      return void 0;
    }
  }
  function numericElement(element2) {
    const exact = element2.getAttribute("data-value") ?? element2.querySelector("[data-value]")?.getAttribute("data-value");
    const candidates = [exact, element2.getAttribute("title"), element2.querySelector(".value, .amount")?.textContent, element2.textContent];
    for (const value of candidates) {
      if (!value) continue;
      try {
        return parseNumber(value);
      } catch {
      }
      for (const label of Object.values(labels)) {
        const n = labeled(value, label);
        if (n !== void 0) return n;
      }
    }
    return void 0;
  }
  function parseSpyTarget(root) {
    const title = root.querySelector(selectors.title)?.textContent ?? root.textContent ?? "";
    const raw = root.querySelector(selectors.rawReport);
    const isExplicit = root.matches('[data-report-type="espionage"]') || /espion|spy report/i.test(title) || !!root.querySelector(".espionageInfo") || !!raw?.hasAttribute("data-raw-counterespionagechance");
    if (!isExplicit) throw new Error("Ce contenu ne semble pas \xEAtre un rapport d\u2019espionnage.");
    const coordsText = root.getAttribute("data-messages-filters-coordinates") || title;
    const isMoon = raw?.getAttribute("data-raw-targetplanettype") === "3" || root.getAttribute("data-target-type") === "moon" || !!root.querySelector(selectors.moon);
    const coords = parseCoords(coordsText, isMoon ? "moon" : "planet");
    const name = (root.getAttribute("data-messages-filters-playername") || root.getAttribute("data-player-name") || raw?.getAttribute("data-raw-playername") || title.replace(/rapport d[’'`]?espionnage|espionage report|spy report/ig, "").replace(/\[.*?\]/g, "").trim()).replace(/&nbsp;/g, " ").slice(0, 500);
    return { coords, name: name || "Cible" };
  }
  function parseEspionageReport(root) {
    const { coords, name } = parseSpyTarget(root);
    const raw = root.querySelector(selectors.rawReport);
    const clone = root.cloneNode(true);
    clone.querySelectorAll("[data-sephi-toolbar], script, style").forEach((n) => n.remove());
    const text = clone.textContent ?? "";
    const resources = {};
    for (const key of ["metal", "crystal", "deuterium"]) {
      const el = clone.querySelector(selectors.resources[key]);
      const attribute = root.getAttribute(`data-messages-filters-${key}`);
      const value = (attribute !== null && attribute !== "" ? parseNumber(attribute.replace(/^[^\d+-]*/, "")) : void 0) ?? (el ? numericElement(el) : void 0) ?? labeled(text, labels[key]);
      if (value === void 0) throw new Error(`Ressource ${key} absente ou illisible. Ouvrez le rapport d\xE9taill\xE9.`);
      resources[key] = value;
    }
    const fleetEl = clone.querySelector(selectors.fleet), defenseEl = clone.querySelector(selectors.defense);
    const stat = (key, fallback) => {
      const filter = root.getAttribute(`data-messages-filters-${key}`);
      if (filter === "-") return void 0;
      const exact = raw?.getAttribute(`data-raw-${key}value`);
      if (exact !== null && exact !== void 0 && exact !== "" && exact !== "-") return parseNumber(exact);
      if (filter !== null && filter !== "") {
        try {
          return parseNumber(filter);
        } catch {
          return void 0;
        }
      }
      return fallback();
    };
    const fleet = stat("fleet", () => (fleetEl ? numericElement(fleetEl) : void 0) ?? labeled(text, "flottes?|fleets?"));
    const defense = stat("defense", () => (defenseEl ? numericElement(defenseEl) : void 0) ?? labeled(text, "d\xE9fense|defense|defence"));
    const lootMatch = text.match(/(?:pillage|loot)\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i);
    const lootAttribute = root.getAttribute("data-messages-filters-loot")?.trim();
    const loot = lootAttribute ? lootAttribute.match(/(\d+(?:[.,]\d+)?)\s*%?$/)?.[1] : lootMatch?.[1];
    const lootFactor = loot !== void 0 ? Number(loot.replace(",", ".")) / 100 : void 0;
    if (lootFactor !== void 0 && (!Number.isFinite(lootFactor) || lootFactor < 0 || lootFactor > 1)) throw new Error("Pillage du rapport invalide.");
    const timestamp = Number(raw?.getAttribute("data-raw-timestamp")) * 1e3;
    return { coords, name, resources, fleet, defense, lootFactor, observedAt: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now() };
  }
  function parseReportHTML(html) {
    if (html.length > 2 * 1024 * 1024) throw new Error("Rapport sup\xE9rieur \xE0 2 Mo.");
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content.querySelector(selectors.reports) ?? template.content.firstElementChild;
    if (!root) throw new Error("Collez le HTML d\u2019un rapport d\u2019espionnage.");
    return parseEspionageReport(root);
  }

  // src/ogame/fleet.ts
  function dispatcher() {
    const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    return page.fleetDispatcher;
  }
  function fleetURL(coords, action, context, ship, count, loot) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Aucun vaisseau \xE0 pr\xE9parer.");
    const url = new URL(actionURL(coords, action, context.planetId));
    const params = new URLSearchParams({ sephiShip: String(ship), sephiCount: String(count), sephiPlayer: context.playerId });
    if (loot !== void 0) params.set("sephiLoot", String(loot));
    url.hash = params.toString();
    return url.href;
  }
  function campaignURL(coords, action, context, campaign) {
    const url = new URL(actionURL(coords, action, context.planetId));
    url.hash = new URLSearchParams({ sephiCampaign: "1", sephiPlayer: context.playerId }).toString();
    const worker = new URL(location.href).searchParams.get("sephiWorker");
    if (worker) url.searchParams.set("sephiWorker", worker);
    return url.href;
  }
  function isCampaignWorker() {
    if (window.top === window.self) return false;
    try {
      const token = new URL(location.href).searchParams.get("sephiWorker");
      const frame = window.frameElement;
      return Boolean(token && frame?.id === "sephi-campaign-worker" && frame.dataset.sephiWorker === token && window.parent.location.origin === location.origin);
    } catch { return false; }
  }
  function inspectOwnFleetMissions(doc, expectedCount) {
    // fleetDetails is the game's own fleet list, including returning flights.
    // Event/galaxy rows can include hostile fleets and are deliberately excluded.
    const rows = [...doc.querySelectorAll(".fleetDetails")];
    const missions = rows.map((row) => {
      const icon = row.querySelector("[data-mission-type], [data-mission], .mission, .missionType, .fleetMission, .fleet_icon, [class*=mission]");
      const exact = row.getAttribute("data-mission-type") ?? row.getAttribute("data-mission") ?? icon?.getAttribute("data-mission-type") ?? icon?.getAttribute("data-mission");
      const classes = `${row.className ?? ""} ${icon?.className ?? ""}`;
      const numeric = Number(exact ?? classes.match(/(?:^|\s)mission[_-]?(\d+)(?:\s|$)/i)?.[1]);
      if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= 18) return numeric;
      const label = `${icon?.getAttribute("title") ?? ""} ${icon?.textContent ?? ""}`;
      for (const [mission, pattern] of [[10, /missile|raketen/i], [6, /espionn|espionag|\bspy\b/i], [1, /attaqu|attack/i], [3, /transport/i], [4, /stationn|deploy/i], [15, /expédition|expedition/i], [8, /recycl|harvest/i], [7, /coloni/i]]) if (pattern.test(label)) return mission;
      return null;
    });
    // Missile attacks (mission 10) appear in movement but consume no fleet slot.
    // Keep missions aligned with rows for discoveryFlights and exclude missiles
    // only from the slot comparison. Unknown rows still count and block certainty.
    const missileCount = missions.filter((mission) => mission === 10).length;
    const slotCount = rows.length - missileCount;
    const complete = Number.isSafeInteger(expectedCount) && expectedCount >= 0 && slotCount === expectedCount && missions.every((mission) => mission !== null);
    const activeAttackIds = [], unresolvedAttacks = [];
    rows.forEach((row, index) => {
      if (!row.querySelector("a.recallFleet[data-fleet-id], a.recallFleet") || row.matches?.('[data-return-flight="1"], [data-return-flight="true"]') || row.querySelector(".fleet_icon_reverse")) return;
      if (missions[index] === null) { unresolvedAttacks.push(index); return; }
      if (missions[index] !== 1) return;
      try {
        const destination = row.querySelector(".destCoords, .destination, .destinationCoords, .coordsDestination, .destFleet");
        const text = row.getAttribute("data-destination-coordinates") ?? destination?.textContent;
        const moon = row.getAttribute("data-destination-type") === "3" || destination?.querySelector?.('.moon, .moonIcon, [data-type="3"]') || row.querySelector(".destFleet figure.moon");
        activeAttackIds.push(targetId(parseCoords(text ?? "", moon ? "moon" : "planet")));
      } catch { unresolvedAttacks.push(index); }
    });
    return { expectedCount, observedCount: rows.length, slotCount, missileCount, missions, complete, activeAttackIds: [...new Set(activeAttackIds)], unresolvedAttacks, espionage: missions.filter((mission) => mission === 6).length, attacks: missions.filter((mission) => mission === 1).length };
  }
  async function fetchOwnFleetMissions(expectedCount, planetId) {
    // The native dispatcher already supplies the authoritative flight count.
    // With no flights, movement may redirect instead of rendering an empty list.
    if (expectedCount === 0) return { ...inspectOwnFleetMissions({ querySelectorAll: () => [] }, 0), complete: true };
    const url = new URL("/game/index.php", location.href);
    url.searchParams.set("page", "ingame");
    url.searchParams.set("component", "movement");
    if (planetId) url.searchParams.set("cp", planetId);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch(url.href, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error(`Lecture des mouvements de flotte indisponible (HTTP ${response.status}).`);
      if (response.redirected && !response.url) throw new Error("Destination de la redirection des mouvements indisponible.");
      const finalURL = new URL(response.url || url.href);
      if (finalURL.origin !== url.origin || finalURL.pathname !== url.pathname || finalURL.searchParams.get("page") !== "ingame" || finalURL.searchParams.get("component") !== "movement" || finalURL.searchParams.has("errorNumber")) {
        throw new Error("Lecture des mouvements redirigée hors de la page des mouvements OGame (session ou accès à vérifier).");
      }
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      if (!doc.querySelector("#movement, #movementcomponent, .fleetDetails")) throw new Error("La réponse ne contient pas les mouvements OGame.");
      const playerId = document.querySelector('meta[name="ogame-player-id"]')?.content;
      const responsePlayerId = doc.querySelector('meta[name="ogame-player-id"]')?.content;
      if (playerId && responsePlayerId && playerId !== responsePlayerId) throw new Error("Les mouvements reçus appartiennent à un autre compte OGame.");
      const movements = inspectOwnFleetMissions(doc, expectedCount);
      if (Number.isSafeInteger(expectedCount) && expectedCount > 0 && movements.slotCount !== expectedCount) throw new Error(`Liste des mouvements incomplète (${movements.slotCount}/${expectedCount} flottes avec slot, ${movements.missileCount} attaque(s) de missiles); nouvelle lecture nécessaire.`);
      return movements;
    } finally { clearTimeout(timeout); }
  }
  function campaignLog(event, details = {}) {
    // Keep the details in the copied console line, instead of a collapsed Object.
    console.info(`[SephiOGame Auto ${VERSION}] ${event} ${JSON.stringify(details)}`);
    traceDiscoveryEvent(event, details);
    try {
      const key = campaignLogKey();
      const previous = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      const safeDetails = JSON.parse(JSON.stringify(details, (name, value) => {
        if (/token|password|cookie|session/i.test(name)) return "[masqué]";
        return typeof value === "string" ? value.replace(/((?:token|session|password)=)[^&\s]+/ig, "$1[masqué]") : value;
      }));
      const entries = Array.isArray(previous) ? previous : [];
      entries.push({ at: new Date().toISOString(), version: VERSION, event, details: safeDetails });
      sessionStorage.setItem(key, JSON.stringify(entries.slice(-150)));
    } catch {
      // Diagnostics must never prevent dispatch or campaign persistence.
    }
  }
  function campaignLogKey() {
    const player = document.querySelector('meta[name="ogame-player-id"]')?.content ?? "unknown";
    return `sephiogame:auto-log:${player}`;
  }
  function fleetFuelStatus(fleet, nativeCheck = fleet.hasEnoughFuel) {
    const numeric = (value) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    const nativeResult = nativeCheck.call(fleet);
    const available = numeric(fleet.deuteriumOnPlanet);
    const rawConsumption = fleet.getConsumption?.();
    const consumption = numeric(rawConsumption);
    const cargo = fleet.cargoDeuterium == null ? 0 : numeric(fleet.cargoDeuterium);
    // Some OGame versions return undefined from hasEnoughFuel. Only use the
    // dispatcher's actual figures in that case; keep explicit native refusals.
    // A false result with an invalid consumption is not evidence of a fuel
    // shortage: comparisons with NaN also return false during initialization.
    const enough = nativeResult === false && consumption === null ? null : typeof nativeResult === "boolean" ? nativeResult : available !== null && consumption !== null && cargo !== null ? available >= consumption + cargo : null;
    return { nativeResult: nativeResult ?? null, nativeType: typeof nativeResult, available, consumption, rawConsumption: String(rawConsumption), cargo, enough, speedPercent: fleet.speedPercent ?? null, currentPage: fleet.currentPage };
  }
  function diagnosticValue(value) {
    return JSON.parse(JSON.stringify(value, (name, item) => {
      if (/token|password|cookie|session/i.test(name)) return "[masqué]";
      if (typeof item === "number" && !Number.isFinite(item)) return String(item);
      return typeof item === "string" ? item.replace(/((?:token|session|password|sephiDiscovery)=)[^&\s]+/ig, "$1[masqué]").slice(0, 2000) : item;
    }));
  }
  function traceDiscoveryEvent(event, details = {}) {
    try {
      const token = new URL(location.href).searchParams.get("sephiDiscovery");
      if (!token) return;
      const context = getPlayerContext();
      if (!context) return;
      const key = `sephiogame:v4:${context.universe}:${context.playerId}:discovery`, scan = readJSON(key);
      if (scan.worker?.token !== token) return;
      const entry = { at: Date.now(), version: VERSION, event, task: scan.worker.task, coords: scan.queue?.[0]?.coords ?? null, details: diagnosticValue(details) };
      localStorage.setItem(key, JSON.stringify({ ...scan, debug: [...(scan.debug ?? []), entry].slice(-150), ...(details.diagnostic ? { lastDiagnostic: entry } : {}), worker: { ...scan.worker, lastEvent: event, lastEventAt: entry.at } }));
    } catch { /* Debug storage must not affect dispatch or its confirmation. */ }
  }
  function fleetDispatchDiagnostic(fleet, expectedMission, fuel) {
    const errors = [];
    const call = (name) => { try { return typeof fleet?.[name] === "function" ? fleet[name]() : null; } catch (error) { errors.push(`${name}: ${String(error)}`); return null; } };
    if (fuel === undefined) { try { fuel = typeof fleet?.hasEnoughFuel === "function" ? fleetFuelStatus(fleet) : null; } catch (error) { errors.push(`carburant: ${String(error)}`); fuel = null; } }
    const button = document.getElementById("sendFleet"), target = fleet?.targetPlanet;
    const nativeConditionFields = {};
    nativeConditionFields.expectedMissionOrder = fleet?.orders?.[expectedMission] ?? null;
    nativeConditionFields.expectedMissionOrderType = typeof fleet?.orders?.[expectedMission];
    try {
      const names = [...new Set([...String(fleet?.refreshNavigationFleet2 ?? "").matchAll(/\bthis\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))].slice(0, 40);
      for (const name of names) {
        if (/token|password|cookie|session|url|endpoint/i.test(name)) continue;
        try { const value = fleet[name]; if (value == null || ["boolean", "number", "string"].includes(typeof value)) nativeConditionFields[name] = typeof value === "string" ? value.slice(0, 300) : value ?? null; } catch { nativeConditionFields[name] = "lecture impossible"; }
      }
    } catch { /* Native validation code may be inaccessible in a sandbox. */ }
    let messages = [];
    try { messages = [...document.querySelectorAll(".fleetError, .fleetWarning, #fleetError, #fleetWarning, .errorMessage, .warning, .error")].map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 8).map((text) => text.slice(0, 300)); } catch { /* Native messages are optional. */ }
    return diagnosticValue({ currentPage: fleet?.currentPage ?? null, expectedMission, mission: fleet?.mission ?? null, hasMission: call("hasMission"), loading: Boolean(fleet?.loading), targetValid: call("hasValidTarget"), target: target ? Object.fromEntries(["galaxy", "system", "position", "type"].map((key) => [key, target[key] ?? null])) : null, selectedShips: Array.isArray(fleet?.shipsToSend) ? fleet.shipsToSend.filter((ship) => Number(ship.number) > 0).map((ship) => ({ id: ship.id, number: ship.number })) : [], fleetCount: fleet?.fleetCount ?? null, maxFleetCount: fleet?.maxFleetCount ?? null, hasFreeSlots: call("hasFreeSlots"), speedPercent: fleet?.speedPercent ?? null, duration: call("getDuration"), distance: call("getDistance"), fuel, button: { present: Boolean(button), className: button ? String(button.className) : null, off: Boolean(button?.classList?.contains("off")), disabled: Boolean(button?.disabled || button?.hasAttribute("disabled")), title: button?.getAttribute?.("title") ?? null, ariaDisabled: button?.getAttribute?.("aria-disabled") ?? null }, warnings: Object.fromEntries(["moveInProgress", "warningsEnabled", "targetIsStrong", "targetIsOutlaw", "targetIsBuddyOrAllyMember", "playerIsOutlaw"].map((key) => [key, fleet?.[key] == null ? null : Boolean(fleet[key])])), nativeConditionFields, nativeMessages: messages, inspectionErrors: errors });
  }
  function fleetConfirmationBlockers(diagnostic) {
    const blockers = [];
    if (diagnostic.loading) blockers.push("actualisation OGame toujours en cours");
    if (Number(diagnostic.mission) !== diagnostic.expectedMission) blockers.push(`mission ${diagnostic.mission ?? "inconnue"} au lieu de ${diagnostic.expectedMission}`);
    if (!diagnostic.hasMission) blockers.push("mission non validée par OGame");
    if (diagnostic.targetValid === false) blockers.push("destination non validée");
    if (diagnostic.slotsUsable === false) blockers.push("slots utilisables épuisés");
    if (diagnostic.fuel?.consumption === null) blockers.push("consommation illisible");
    if (diagnostic.fuel?.enough === false) blockers.push("carburant refusé");
    if (diagnostic.fuel?.enough == null) blockers.push("carburant non confirmé");
    if (!diagnostic.button.present) blockers.push("bouton #sendFleet introuvable");
    else if (diagnostic.button.off || diagnostic.button.disabled) blockers.push(`bouton d’envoi désactivé (${diagnostic.button.className || "disabled"})`);
    return blockers;
  }
  function refreshHiddenFleetTarget(fleet) {
    // OGame's setTargetType fetches target permissions only when #fleet2 is
    // jQuery-visible. A hidden worker iframe can suppress that native request.
    // Call the same reader once; permissions and all send checks stay native.
    if (fleet.currentPage !== "fleet2" || fleet.loading || typeof fleet.fetchTargetPlayerData !== "function") return false;
    const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const nativeJQuery = gameWindow.jQuery ?? gameWindow.$;
    if (typeof nativeJQuery !== "function") return false;
    try {
      if (nativeJQuery("#fleet2").is(":visible") !== false) return false;
      fleet.fetchTargetPlayerData();
      campaignLog("Chargement natif des autorisations dans le cadre masqué", { currentPage: fleet.currentPage });
      return true;
    } catch (error) {
      campaignLog("Chargement des autorisations du cadre masqué indisponible", { error: String(error) });
      return false;
    }
  }
  function readCampaignLog() {
    try {
      const entries = JSON.parse(sessionStorage.getItem(campaignLogKey()) ?? "[]");
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }
  function messageListURL(base = location.href) {
    const url = new URL("/game/index.php", base);
    url.searchParams.set("page", "ingame");
    url.searchParams.set("component", "messages");
    url.searchParams.set("tab", "20");
    const worker = new URL(base).searchParams.get("sephiWorker");
    if (worker) url.searchParams.set("sephiWorker", worker);
    return url.href;
  }
  var observedMessageRequest = null;
  var messageTraceInstalled = false;
  function messagePageDiagnostic(doc = document) {
    return {
      title: doc.title,
      reportElements: doc.querySelectorAll(selectors.reports).length,
      tabs: [...doc.querySelectorAll("[data-tabid], .tabs_btn a, .js_subtabs_fleets a")].slice(0, 40).map((node) => ({ id: node.id, tabId: node.getAttribute("data-tabid"), className: String(node.className), text: node.textContent?.trim().slice(0, 80), href: node.getAttribute("href") })),
      activeTabs: [...doc.querySelectorAll('.ui-tabs-active, [aria-selected="true"]')].slice(0, 8).map((node) => ({ id: node.id, tabId: node.getAttribute("data-tabid"), text: node.textContent?.trim().slice(0, 80) }))
    };
  }
  function traceNativeMessageRequests() {
    if (messageTraceInstalled) return;
    const game = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const jq = game.jQuery ?? game.$;
    if (typeof jq !== "function") return;
    const events = jq(document);
    if (typeof events?.on !== "function") return;
    messageTraceInstalled = true;
    events.on("ajaxSend.sephiMessages", (event, xhr, settings) => {
      try {
        const url = new URL(settings.url, location.href);
        if (url.origin !== new URL(location.href).origin) return;
        const data = new URLSearchParams(typeof settings.data === "string" ? settings.data : settings.data ?? {});
        const tabId = data.get("tabid") ?? url.searchParams.get("tabid");
        if (!/messages/.test(url.href) && tabId !== "20") return;
        const action = data.get("action") ?? url.searchParams.get("action");
        campaignLog("Requête native Messages", { url: `${url.pathname}${url.search}`, method: settings.type, tabId, action, activeTab: data.get("activeTab"), activeSubTab: data.get("activeSubTab"), showTrash: data.get("showTrash"), messagePage: data.get("messagePage"), pagination: data.get("pagination"), parameterNames: [...data.keys()] });
        // Only capture the known list-reading action, never a delete/read-status action.
        if (action === "getMessagesList" || tabId === "20" && action === "107") {
          observedMessageRequest = { url: url.href, method: String(settings.type ?? "POST").toUpperCase(), data: data.toString() };
        }
      } catch (error) {
        campaignLog("Trace native Messages indisponible", { error: String(error) });
      }
    });
    events.on("ajaxComplete.sephiMessages", (event, xhr, settings) => {
      if (!/messages/.test(String(settings.url))) return;
      campaignLog("Réponse native Messages", { status: xhr.status, contentType: xhr.getResponseHeader?.("content-type"), responseLength: xhr.responseText?.length ?? 0 });
    });
  }
  async function openEspionageMessages() {
    traceNativeMessageRequests();
    campaignLog("État des onglets Messages avant ouverture", messagePageDiagnostic());
    const clickable = (node) => node?.matches?.("a, button") ? node : node?.querySelector?.("a, button") ?? node;
    const findSpyTab = () => document.querySelector('.js_subtabs_fleets [data-tabid="20"], [data-tabid="20"] a, a[href="#subtabs-nfFleet20"], [data-tabid="20"]') ?? [...document.querySelectorAll(".js_subtabs_fleets a, .subtabs a, [role=tab], .tabs_btn a")].find((node) => /espion|espionage/i.test(node.textContent ?? ""));
    let spyTab = clickable(findSpyTab());
    // The wrapper and its tabs arrive after document-end. Install the trace
    // before waiting so the initial getMessagesList request is captured too.
    for (let attempt = 0; attempt < 20 && !spyTab && !observedMessageRequest; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      traceNativeMessageRequests();
      spyTab = clickable(findSpyTab());
    }
    if (!spyTab) {
      const fleetTab = clickable(document.querySelector("a.tb_fleets, .tabs_btn .tb_fleets"));
      if (typeof fleetTab?.click === "function") {
        campaignLog("Ouverture de l’onglet Flottes natif", { id: fleetTab.id });
        fleetTab.click();
        for (let attempt = 0; attempt < 20 && !spyTab; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          spyTab = clickable(findSpyTab());
        }
      }
    }
    if (typeof spyTab?.click === "function") {
      campaignLog("Ouverture de l’onglet Espionnage natif", { id: spyTab.id, tabId: spyTab.getAttribute("data-tabid") ?? spyTab.closest?.("[data-tabid]")?.getAttribute("data-tabid") });
      spyTab.click();
      // Tab contents are filled asynchronously by OGame.
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (document.querySelector(selectors.reports)) break;
      }
    } else campaignLog("Contrôle de l’onglet Espionnage introuvable", messagePageDiagnostic());
  }
  function inspectVisibleEspionageReports(doc = document) {
    const matches = [...doc.querySelectorAll(selectors.reports)];
    const roots = matches.filter((root) => !root.querySelector(selectors.reports));
    const messageIds = new Set();
    const reports = [];
    campaignLog("DOM de la page Messages", {
      selectorMatches: matches.length,
      roots: roots.length,
      reportLikeElements: [...doc.querySelectorAll("[class*=msg], [data-msg-id]")].slice(0, 12).map((node) => ({ tag: node.tagName, className: String(node.className).slice(0, 100), hasMessageId: node.hasAttribute("data-msg-id") }))
    });
    for (const root of roots) {
      const messageId = root.getAttribute("data-msg-id") ?? root.closest("[data-msg-id]")?.getAttribute("data-msg-id") ?? root.querySelector("[data-msg-id]")?.getAttribute("data-msg-id");
      if (messageId) messageIds.add(messageId);
      try {
        const report = parseEspionageReport(root);
        if (!messageId) {
          campaignLog("Rapport visible sans identifiant", { coords: formatCoords(report.coords) });
          continue;
        }
        const timestamp = Number(root.querySelector(selectors.rawReport)?.getAttribute("data-raw-timestamp")) * 1000;
        reports.push({ messageId, report, timestampVerified: Number.isSafeInteger(timestamp) && timestamp > 0 });
      } catch (error) {
        campaignLog("Élément de message non analysable comme rapport détaillé", { messageId, error: String(error) });
      }
    }
    return { messageIds: [...messageIds], reports };
  }
  async function fetchFreshEspionageReports(tabId = "20", inspect = inspectVisibleEspionageReports, stop = null) {
    const request = observedMessageRequest;
    const url = new URL(request?.url ?? "/game/index.php?page=componentOnly&component=messages&asJson=1&action=getMessagesList", location.href);
    const modern = url.searchParams.get("action") === "getMessagesList" || new URLSearchParams(request?.data).get("action") === "getMessagesList";
    const messageIds = new Set(), reports = new Map();
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const body = new URLSearchParams(request?.data ?? { activeSubTab: tabId, showTrash: "false", messagePage: "1" });
      if (modern) {
        // A captured initial request may concern a different tab. Always read
        // espionage, while preserving the native route and other parameters.
        body.set("activeSubTab", tabId);
        body.set("showTrash", "false");
      }
      if (!modern) body.set("tabid", tabId);
      const pageParameter = modern ? "messagePage" : "pagination";
      body.set(pageParameter, String(page));
      const requestURL = new URL(url.href);
      if (requestURL.searchParams.has("tabid")) requestURL.searchParams.set("tabid", tabId);
      if (requestURL.searchParams.has(pageParameter)) requestURL.searchParams.set(pageParameter, String(page));
      if (modern) for (const key of ["activeSubTab", "showTrash"]) if (requestURL.searchParams.has(key)) requestURL.searchParams.set(key, body.get(key));
      const method = request?.method ?? "POST";
      if (method === "GET") for (const [key, value] of body) requestURL.searchParams.set(key, value);
      campaignLog("Lecture des rapports : requête", { source: request ? "requête native observée" : "route getMessagesList", url: `${requestURL.pathname}${requestURL.search}`, method, page, tabId: body.get("tabid"), activeSubTab: body.get("activeSubTab"), showTrash: body.get("showTrash"), pageParameter, action: body.get("action") ?? url.searchParams.get("action") });
      const response = await fetch(requestURL.href, {
        method, credentials: "same-origin", cache: "no-store",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        ...(method === "GET" ? {} : { body })
      });
      if (!response.ok) throw new Error(`Actualisation des rapports impossible (HTTP ${response.status}, page ${page}).`);
      if (response.redirected || response.url && new URL(response.url).searchParams.has("errorNumber")) throw new Error("Le lecteur Messages a été redirigé par OGame; la réponse n’est pas une liste de rapports.");
      let html = await response.text();
      let payload;
      if (/^[\s]*[\[{]/.test(html)) {
        payload = JSON.parse(html);
        campaignLog("Structure JSON du lecteur Messages", { keys: Object.keys(payload ?? {}), fields: Object.entries(payload ?? {}).slice(0, 20).map(([key, value]) => ({ key, type: Array.isArray(value) ? "array" : typeof value, length: typeof value === "string" || Array.isArray(value) ? value.length : undefined })) });
        const fragments = [];
        const visit = (value, depth = 0) => {
          if (depth > 6) return;
          if (typeof value === "string" && /<\/?[a-z][^>]*>/i.test(value)) fragments.push(value);
          else if (value && typeof value === "object") for (const child of Object.values(value)) visit(child, depth + 1);
        };
        visit(payload);
        html = typeof payload === "string" ? payload : fragments.join("\n");
        if (!html && Array.isArray(payload?.messages) && !payload.messages.length) html = '<div class="noMessages"></div>';
        if (typeof html !== "string") throw new Error("Réponse Messages inconnue : aucun HTML de rapports.");
      }
      const doc = new DOMParser().parseFromString(html, "text/html");
      campaignLog("Réponse du lecteur de messages", { page, status: response.status, contentType: response.headers.get("content-type"), htmlLength: html.length, title: doc.title, messageElements: doc.querySelectorAll(selectors.reports).length, pagination: doc.querySelector(".pagination .curPage, .curPage")?.textContent ?? null });
      const snapshot = inspect(doc);
      const pagination = doc.querySelector(".pagination .curPage, .curPage")?.textContent?.match(/\d+\s*\/\s*(\d+)/);
      if (pagination) pages = Number(pagination[1]);
      const jsonPages = payload?.pagination?.totalPages ?? payload?.totalPages ?? payload?.pageCount;
      if (jsonPages !== undefined) pages = Number(jsonPages);
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000) throw new Error("Pagination des rapports invalide.");
      if (page === 1 && !doc.querySelector(selectors.reports) && !doc.querySelector(".pagination, .curPage, .no_msg, .noMessages, .msg_no_message") && !/no messages|aucun message|pas de message/i.test(doc.body.textContent)) {
        campaignLog("Le lecteur ne renvoie pas une liste de rapports", { ...messagePageDiagnostic(doc), responseURL: response.url, redirected: response.redirected, isFullPage: /<!doctype|<html[\s>]/i.test(html) });
        throw new Error("La réponse OGame ne contient pas la liste des rapports d’espionnage.");
      }
      if (page > 1 && snapshot.messageIds.length && snapshot.messageIds.every((id) => messageIds.has(id))) throw new Error("OGame renvoie la même page de rapports; collecte interrompue.");
      for (const id of snapshot.messageIds) messageIds.add(id);
      for (const item of snapshot.reports) reports.set(item.messageId, item);
      campaignLog("Page de rapports chargée", { page, pages, reports: snapshot.reports.length });
      if (stop?.(snapshot)) break;
    }
    return { messageIds: [...messageIds], reports: [...reports.values()] };
  }
  function prepareFleet(context) {
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has("sephiShip") || context.page !== "fleetdispatch") return "done";
    const ship = Number(params.get("sephiShip")), requested = Number(params.get("sephiCount"));
    const fail = (message) => {
      showPreparation(message);
      return "done";
    };
    if (params.get("sephiPlayer") !== context.playerId) return fail("La pr\xE9paration appartient \xE0 un autre compte.");
    if (![202, 203, 210].includes(ship) || !Number.isSafeInteger(requested) || requested <= 0 || requested > 1e9) return fail("Pr\xE9paration de flotte invalide.");
    const fleet = dispatcher();
    if (!fleet || !Array.isArray(fleet.shipsOnPlanet) || !fleet.targetPlanet || typeof fleet.selectShip !== "function") return "waiting";
    const url = new URL(location.href), target = fleet.targetPlanet;
    for (const key of ["galaxy", "system", "position", "type"])
      if (Number(target[key]) !== Number(url.searchParams.get(key))) return fail("V\xE9rifiez les coordonn\xE9es et le type plan\xE8te/lune dans OGame : la destination affich\xE9e diff\xE8re de la pr\xE9paration.");
    if (fleet.shipsToSend?.some((s) => Number(s.number) > 0)) return fail("Une flotte est d\xE9j\xE0 s\xE9lectionn\xE9e. La pr\xE9paration n\u2019a pas remplac\xE9 votre s\xE9lection.");
    let count = requested;
    const data = fleet.fleetHelper?.shipsData?.[String(ship)];
    const capacity = Number(data?.cargoCapacity ?? data?.baseCargoCapacity);
    const loot = Number(params.get("sephiLoot"));
    if (ship !== 210 && params.has("sephiLoot") && Number.isSafeInteger(loot) && loot >= 0 && Number.isSafeInteger(capacity) && capacity > 0)
      count = calculateRequiredCargo(loot, capacity);
    const available = Number(fleet.shipsOnPlanet.find((s) => Number(s.id) === ship)?.number ?? 0);
    if (!Number.isSafeInteger(available) || available <= 0) return fail("Aucun vaisseau de ce type disponible sur la plan\xE8te courante.");
    const selected = Math.min(count, available);
    fleet.selectShip(ship, selected);
    fleet.refresh();
    const unit = ship === 202 ? "PT" : ship === 203 ? "GT" : "sondes";
    showPreparation(`${selected} ${unit} s\xE9lectionn\xE9s${selected < count ? ` sur ${count} n\xE9cessaires : flotte insuffisante` : ""}. V\xE9rifiez la destination, la mission et le carburant, puis poursuivez dans OGame.`);
    history.replaceState(history.state, "", location.pathname + location.search);
    return "done";
  }
  function showPreparation(text) {
    let banner = document.getElementById("sephi-fleet-notice");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "sephi-fleet-notice";
      banner.dataset.sephiToolbar = "";
      banner.setAttribute("role", "status");
      banner.style.cssText = "position:fixed;bottom:75px;right:20px;max-width:460px;z-index:1000001;padding:16px;background:#16394a;color:white;border:1px solid #70d7c0;border-radius:8px;font:14px/1.5 system-ui";
      document.body.append(banner);
    }
    banner.textContent = `SephiOGame : ${text}`;
  }

  // src/storage/storage.ts
  function object(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Objet JSON attendu.");
    return v;
  }
  function number(v, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new Error("Nombre invalide dans la sauvegarde.");
    return v;
  }
  function string(v, max = 1e4) {
    if (typeof v !== "string" || v.length > max) throw new Error("Texte invalide dans la sauvegarde.");
    return v;
  }
  function boolean(v) {
    if (typeof v !== "boolean") throw new Error("Bool\xE9en invalide dans la sauvegarde.");
    return v;
  }
  function validateSettings(v) {
    const s = object(v);
    const autoAttackMode = s.autoAttackMode ?? defaults.autoAttackMode;
    if (!["interval", "slots"].includes(autoAttackMode)) throw new Error("Mode d’auto-attaque invalide.");
    if (typeof s.lootFactor !== "number" || !Number.isFinite(s.lootFactor) || s.lootFactor < 0 || s.lootFactor > 1)
      throw new Error("Facteur de pillage invalide.");
    return {
      smallCargo: number(s.smallCargo, 1),
      largeCargo: number(s.largeCargo, 1),
      lootFactor: s.lootFactor,
      defaultProbes: number(s.defaultProbes, 1, 1e6),
      minimumLoot: number(s.minimumLoot ?? defaults.minimumLoot),
      autoAttackIntervalMinutes: number(s.autoAttackIntervalMinutes === 0 ? defaults.autoAttackIntervalMinutes : s.autoAttackIntervalMinutes ?? defaults.autoAttackIntervalMinutes, 1, 10080),
      fleetWaitTimeoutMinutes: number(s.fleetWaitTimeoutMinutes ?? defaults.fleetWaitTimeoutMinutes, 1, 120),
      reservedFleetSlots: number(s.reservedFleetSlots ?? defaults.reservedFleetSlots, 0, 100),
      autoAttackMode,
      freeSlotsTrigger: number(s.freeSlotsTrigger ?? defaults.freeSlotsTrigger, 1, 100),
      attackIdleSeconds: number(s.attackIdleSeconds ?? defaults.attackIdleSeconds, 15, 3600),
      homePlanetId: string(s.homePlanetId ?? "", 100),
      maxAttackWaves: number(s.maxAttackWaves ?? defaults.maxAttackWaves, 1, 100),
      autoEject: Object.fromEntries(Object.entries(object(s.autoEject ?? {})).map(([id, value]) => {
        const config = object(value);
        if (![3, 4].includes(config.mission)) throw new Error("Mission d’évacuation invalide.");
        return [string(id, 100), { enabled: boolean(config.enabled), coords: validateCoords(config.coords), mission: config.mission }];
      }))
    };
  }
  function validateCoords(v) {
    const c = object(v);
    return coordinates(c.galaxy, c.system, c.position, c.type);
  }
  function validateReport(v) {
    const r = object(v), res = object(r.resources);
    const result = {
      coords: validateCoords(r.coords),
      name: string(r.name, 500),
      observedAt: number(r.observedAt),
      resources: { metal: number(res.metal), crystal: number(res.crystal), deuterium: number(res.deuterium) }
    };
    if (r.fleet !== void 0) result.fleet = number(r.fleet);
    if (r.defense !== void 0) result.defense = number(r.defense);
    if (r.lootFactor !== void 0) {
      if (typeof r.lootFactor !== "number" || !Number.isFinite(r.lootFactor) || r.lootFactor < 0 || r.lootFactor > 1) throw new Error("Pillage invalide.");
      result.lootFactor = r.lootFactor;
    }
    return result;
  }
  function validateTarget(v) {
    const t = object(v), coords = validateCoords(t.coords);
    if (!Array.isArray(t.tags) || t.tags.length > 100 || !Array.isArray(t.history) || t.history.length > 20) throw new Error("Historique / tags invalides.");
    const result = {
      id: targetId(coords),
      coords,
      name: string(t.name, 500),
      enabled: boolean(t.enabled),
      ignore: boolean(t.ignore),
      probeCount: number(t.probeCount, 1, 1e6),
      customFleet: string(t.customFleet),
      notes: string(t.notes),
      tags: t.tags.map((v2) => string(v2, 100)),
      updatedAt: number(t.updatedAt),
      history: t.history.map(validateReport)
    };
    for (const field of ["knownFleet", "knownDefense", "lastObservedFleet", "lastObservedDefense"])
      if (t[field] !== void 0) result[field] = number(t[field]);
    if (t.lastReport !== void 0) result.lastReport = validateReport(t.lastReport);
    if ([...result.history, ...result.lastReport ? [result.lastReport] : []].some((r) => targetId(r.coords) !== result.id)) throw new Error("Historique li\xE9 \xE0 une autre cible.");
    return result;
  }
  function validateData(v) {
    const d = object(v);
    if (d.schemaVersion !== 4) throw new Error("Version de sauvegarde non prise en charge.");
    if (!Array.isArray(d.targets) || d.targets.length > 1e4 || !Array.isArray(d.legacyArchives) || d.legacyArchives.length > 1e3) throw new Error("Sauvegarde trop volumineuse ou mal form\xE9e.");
    const targets = d.targets.map(validateTarget);
    if (new Set(targets.map((t) => t.id)).size !== targets.length) throw new Error("Cibles dupliqu\xE9es dans la sauvegarde.");
    const queue = d.constructionQueue ?? [];
    if (!Array.isArray(queue) || queue.length > 500) throw new Error("File de construction invalide.");
    const constructionQueue = queue.map((value) => {
      const item = object(value);
      if (!["supplies", "facilities", "research", "shipyard", "defenses"].includes(item.page)) throw new Error("Page de construction invalide.");
      return { id: string(item.id, 100), planetId: string(item.planetId, 100), page: item.page, technology: number(item.technology, 1, 100000), name: string(item.name, 500), quantity: number(item.quantity, 1, 1000000), ...(item.costs ? { costs: Object.fromEntries(["metal", "crystal", "deuterium"].map((key) => [key, number(object(item.costs)[key])])) } : {}) };
    });
    if (new Set(constructionQueue.map((item) => item.id)).size !== constructionQueue.length) throw new Error("Constructions dupliquées.");
    const banned = d.discoveryBanned ?? [];
    if (!Array.isArray(banned) || banned.length > 20000) throw new Error("Liste de cibles bannies invalide.");
    const discoveryBanned = banned.map((entry) => { const item = object(entry), coords = validateCoords(item.coords); return { id: targetId(coords), coords, playerId: string(item.playerId ?? "", 100), name: string(item.name, 500), loot: number(item.loot), at: number(item.at), reason: string(item.reason, 500) }; });
    const fish = d.discoveryBigFish ?? [];
    if (!Array.isArray(fish) || fish.length > 20000) throw new Error("Liste de gros poissons invalide.");
    const discoveryBigFish = fish.map((entry) => { const item = object(entry), coords = validateCoords(item.coords); return { id: targetId(coords), coords, playerId: string(item.playerId ?? "", 100), name: string(item.name, 500), loot: number(item.loot), at: number(item.at), tags: ["gros poisson potentiel"], ...(item.fleet !== undefined ? { fleet: number(item.fleet) } : {}), ...(item.defense !== undefined ? { defense: number(item.defense) } : {}) }; });
    return { schemaVersion: 4, targets, discoveryBanned, discoveryBigFish, constructionQueue, settings: validateSettings(d.settings), legacyArchives: d.legacyArchives.map((v2) => {
      const a = object(v2);
      return { source: string(a.source, 500), importedAt: number(a.importedAt), data: a.data };
    }) };
  }
  function decodeDeprecated(text) {
    const parts = text.replace(/_Ar1_/g, "\n").split("/_/_/");
    if (parts.length < 4) throw new Error("Ancien format non reconnu.");
    const decode = (value) => value.includes("\n") ? value.split("\n").filter(Boolean).map((row) => row.split("_Ar2_").filter((_, i, a) => i < a.length - 1)) : value;
    return { listPrev: decode(parts[0]), prods: decode(parts[1]), frigos: decode(parts[2]), eject: parts[3] };
  }
  function parseImport(text, source = "fichier") {
    if (text.length > 10 * 1024 * 1024) throw new Error("Fichier sup\xE9rieur \xE0 10 Mo.");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = decodeDeprecated(text);
    }
    const d = object(value);
    if ("schemaVersion" in d) return validateData(d);
    if (!Array.isArray(d.frigos) || d.frigos.length > 1e4) throw new Error("Sauvegarde SephiOGame non reconnue.");
    const result = emptyData();
    for (const row of d.frigos) {
      if (!Array.isArray(row) || row.length < 4) throw new Error("Frigo historique mal form\xE9.");
      const c = coordinates(row[1], row[2], row[3], row[12] === "moon" || row[12] === "3" ? "moon" : "planet");
      const optional = (v) => {
        if (v === null || v === void 0 || v === "" || v === "null" || v === "undefined") return void 0;
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n < 0) throw new Error("Valeur historique invalide.");
        return n;
      };
      const probes = optional(row[11]) || 1;
      const t = createTarget(c, String(row[0] ?? ""), probes);
      t.enabled = row[4] !== "0" && row[4] !== 0;
      t.customFleet = String(row[5] ?? "");
      t.ignore = row[6] === "1" || row[6] === 1;
      t.knownFleet = optional(row[7]);
      t.knownDefense = optional(row[8]);
      t.lastObservedFleet = optional(row[9]);
      t.lastObservedDefense = optional(row[10]);
      const index = result.targets.findIndex((x) => x.id === t.id);
      if (index < 0) result.targets.push(t);
      else result.targets[index] = t;
    }
    result.legacyArchives.push({ source, importedAt: Date.now(), data: value });
    return validateData(result);
  }
  var Storage = class {
    constructor(backend, key) {
      __publicField(this, "backend", backend);
      __publicField(this, "key", key);
    }
    load() {
      const raw = this.backend.getItem(this.key);
      return raw === null ? emptyData() : validateData(JSON.parse(raw));
    }
    save(data) {
      this.backend.setItem(this.key, JSON.stringify(validateData(data)));
    }
    export(data) {
      return JSON.stringify(validateData(data), null, 2);
    }
    import(current, text, source) {
      const incoming = parseImport(text, source);
      const targets = new Map(current.targets.map((t) => [t.id, t]));
      for (const t of incoming.targets) if (!targets.has(t.id)) targets.set(t.id, t);
      const merged = validateData({
        ...current,
        targets: [...targets.values()],
        constructionQueue: [...new Map([...(current.constructionQueue ?? []), ...incoming.constructionQueue].map((item) => [item.id, item])).values()],
        discoveryBanned: [...new Map([...(current.discoveryBanned ?? []), ...incoming.discoveryBanned].map((item) => [item.id, item])).values()],
        discoveryBigFish: [...new Map([...(current.discoveryBigFish ?? []), ...incoming.discoveryBigFish].map((item) => [item.id, item])).values()],
        settings: current.targets.length === 0 ? incoming.settings : current.settings,
        legacyArchives: [...current.legacyArchives, ...incoming.legacyArchives]
      });
      this.save(merged);
      return merged;
    }
    legacyKeys() {
      const result = [];
      for (let i = 0; i < this.backend.length; i++) {
        const k = this.backend.key(i);
        if (k && /_dump_saved_vars(?:_v2)?$/.test(k)) result.push(k);
      }
      return result.sort();
    }
    importLegacyKey(current, key) {
      if (!this.legacyKeys().includes(key)) throw new Error("Cl\xE9 historique non reconnue.");
      return this.import(current, this.backend.getItem(key), key);
    }
  };

  // Native movement summary and construction scheduling.
  function formatRemaining(milliseconds) {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((value) => String(value).padStart(2, "0")).join(":");
  }
  function nextAttackText(campaign, now = Date.now()) {
    const prefix = "Temps restant avant la prochaine auto attaque : ";
    if (campaign?.status === "running" && campaign.phase === "wait" && campaign.triggerMode === "slots") return prefix + "attente des slots libres et de l’inactivité";
    if (campaign?.status === "running" && campaign.phase === "wait" && Number.isFinite(campaign.nextRunAt)) return prefix + formatRemaining(campaign.nextRunAt - now);
    return prefix + (campaign?.status === "running" ? "cycle en cours" : "non programmée");
  }
  function returningResourceGroups(doc = document) {
    const groups = new Map();
    let unreadable = 0;
    for (const row of doc.querySelectorAll(".fleetDetails")) {
      if (!row.matches('[data-return-flight="1"], [data-return-flight="true"]') && !row.querySelector(".fleet_icon_reverse")) continue;
      try {
        // On a return flight the original departure is the delivery destination.
        const origin = row.querySelector(".origin, .originCoords, .coordsOrigin, .departure");
        const figures = row.querySelectorAll("figure");
        const fallback = figures[0]?.nextElementSibling;
        const destination = row.getAttribute("data-origin-coordinates") ?? origin?.textContent ?? fallback?.textContent;
        if (!destination) throw new Error("Destination absente");
        const type = row.getAttribute("data-origin-type") === "3" || origin?.querySelector('.moon, .moonIcon, [data-type="3"]') || figures[0]?.matches(".moon") ? "moon" : "planet";
        const coords = parseCoords(destination, type);
        const tooltips = [...row.querySelectorAll("[title], [data-tooltip-content]")].map((node) => node.getAttribute("data-tooltip-content") ?? node.getAttribute("title") ?? "").join(" ");
        const html = new DOMParser().parseFromString(tooltips, "text/html");
        // Separate table cells with spaces so labels and amounts remain readable.
        const tooltipText = [...html.querySelectorAll("td")].map((node) => node.textContent).join(" ") || html.body.textContent;
        const text = `${row.textContent} ${tooltipText}`;
        const resources = {};
        for (const key of ["metal", "crystal", "deuterium"]) {
          const exact = row.getAttribute(`data-${key}`);
          const node = row.querySelector(`[data-resource="${key}"], .${key} .value, .${key}`);
          const value = exact !== null ? parseNumber(exact) : (node ? numericElement(node) : undefined) ?? labeled(text, labels[key]);
          if (value === undefined) throw new Error("Ressources absentes");
          resources[key] = value;
        }
        const id = targetId(coords), previous = groups.get(id) ?? { coords, metal: 0, crystal: 0, deuterium: 0, fleets: 0 };
        for (const key of Object.keys(resources)) {
          previous[key] += resources[key];
          if (!Number.isSafeInteger(previous[key])) throw new Error("Total invalide");
        }
        previous.fleets++;
        groups.set(id, previous);
      } catch { unreadable++; }
    }
    return { groups: [...groups.values()], unreadable };
  }
  function renderReturningResources() {
    if (getPlayerContext()?.page !== "movement") return;
    const summary = returningResourceGroups();
    const signature = JSON.stringify(summary);
    let host = document.getElementById("sephi-returning-resources");
    if (host?.dataset.signature === signature) return;
    if (!host) {
      host = element("section");
      host.id = "sephi-returning-resources";
      host.dataset.sephiToolbar = "";
      host.style.cssText = "padding:12px;margin:10px 0;background:#142638;border:1px solid #42617c;color:#c8dcec;font:13px/1.6 system-ui";
      (document.querySelector("#movement, #pageContent #middle, #content") ?? document.body).prepend(host);
    }
    host.dataset.signature = signature;
    host.replaceChildren(element("strong", "Ressources en cours de retour"));
    for (const group of summary.groups) host.append(element("div", `${formatCoords(group.coords)} · ${fmt(group.metal)} métal · ${fmt(group.crystal)} cristal · ${fmt(group.deuterium)} deutérium`));
    if (!summary.groups.length) host.append(element("div", "Aucune ressource de retour identifiée."));
    if (summary.unreadable) host.append(element("small", `${summary.unreadable} flotte(s) de retour avec destination ou ressources illisibles, exclue(s) du total.`));
  }
  function isConstructionWorker() {
    if (window.top === window.self) return false;
    try {
      const token = new URL(location.href).searchParams.get("sephiBuildWorker");
      const frame = window.frameElement;
      return Boolean(token && frame?.id === "sephi-construction-worker" && frame.dataset.sephiWorker === token && window.parent.location.origin === location.origin);
    } catch { return false; }
  }
  function constructionURL(item, token) {
    const url = new URL("/game/index.php", location.href);
    for (const [key, value] of Object.entries({ page: "ingame", component: item.page, cp: item.planetId, sephiBuildWorker: token })) url.searchParams.set(key, value);
    return url.href;
  }
  function constructionLevel(tile) {
    const node = tile?.querySelector(".level, .amount");
    const value = node?.getAttribute("data-value") ?? node?.textContent?.match(/\d[\d.\s]*$/)?.[0];
    try { return value === undefined ? undefined : parseNumber(value); } catch { return undefined; }
  }
  const resourceKeys = ["metal", "crystal", "deuterium"];
  function readJSON(key, fallback = {}) {
    try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
  }
  function constructionStateKey(key, planetId) { return `${key}:construction-state:${planetId}`; }
  function planetQueue(queue, planetId) { return queue.filter((item) => item.planetId === planetId); }
  function idleCheckAllowed(lastActivity, lastCheck, now = Date.now()) {
    return now - lastActivity >= 120000 && now - lastCheck >= 120000;
  }
  function ownedPlanets(doc = document) {
    const result = new Map();
    for (const link of doc.querySelectorAll('#planetList a.planetlink, #planetList a.moonlink')) {
      try {
        const id = new URL(link.href, location.href).searchParams.get("cp");
        const coords = parseCoords(link.closest(".smallplanet")?.querySelector(".planet-koords")?.textContent ?? link.textContent, link.matches(".moonlink") ? "moon" : "planet");
        const tooltip = link.getAttribute("data-tooltip-title") ?? link.getAttribute("title") ?? "";
        const name = link.querySelector(".planet-name, .moon-name")?.textContent.trim()
          || tooltip.match(/<b>\s*([^<]*?)\s*\[\d+:\d+:\d+\]\s*<\/b>/)?.[1]
          || link.textContent.replace(/\[\s*\d+\s*:\s*\d+\s*:\s*\d+\s*\]/, "").trim();
        if (id) result.set(id, { id, coords, name });
      } catch { /* Ignore unrelated links. */ }
    }
    return [...result.values()];
  }
  function planetLabel(planet) {
    return [planet.name, formatCoords(planet.coords)].filter(Boolean).join(" ");
  }
  function planetLabelById(id, doc = document) {
    const planet = ownedPlanets(doc).find((p) => p.id === id);
    return planet ? planetLabel(planet) : `${id}`;
  }

  // Expeditions — calls OGame's own fleet endpoints directly (fleet page data + sendFleet),
  // so no page has to be driven or clicked.
  var EXPEDITION_SHIPS = [[202, "Petit transporteur"], [203, "Grand transporteur"], [219, "\xC9claireur"], [204, "Chasseur l\xE9ger"], [205, "Chasseur lourd"], [206, "Croiseur"], [207, "Vaisseau de bataille"], [215, "Traqueur"], [211, "Bombardier"], [213, "Destructeur"], [218, "Faucheur"], [209, "Recycleur"], [210, "Sonde d’espionnage"], [214, "\xC9toile de la mort"]];
  var EXPEDITION_MISSION = 15, EXPEDITION_POSITION = 16;
  var EXPEDITION_SHIPS_MAX_AGE = 15 * 6e4; // « Disponible » readings older than this are refreshed in the background
  function parseSystem(text) {
    const match = String(text).match(/^\s*\[?\s*(\d+)\s*:\s*(\d+)\s*\]?\s*$/);
    if (!match) throw new Error("Syst\xE8me cible invalide. Exemple : 3:179.");
    const { galaxy, system } = coordinates(match[1], match[2], 1);
    return { galaxy, system };
  }
  function defaultExpeditionConfig() {
    return { enabled: false, planetId: "", target: "", holdingTime: 1, speed: 100, maxConcurrent: 0, ships: {}, autoSwitch: true };
  }
  function gameURL(params) {
    const url = new URL("/game/index.php", location.href);
    for (const [key, value] of Object.entries({ page: "ingame", ...params })) if (value !== void 0 && value !== "") url.searchParams.set(key, String(value));
    return url;
  }
  // Reads the fleet page of a planet (cp switches the active planet, like any OGame link) without rendering it.
  async function fetchFleetSnapshot(planetId) {
    const response = await fetch(gameURL({ component: "fleetdispatch", cp: planetId }), { credentials: "include" });
    if (!response.ok) throw new Error(`Page flotte indisponible (HTTP ${response.status}).`);
    const html = await response.text();
    const number = (name) => { const match = html.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)\\s*;`)); return match ? Number(match[1]) : void 0; };
    const token = html.match(/\bvar\s+token\s*=\s*"([0-9a-f]{32})"/)?.[1];
    const ships = {};
    try { for (const ship of JSON.parse(html.match(/\bshipsOnPlanet\s*=\s*(\[[^\]]*\])/)?.[1] ?? "[]")) ships[ship.id] = Number(ship.number) || 0; } catch { /* Checked below. */ }
    let planet = null;
    try { planet = JSON.parse(html.match(/\bcurrentPlanet\s*=\s*(\{[^}]*\})/)?.[1] ?? "null"); } catch { /* Checked below. */ }
    const snapshot = { planetId, token, planet, ships, fleetCount: number("fleetCount"), maxFleetCount: number("maxFleetCount"), expeditionCount: number("expeditionCount"), maxExpeditionCount: number("maxExpeditionCount"), at: Date.now() };
    if (!token || !planet || [snapshot.fleetCount, snapshot.maxFleetCount, snapshot.expeditionCount, snapshot.maxExpeditionCount].some((value) => value === void 0))
      throw new Error("Donn\xE9es de la page flotte introuvables (session expir\xE9e ?).");
    return snapshot;
  }
  // Expedition fleets in flight, from the movement page: when each one lands next (return or arrival).
  async function fetchExpeditionMovements() {
    const response = await fetch(gameURL({ component: "movement" }), { credentials: "include" });
    if (!response.ok) throw new Error(`Page mouvements indisponible (HTTP ${response.status}).`);
    const html = await response.text(), fleets = [];
    for (const match of html.matchAll(/<div\b[^>]*?data-mission-type="(\d+)"[^>]*?data-return-flight="([^"]*)"[^>]*?data-arrival-time="(\d+)"[^>]*>/g)) {
      if (Number(match[1]) !== EXPEDITION_MISSION) continue;
      fleets.push({ returning: match[2] === "1" || match[2] === "true", arrival: Number(match[3]) * 1e3 });
    }
    return fleets.sort((a, b) => a.arrival - b.arrival);
  }
  // Same request as the Flotte page's "Envoyer" (FleetDispatcher.submitFleet2). The galaxy "miniFleet"
  // shortcut would be lighter but OGame reserves it to accounts with the Amiral officer.
  async function sendExpeditionFleet({ planetId, token, galaxy, system, ships, speed, holdingTime }) {
    const body = new URLSearchParams({ token });
    for (const [id, count] of Object.entries(ships)) if (count > 0) body.set(`am${id}`, String(count));
    for (const [key, value] of Object.entries({
      galaxy, system, position: EXPEDITION_POSITION, type: 1,
      metal: 0, crystal: 0, deuterium: 0, food: 0, prioMetal: 2, prioCrystal: 3, prioDeuterium: 4, prioFood: 1,
      mission: EXPEDITION_MISSION, speed: Math.round(speed / 10), retreatAfterDefenderRetreat: 0, lootFoodOnAttack: 0, union: 0, holdingtime: holdingTime
    })) body.set(key, String(value));
    const response = await fetch(gameURL({ component: "fleetdispatch", action: "sendFleet", asJson: 1, cp: planetId }), {
      method: "POST", credentials: "include", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* Handled below. */ }
    if (!data) throw new Error(`R\xE9ponse OGame illisible (HTTP ${response.status}).`);
    const errors = Array.isArray(data.errors) ? data.errors : Object.values(data.errors ?? {});
    return {
      ok: data.success === true,
      message: data.success === true ? String(data.message ?? "Exp\xE9dition envoy\xE9e.") : String(errors[0]?.message ?? errors[0] ?? data.message ?? "Envoi refus\xE9 par OGame."),
      newToken: data.newAjaxToken ?? null
    };
  }
  function nextExpeditionCheck(fleets, now = Date.now()) {
    // Wake up shortly after the next expedition lands; never sooner than 2 min, never later than 1 h.
    const next = fleets.map((fleet) => fleet.arrival).filter((time) => time > now).sort((a, b) => a - b)[0];
    const wanted = next ? next + 9e4 : now + 30 * 6e4;
    return Math.min(Math.max(wanted, now + 2 * 6e4), now + 60 * 6e4);
  }
  var timeFR = (time) => new Date(time).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  // Expedition results — read from the expedition reports (messages subtab 22, messageType 41).
  // A system is considered exhausted when, over the last 7 days, at least 15 results are known
  // and at least half of them brought nothing back; the target then moves by ±10 systems.
  var EXPEDITION_RESULTS_TAB = "22", EXPEDITION_STATS_DAYS = 7, EXPEDITION_SWITCH_MIN = 15, EXPEDITION_SWITCH_RATIO = 0.5, EXPEDITION_SWITCH_STEP = 10;
  function parseExpeditionReport(node) {
    const raw = node.querySelector(".rawMessageData");
    if (!raw || raw.getAttribute("data-raw-messagetype") !== "41") return null;
    const id = node.getAttribute("data-msg-id"), at = Number(raw.getAttribute("data-raw-timestamp")) * 1e3;
    const coords = (raw.getAttribute("data-raw-coords") ?? "").match(/^(\d+):(\d+):(\d+)$/);
    if (!id || !at || !coords) return null;
    // Anything in a "...gained" field (resources, ships, dark matter, items) counts as a gain.
    const empty = (value) => value == null || /^\s*(|0|null|false|\[\]|\{\})\s*$/.test(value);
    const gained = [...raw.attributes].filter((a) => /^data-raw-.+gained$/i.test(a.name) && !empty(a.value)).map((a) => a.name.replace(/^data-raw-/i, "").replace(/gained$/i, ""));
    return { id, at, system: `${coords[1]}:${coords[2]}`, result: raw.getAttribute("data-raw-expeditionresult") ?? "", gain: gained.length > 0, gained, depletion: Number(raw.getAttribute("data-raw-depletion")) || null };
  }
  // Newest reports first; stops at the first page that brings nothing new or reaches the 7-day limit.
  async function fetchExpeditionReports(knownIds, since, maxPages = 10) {
    const found = [];
    let pages = 1;
    for (let page = 1; page <= Math.min(pages, maxPages); page++) {
      const body = new URLSearchParams({ activeSubTab: EXPEDITION_RESULTS_TAB, showTrash: "false", messagePage: String(page) });
      const response = await fetch(gameURL({ page: "componentOnly", component: "messages", asJson: 1, action: "getMessagesList" }), { method: "POST", credentials: "include", cache: "no-store", headers: { "X-Requested-With": "XMLHttpRequest" }, body });
      if (!response.ok) throw new Error(`Rapports d’exp\xE9dition indisponibles (HTTP ${response.status}).`);
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.messages)) throw new Error("R\xE9ponse inattendue du lecteur de messages.");
      pages = Number(data.pageCount) || 1;
      const doc = new DOMParser().parseFromString(data.messages.join(""), "text/html");
      let fresh = 0, reachedOld = false;
      for (const node of doc.querySelectorAll("[data-msg-id]")) {
        const report = parseExpeditionReport(node);
        if (!report) continue;
        if (report.at < since) { reachedOld = true; continue; }
        if (knownIds.has(report.id)) continue;
        found.push(report); fresh += 1;
      }
      if (reachedOld || !fresh) break;
    }
    return found;
  }
  function systemStats(results, galaxy, system) {
    const key = `${galaxy}:${system}`, list = results.filter((r) => r.system === key);
    const empty = list.filter((r) => !r.gain).length;
    return { system: key, count: list.length, empty, ratio: list.length ? empty / list.length : 0, depletion: list.sort((a, b) => b.at - a.at)[0]?.depletion ?? null };
  }
  async function universeSystemCount() {
    const key = `sephiogame:${location.host}:systems`, cached = readJSON(key, {});
    if (cached.value && Date.now() - cached.at < 7 * 864e5) return cached.value;
    try {
      const xml = await (await fetch("/api/serverData.xml", { cache: "no-store" })).text();
      const value = Number(xml.match(/<systems>(\d+)<\/systems>/)?.[1]);
      if (value > 0) { localStorage.setItem(key, JSON.stringify({ value, at: Date.now() })); return value; }
    } catch { /* Default below. */ }
    return 499;
  }
  function constructionCosts(detail, quantity = 1) {
    const costs = {};
    let found = false;
    for (const key of resourceKeys) {
      const node = detail?.querySelector(`.costs .${key}, .costs [data-resource="${key}"], #costs .${key}`);
      // Native details omit resources whose cost is zero.
      if (!node) { costs[key] = 0; continue; }
      found = true;
      const exact = node.getAttribute("data-total") ?? node.getAttribute("data-value");
      let value;
      try { value = exact != null ? parseNumber(exact) : numericElement(node); } catch { return undefined; }
      if (value === undefined || !Number.isSafeInteger(value * quantity)) return undefined;
      costs[key] = value * quantity;
    }
    return found ? costs : undefined;
  }
  function capturePlanetEconomy(key, context) {
    const game = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const previous = readJSON(`${key}:economies`), old = previous[context.planetId] ?? {};
    const resources = {}, production = {}, storage = {};
    for (const name of resourceKeys) {
      const native = game.resourcesBar?.resources?.[name];
      const node = document.getElementById(`resources_${name}`);
      const amount = Number(native?.amount);
      resources[name] = native?.amount != null && Number.isFinite(amount) && amount >= 0 ? Math.floor(amount) : node ? numericElement(node) : undefined;
      storage[name] = Number.isFinite(Number(native?.storage)) && native?.storage != null ? Number(native.storage) : old.storage?.[name];
      const hourly = Number(native?.productionPerHour ?? node?.getAttribute("data-production-per-hour"));
      let rate = Number.isFinite(hourly) && (native?.productionPerHour != null || node?.hasAttribute("data-production-per-hour")) ? hourly : undefined;
      if (rate === undefined && native?.tooltip) {
        const tooltip = new DOMParser().parseFromString(native.tooltip.replace(/\|/g, " "), "text/html").body.textContent;
        const value = tooltip.match(/(?:production actuelle|current production|production per hour)\s*:?\s*([\d.,\s\u00a0\u202f]+)/i)?.[1]?.trim();
        if (value) try { rate = parseNumber(value); } catch { /* Unknown production stays unknown. */ }
      }
      production[name] = rate ?? (native?.tooltip ? undefined : old.production?.[name]);
    }
    if (resourceKeys.some((name) => resources[name] === undefined)) return old;
    const snapshot = { resources, production, storage, at: Date.now() };
    localStorage.setItem(`${key}:economies`, JSON.stringify({ ...previous, [context.planetId]: snapshot }));
    return snapshot;
  }
  function constructionEstimate(costs, economy, now = Date.now()) {
    if (!costs || !economy?.resources) return { text: "Estimation indisponible : coûts ou ressources à vérifier", missing: {} };
    const missing = {}, elapsedHours = Math.max(0, now - economy.at) / 3600000;
    let hours = 0, unknown = false, blocked = false;
    for (const key of resourceKeys) {
      const rate = economy.production?.[key];
      const amount = Math.min(economy.storage?.[key] ?? Infinity, economy.resources[key] + (Number.isFinite(rate) ? Math.max(0, rate) * elapsedHours : 0));
      missing[key] = Math.max(0, Math.ceil(costs[key] - amount));
      if (!missing[key]) continue;
      if (!Number.isFinite(rate)) unknown = true;
      else if (rate <= 0 || costs[key] > (economy.storage?.[key] ?? Infinity)) blocked = true;
      else hours = Math.max(hours, missing[key] / rate);
    }
    const milliseconds = Math.ceil(hours * 3600000);
    return { missing, milliseconds: unknown || blocked ? null : milliseconds, text: unknown ? "Production inconnue : estimation indisponible" : blocked ? "Production ou stockage insuffisant" : milliseconds ? `Ressources estimées dans ${formatRemaining(milliseconds)}` : "Ressources disponibles · attente du chantier / contrôle" };
  }
  function galaxyTargetPresence(payload, coords) {
    if (payload?.success !== true || !payload.system) return "unknown";
    const system = payload.system;
    if (system.galaxy != null && Number(system.galaxy) !== coords.galaxy || system.system != null && Number(system.system) !== coords.system) return "unknown";
    const content = system.galaxyContent;
    if (Array.isArray(content) && content.every((row) => row && typeof row === "object")) {
      const row = content.find((entry) => Number(entry.position) === coords.position);
      // Native galaxy responses list occupied positions, not every empty slot.
      if (!row) {
        const complete = Number(system.galaxy) === coords.galaxy && Number(system.system) === coords.system && new Set(content.map((entry) => Number(entry.position))).size === content.length && content.every((entry) => Number.isInteger(Number(entry.position)) && Number(entry.position) >= 1 && Number(entry.position) <= 17 && (Number(entry.position) > 15 || entry.planets && typeof entry.planets === "object") && (entry.galaxy == null || Number(entry.galaxy) === coords.galaxy) && (entry.system == null || Number(entry.system) === coords.system));
        return complete ? "missing" : "unknown";
      }
      if (row.galaxy != null && Number(row.galaxy) !== coords.galaxy || row.system != null && Number(row.system) !== coords.system) return "unknown";
      if (Array.isArray(row.planets) || row.planets && typeof row.planets === "object") {
        const planets = Array.isArray(row.planets) ? row.planets : Object.values(row.planets);
        // Type 2 is a debris field. It does not make a planet or moon exist.
        if (!planets.every((planet) => planet && [1, 2, 3].includes(Number(planet.planetType)))) return "unknown";
        const planet = planets.find((planet) => Number(planet.planetType) === (coords.type === "moon" ? 3 : 1));
        return !planet || planet.isDestroyed === true ? "missing" : Number(planet.planetId) > 0 ? "present" : "unknown";
      }
      return "unknown";
    }
    const html = typeof content === "string" ? content : Array.isArray(content) && content.every((row) => typeof row === "string") ? content.join("\n") : "";
    if (!html) return "unknown";
    const doc = new DOMParser().parseFromString(html, "text/html"), row = doc.querySelector(`#galaxyRow${coords.position}`);
    if (!row) return "unknown";
    if (row.classList.contains("empty_filter") && !row.querySelector(".microplanet, [data-planet-id], .cellPlanetName span")) return "missing";
    return row.querySelector(".microplanet, [data-planet-id]") ? coords.type === "moon" ? "unknown" : "present" : "unknown";
  }
  function galaxyDOMPresence(doc, coords, completed = false) {
    if (!completed || Number(doc.querySelector(selectors.galaxyInput)?.value) !== coords.galaxy || Number(doc.querySelector(selectors.systemInput)?.value) !== coords.system) return "unknown";
    const loader = doc.querySelector("#galaxyLoading");
    if (loader && !loader.hidden && (doc.defaultView?.getComputedStyle(loader)?.display ?? loader.style?.display) !== "none") return "unknown";
    const row = doc.getElementById(`galaxyRow${coords.position}`);
    if (!row) return "unknown";
    const planet = row.querySelector(".cellPlanet .microplanet, .cellPlanet [data-planet-id], .microplanet, [data-planet-id]");
    if (row.classList.contains("empty_filter") && !planet) return "missing";
    if (!planet) return "unknown";
    if (coords.type === "moon") return row.querySelector(selectors.galaxyMoon) ? "present" : row.querySelector(".cellMoon") ? "missing" : "unknown";
    return "present";
  }
  async function verifyTargetInGalaxyFrame(coords, onIdentity = () => {}) {
    const context = getPlayerContext();
    if (!context || !document.body) return "unknown";
    return new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.id = `sephi-galaxy-check-${crypto.randomUUID?.() ?? Date.now()}`;
      frame.hidden = true;
      frame.title = `Vérification Galaxie ${formatCoords(coords)}`;
      frame.setAttribute("aria-hidden", "true");
      let settled = false, missing = 0, jqDocument, refreshTimer, domTimer;
      const seen = new WeakSet();
      const finish = (presence) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (refreshTimer) clearTimeout(refreshTimer);
        if (domTimer) clearTimeout(domTimer);
        jqDocument?.off?.(".sephiGalaxyCheck");
        frame.remove();
        campaignLog("Vérification du frigo dans Galaxie", { coords: formatCoords(coords), presence, missingReads: missing });
        resolve(presence);
      };
      const timeout = setTimeout(() => finish("unknown"), 20000);
      frame.addEventListener("load", () => {
        if (settled) return;
        try {
          const game = frame.contentWindow, doc = frame.contentDocument, url = new URL(game.location.href);
          if (url.origin !== location.origin || url.searchParams.get("component") !== "galaxy" || doc.querySelector('meta[name="ogame-player-id"]')?.content !== context.playerId) return finish("unknown");
          const jq = game.jQuery ?? game.$;
          if (typeof jq !== "function") return finish("unknown");
          jqDocument = jq(doc);
          if (typeof jqDocument?.on !== "function") return finish("unknown");
          const refresh = () => {
            if (settled) return;
            if (typeof game.loadContentNew === "function") game.loadContentNew(coords.galaxy, coords.system);
            else if (typeof game.submitForm === "function") {
              const galaxy = doc.querySelector(selectors.galaxyInput), system = doc.querySelector(selectors.systemInput);
              if (!galaxy || !system) return finish("unknown");
              galaxy.value = String(coords.galaxy);
              system.value = String(coords.system);
              game.submitForm();
            } else finish("unknown");
          };
          const accept = (presence, row) => {
            if (settled) return;
            if (presence !== "unknown" && row?.player?.playerName) onIdentity({ playerName: String(row.player.playerName).slice(0, 500), playerId: String(row.player.playerId ?? "").slice(0, 100) });
            if (presence === "present") return finish("present");
            if (presence === "missing" && ++missing >= 2) return finish("missing");
            if (presence === "unknown") missing = 0;
            if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = void 0; refresh(); }, 500);
          };
          jqDocument.on("ajaxComplete.sephiGalaxyCheck", (event, xhr, settings) => {
            if (settled || seen.has(xhr) || !/action=fetchGalaxyContent/.test(String(settings.url)) || xhr.status !== 200) return;
            seen.add(xhr);
            try {
              const payload = JSON.parse(xhr.responseText);
              if (payload?.success !== true || Number(payload.system?.galaxy) !== coords.galaxy || Number(payload.system?.system) !== coords.system) return;
              const presence = galaxyTargetPresence(payload, coords);
              const row = Array.isArray(payload.system.galaxyContent) ? payload.system.galaxyContent.find((entry) => Number(entry?.position) === coords.position) : null;
              if (presence !== "unknown") accept(presence, row);
              else {
                // Native rendering and the loader's fade-out may finish after
                // ajaxComplete; do not mistake that interval for an empty slot.
                if (domTimer) clearTimeout(domTimer);
                domTimer = setTimeout(() => { domTimer = void 0; accept(galaxyDOMPresence(doc, coords, true), row); }, 500);
              }
            } catch { /* A loading skeleton or invalid response never proves absence. */ }
          });
          refresh();
        } catch { finish("unknown"); }
      });
      frame.src = actionURL(coords, "galaxy", context.planetId);
      document.body.append(frame);
    });
  }
  async function verifyTargetPresence(coords, onIdentity = () => {}) {
    // A failed request or invalid consumption never proves that a planet vanished.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const payload = await fetchGalaxySystem(coords), presence = galaxyTargetPresence(payload, coords);
        const row = Array.isArray(payload?.system?.galaxyContent) ? payload.system.galaxyContent.find((entry) => Number(entry?.position) === coords.position) : null;
        if (presence !== "unknown" && row?.player?.playerName) onIdentity({ playerName: String(row.player.playerName).slice(0, 500), playerId: String(row.player.playerId ?? "").slice(0, 100) });
        if (presence === "present") return presence;
        if (presence === "unknown") break;
        if (attempt === 1) return "missing";
      } catch { break; }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return verifyTargetInGalaxyFrame(coords, onIdentity);
  }
  function campaignSlotsAvailable(fleet, reserve) {
    const count = Number(fleet.fleetCount), maximum = Number(fleet.maxFleetCount);
    return fleet.hasFreeSlots() && (reserve === 0 || Number.isSafeInteger(count) && Number.isSafeInteger(maximum) && maximum - count > reserve);
  }
  function plannedAttackLoot(campaign, id, settings) {
    const report = campaign.reports?.[id];
    if (!report) return 0;
    const total = campaign.remainingResourceTotals?.[id] ?? Object.values(report.resources).reduce((a, b) => a + b, 0);
    return Math.floor(total * (report.lootFactor ?? settings.lootFactor));
  }
  function isSlotWorker() {
    try {
      const token = new URL(location.href).searchParams.get("sephiSlotsWorker"), frame = window.frameElement;
      return Boolean(window.top !== window.self && token && frame?.id === "sephi-slots-worker" && frame.dataset.sephiWorker === token && window.parent.location.origin === location.origin);
    } catch { return false; }
  }
  async function runSlotWorker() {
    const context = getPlayerContext();
    if (!context) return;
    const token = new URL(location.href).searchParams.get("sephiSlotsWorker");
    for (let attempt = 0; attempt < 40; attempt++) {
      const fleet = dispatcher(), fleetCount = Number(fleet?.fleetCount), maxFleetCount = Number(fleet?.maxFleetCount);
      if (fleet?.fleetCount != null && fleet.maxFleetCount != null && Number.isSafeInteger(fleetCount) && fleetCount >= 0 && Number.isSafeInteger(maxFleetCount) && maxFleetCount > 0 && maxFleetCount >= fleetCount) {
        localStorage.setItem(`sephiogame:v4:${context.universe}:${context.playerId}:slot-snapshot`, JSON.stringify({ token, planetId: context.planetId, at: Date.now(), fleetCount, maxFleetCount }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  function isEjectWorker() {
    if (window.top === window.self) return false;
    try {
      const token = new URL(location.href).searchParams.get("sephiEjectWorker"), frame = window.frameElement;
      return Boolean(token && frame?.id === "sephi-eject-worker" && frame.dataset.sephiWorker === token && window.parent.location.origin === location.origin);
    } catch { return false; }
  }
  function incomingAttacks(doc, planets, now = Date.now()) {
    const attacks = [];
    for (const row of doc.querySelectorAll(".eventFleet[data-mission-type], .allianceAttack[data-mission-type], [data-role=hostile-fleet]")) {
      if (![1, 2, 9].includes(Number(row.getAttribute("data-mission-type"))) || !["false", "0"].includes(row.getAttribute("data-return-flight"))) continue;
      try {
        const destination = parseCoords(row.querySelector(".destCoords")?.textContent ?? "", row.querySelector(".destFleet figure.moon") ? "moon" : "planet");
        const origin = parseCoords(row.querySelector(".coordsOrigin")?.textContent ?? "", row.querySelector(".originFleet figure.moon") ? "moon" : "planet");
        if (planets.some((planet) => targetId(planet.coords) === targetId(origin))) continue;
        const planet = planets.find((planet) => targetId(planet.coords) === targetId(destination));
        const arrival = Number(row.getAttribute("data-arrival-time")) * 1000;
        if (!planet || !Number.isSafeInteger(arrival) || arrival <= now || !row.id) continue;
        attacks.push({ id: `${row.id}:${arrival}`, planetId: planet.id, arrival, coords: destination });
      } catch { /* Unidentified events cannot authorize an evacuation. */ }
    }
    return attacks.sort((a, b) => a.arrival - b.arrival);
  }
  async function fetchAttackEvents() {
    const url = new URL("/game/index.php?page=componentOnly&component=eventList&ajax=1", location.href);
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch(url.href, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
      if (!response.ok || response.redirected) throw new Error("Liste des attaques indisponible.");
      return new DOMParser().parseFromString(await response.text(), "text/html");
    } finally { clearTimeout(timeout); }
  }
  function evacuationShips(fleet) {
    return fleet.shipsOnPlanet.filter((ship) => Number(ship.number) > 0 && ![212, 217].includes(Number(ship.id))).map((ship) => [Number(ship.id), Number(ship.number)]);
  }
  async function runEjectWorker() {
    const context = getPlayerContext();
    if (!context) return;
    const key = `sephiogame:v4:${context.universe}:${context.playerId}`, jobKey = `${key}:eject-job`;
    const token = new URL(location.href).searchParams.get("sephiEjectWorker");
    const job = readJSON(jobKey);
    const owns = () => readJSON(jobKey).token === token;
    const write = (value) => { if (owns()) localStorage.setItem(jobKey, JSON.stringify({ ...readJSON(jobKey), ...value })); };
    if (job.token !== token || job.status !== "preparing") return;
    window.frameElement.dataset.sephiReady = "1";
    let fleet;
    const fail = (message) => { write({ status: "failed", message }); showPreparation(message); };
    try {
      const config = new Storage(localStorage, key).load().settings.autoEject[context.planetId];
      if (!config?.enabled || context.planetId !== job.planetId) return fail("Évacuation annulée : configuration ou planète différente.");
      for (let attempt = 0; attempt < 40; attempt++) {
        fleet = dispatcher();
        if (fleet?.currentPage === "fleet1" && Array.isArray(fleet.shipsOnPlanet) && fleet.targetPlanet && !fleet.loading) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!fleet || fleet.currentPage !== "fleet1" || fleet.hasShipsSelected?.()) return fail("Dispatcher d’évacuation indisponible ou sélection existante.");
      if (!["galaxy", "system", "position"].every((name) => Number(fleet.targetPlanet[name]) === config.coords[name]) || Number(fleet.targetPlanet.type) !== (config.coords.type === "moon" ? 3 : 1)) return fail("Destination d’évacuation incorrecte.");
      if (!fleet.hasFreeSlots()) return fail("Évacuation impossible : aucun slot libre.");
      const ships = evacuationShips(fleet);
      if (!ships.length) return fail("Aucun vaisseau mobile disponible pour évacuer les ressources.");
      for (const [id, count] of ships) fleet.selectShip(id, count);
      fleet.speedPercent = 1;
      fleet.refresh();
      let fuel;
      for (let attempt = 0; attempt < 40; attempt++) {
        fuel = fleetFuelStatus(fleet);
        if (fuel.enough === true && fuel.consumption !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        fleet.refresh();
      }
      if (fuel?.enough !== true || fuel.consumption === null) return fail("Évacuation impossible : carburant insuffisant ou calcul indisponible.");
      const originalFuel = fleet.hasEnoughFuel;
      fleet.hasEnoughFuel = function () { return fleetFuelStatus(this, originalFuel).enough === true; };
      try {
        fleet.trySubmitFleet1();
        if (fleet.currentPage !== "fleet2") return fail("OGame refuse le passage à la confirmation d’évacuation.");
        refreshHiddenFleetTarget(fleet);
        let ready = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          if (!owns()) return;
          if (!fleet.loading) {
            if (Number(fleet.mission) !== config.mission) fleet.selectMission(config.mission);
            if (typeof fleet.selectMaxAll !== "function") return fail("Chargement maximum des ressources indisponible.");
            fleet.selectMaxAll();
            fleet.refresh();
            fleet.refreshNavigationFleet2(false);
            fuel = fleetFuelStatus(fleet, originalFuel);
            const button = document.getElementById("sendFleet");
            ready = !fleet.loading && Number(fleet.mission) === config.mission && fleet.hasMission() && fuel.consumption !== null && fuel.enough === true && button && !button.classList.contains("off") && !button.hasAttribute("disabled");
            if (ready) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!ready) return fail("Confirmation d’évacuation indisponible.");
        // Recheck the threat and configuration immediately before the only send.
        const events = await fetchAttackEvents();
        const stillIncoming = incomingAttacks(events, ownedPlanets()).some((attack) => attack.id === job.attack.id && attack.planetId === context.planetId && attack.arrival - Date.now() <= 300000);
        const currentConfig = new Storage(localStorage, key).load().settings.autoEject[context.planetId];
        if (!stillIncoming || !owns() || JSON.stringify(config) !== JSON.stringify(currentConfig)) return fail("Évacuation annulée : attaque retirée ou réglages modifiés.");
        const duration = Number(fleet.getDuration?.());
        if (config.mission === 3 && (!Number.isFinite(duration) || duration <= 0 || Date.now() + duration * 2000 <= job.attack.arrival + 60000)) return fail("Transport trop court pour rester absent à l’impact. Choisissez une destination plus lointaine ou un stationnement.");
        if (!fleet.hasFreeSlots() || fleetFuelStatus(fleet, originalFuel).enough !== true) return fail("Slot ou carburant indisponible avant l’évacuation.");
        if (!ships.every(([id, count]) => Number(fleet.shipsToSend.find((ship) => Number(ship.id) === id)?.number) === count)) return fail("La sélection n’inclut plus tous les vaisseaux mobiles.");
        const game = typeof unsafeWindow !== "undefined" ? unsafeWindow : window, jq = game.jQuery ?? game.$;
        if (typeof jq?.post !== "function") return fail("Canal d’envoi OGame indisponible.");
        const remaining = Object.fromEntries(resourceKeys.map((name) => [name, Math.max(0, Math.floor(Number(fleet[`${name}OnPlanet`]) - Number(fleet[`cargo${name[0].toUpperCase()}${name.slice(1)}`]) - (name === "deuterium" ? fuel.consumption : 0)))]));
        if (resourceKeys.some((name) => !Number.isSafeInteger(remaining[name]))) return fail("Chargement des ressources d’évacuation illisible.");
        const originalPost = jq.post;
        let observed = false;
        write({ status: "pending", ships, remaining, sentAt: Date.now(), message: "Envoi d’évacuation en attente de confirmation OGame." });
        jq.post = function (url, data, callback, ...args) {
          if (String(url) !== String(fleet.sendFleetUrl) || typeof callback !== "function") return originalPost.call(this, url, data, callback, ...args);
          observed = true;
          return originalPost.call(this, url, data, function (response, ...rest) {
            let result;
            try { result = typeof response === "string" ? JSON.parse(response) : response; } catch { /* Keep an uncertain send pending. */ }
            if (result?.success === true) {
              write({ status: "confirmed", message: `Évacuation confirmée. Ressources restantes : M ${remaining.metal}, C ${remaining.crystal}, D ${remaining.deuterium}.` });
              return;
            }
            if (result?.success === false) write({ status: "failed", message: "OGame a refusé l’évacuation." });
            return callback.call(this, response, ...rest);
          }, ...args);
        };
        try {
          fleet.trySubmitFleet2();
          if (!observed) fail("La validation OGame a interrompu l’évacuation avant son envoi.");
        } finally { jq.post = originalPost; }
      } finally { fleet.hasEnoughFuel = originalFuel; }
    } catch (error) { if (readJSON(jobKey).status !== "pending") fail(`Évacuation interrompue : ${String(error)}`); }
    finally { if (readJSON(jobKey).status !== "pending" && readJSON(jobKey).status !== "confirmed") fleet?.resetShips?.(); }
  }
  function constructionConfirmed(pending, level) {
    // A changed level/quantity is authoritative even if a native redirect
    // prevented us from seeing the AJAX response.
    return Number.isSafeInteger(level) && level >= pending.before + pending.quantity;
  }
  function moveConstruction(queue, fromId, toId, lockedId) {
    const from = queue.findIndex((item) => item.id === fromId), to = queue.findIndex((item) => item.id === toId);
    if (from < 0 || to < 0 || from === to || fromId === lockedId || toId === lockedId) return queue;
    const result = [...queue];
    result.splice(to, 0, result.splice(from, 1)[0]);
    return result;
  }
  function constructionDetail(doc = document) {
    const details = [doc.querySelector("#technologydetails"), doc.querySelector("#detail")].filter(Boolean);
    const detail = details.find((node) => node.querySelector(".content, h2, h3, .technologyName, .costs, .build-it_wrap")) ?? details[0];
    const marker = detail?.querySelector("[data-technology-id]") ?? doc.querySelector("#detailWrapper [data-technology-id]");
    const selected = doc.querySelector('[data-technology].selected, [data-technology].active, [data-technology].opened');
    const game = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    let endpointTechnology;
    try { if (game.upgradeEndpoint) endpointTechnology = new URL(game.upgradeEndpoint, location.href).searchParams.get("type"); } catch { /* Use native DOM metadata. */ }
    const technology = Number(detail?.getAttribute("data-technology-id") ?? detail?.getAttribute("data-technology") ?? marker?.getAttribute("data-technology-id") ?? selected?.getAttribute("data-technology") ?? endpointTechnology);
    if (!detail || !Number.isSafeInteger(technology) || technology <= 0) return undefined;
    const button = detail.querySelector(".build-it_wrap button.upgrade, button.upgrade, a.build-it") ?? doc.querySelector("#detailWrapper .build-it_wrap button.upgrade, #detail button.upgrade");
    const name = detail.querySelector("h2, h3, .technologyName")?.textContent?.trim() ?? detail.querySelector(".content")?.children?.[1]?.textContent?.trim() ?? doc.querySelector(`[data-technology="${technology}"]`)?.getAttribute("title") ?? `Technologie ${technology}`;
    return { detail, technology, button, name };
  }
  async function runConstructionWorker() {
    const context = getPlayerContext();
    const key = context ? `sephiogame:v4:${context.universe}:${context.playerId}:build-lock:${context.planetId}` : "sephiogame:build-lock";
    if (typeof navigator !== "undefined" && navigator.locks?.request) return navigator.locks.request(key, { ifAvailable: true }, (lock) => lock ? runConstructionAttempt() : undefined);
    return runConstructionAttempt();
  }
  async function runConstructionAttempt() {
    const context = getPlayerContext();
    if (!context) return;
    const key = `sephiogame:v4:${context.universe}:${context.playerId}`;
    const store = new Storage(localStorage, key), stateKey = constructionStateKey(key, context.planetId);
    const token = new URL(location.href).searchParams.get("sephiBuildWorker");
    const state = () => { try { return JSON.parse(localStorage.getItem(stateKey) ?? "{}"); } catch { return {}; } };
    const write = (value) => localStorage.setItem(stateKey, JSON.stringify(value));
    const owns = () => state().token === token;
    const retry = (message) => {
      if (!owns() || !state().running) return;
      write({ ...state(), message, busy: false, checkedAt: Date.now() });
    };
    const finish = (id) => {
      if (!owns() || state().pending?.id !== id) return;
      const latest = store.load();
      const completed = latest.constructionQueue.find((entry) => entry.id === id);
      const economies = readJSON(`${key}:economies`), economy = economies[context.planetId];
      if (completed?.costs && economy?.resources) {
        const elapsed = Math.max(0, Date.now() - economy.at) / 3600000;
        const resources = Object.fromEntries(resourceKeys.map((name) => [name, Math.max(0, Math.floor(Math.min(economy.storage?.[name] ?? Infinity, economy.resources[name] + Math.max(0, economy.production?.[name] ?? 0) * elapsed) - completed.costs[name]))]));
        localStorage.setItem(`${key}:economies`, JSON.stringify({ ...economies, [context.planetId]: { ...economy, resources, at: Date.now() } }));
      }
      latest.constructionQueue = latest.constructionQueue.filter((item) => item.id !== id);
      store.save(latest);
      const next = planetQueue(latest.constructionQueue, context.planetId)[0];
      write({ ...state(), pending: null, busy: false, checkedAt: Date.now(), running: Boolean(next) && state().running, message: next ? "Construction confirmée par OGame." : "File de cette planète terminée." });
    };
    try {
      if (!owns() || !state().running) return;
      window.frameElement.dataset.sephiReady = "1";
      const item = planetQueue(store.load().constructionQueue, context.planetId)[0];
      if (!item) { write({ ...state(), running: false, busy: false, message: "File terminée." }); return; }
      if (context.page !== item.page || context.planetId !== item.planetId) { location.replace(constructionURL(item, token)); return; }
      let tile;
      for (let attempt = 0; attempt < 40; attempt++) {
        tile = document.querySelector(`[data-technology="${item.technology}"]`);
        if (tile) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const level = constructionLevel(tile), pending = state().pending;
      if (pending) {
        if (pending.id !== item.id) throw new Error("La construction en cours ne correspond plus à la file.");
        if (constructionConfirmed(pending, level)) { finish(item.id); return; }
        // Never click again after a possibly accepted request. Waiting also
        // handles games which update the building level only at completion.
        retry("Construction lancée · attente de sa confirmation ou de sa fin.");
        return;
      }
      if (!tile || level === undefined) throw new Error("Niveau ou quantité de la technologie illisible.");
      // Open this technology even when a different detail is already visible.
      // A generic anchor can be a native quick-build link, so never click it.
      const opener = tile.querySelector(".detail_button, .icon, .technology");
      if (opener) opener.click();
      else tile.click();
      let info;
      for (let attempt = 0; attempt < 40; attempt++) {
        info = constructionDetail();
        if (info?.technology === item.technology && info.button) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!info?.button || info.technology !== item.technology) throw new Error("Bouton normal de construction introuvable.");
      const amount = document.getElementById("build_amount");
      if (amount) {
        amount.value = String(item.quantity);
        amount.dispatchEvent(new Event("input", { bubbles: true }));
        amount.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!owns() || !state().running) return;
      const costs = constructionCosts(info.detail, item.quantity);
      const economy = capturePlanetEconomy(key, context);
      if (costs) {
        const latest = store.load();
        latest.constructionQueue = latest.constructionQueue.map((entry) => entry.id === item.id ? { ...entry, costs } : entry);
        store.save(latest);
      }
      const estimate = constructionEstimate(costs, economy);
      // Estimates must not veto a ready native control (deliveries, unknown
      // production, or native quantity pricing can change the actual amounts).
      const button = info.button;
      if (button.disabled || button.hasAttribute("disabled") || button.classList.contains("disabled") || button.classList.contains("off")) { retry(`${estimate.text} · attente de ressources ou du chantier.`); return; }
      if (button.matches(".build-it_premium") || button.closest(".build-it_premium")) throw new Error("Bouton normal de construction indisponible.");
      if (Date.now() - Number(localStorage.getItem(`${key}:last-activity`) ?? 0) < 120000) { retry("Activité du joueur · contrôle reporté de deux minutes."); return; }
      const campaign = readJSON(`${key}:auto-attack`);
      if (campaign.status === "running" && campaign.phase !== "wait" || campaign.pending) { retry("Campagne active · constructions et rotation suspendues."); return; }
      const discovery = readJSON(`${key}:discovery`);
      if (discovery.status === "running" || discovery.worker?.pending) { retry("Scan de découverte actif · construction reportée."); return; }
      write({ ...state(), busy: true, pending: { id: item.id, before: level, quantity: item.quantity, at: Date.now() }, message: `Lancement : ${item.name}.` });
      // Observe only a positive response from this technology's native endpoint.
      const game = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const endpoint = game.upgradeEndpoint;
      const jq = game.jQuery ?? game.$;
      if (typeof jq === "function" && endpoint) jq(document).on("ajaxComplete.sephiBuild", (event, xhr, settings) => {
        if (new URL(settings.url, location.href).href !== new URL(endpoint, location.href).href) return;
        try {
          const result = JSON.parse(xhr.responseText);
          if (result?.success === true) finish(item.id);
          else if (result?.success === false && owns() && state().pending?.id === item.id) write({ ...state(), running: true, busy: false, pending: null, message: "Construction refusée par OGame · nouvelle vérification au prochain passage." });
        } catch { /* Confirm using the refreshed level instead. */ }
      });
      button.click();
      setTimeout(() => { if (owns() && state().pending?.id === item.id) retry("Confirmation de construction en attente · aucun nouvel envoi."); }, 15000);
    } catch (error) {
      if (owns()) write({ ...state(), running: true, busy: false, checkedAt: Date.now(), message: `${error instanceof Error ? error.message : String(error)} · nouvelle vérification au prochain passage.` });
    }
  }

  async function fetchGalaxySystem(point, planetId = "") {
    const key = "sephiogame:galaxy-read-method";
    let preferred;
    try { preferred = sessionStorage.getItem(key); } catch { /* Use the legacy read route first. */ }
    if (preferred === "native") return fetchGalaxyViaNativeFrame(point, planetId);
    const methods = preferred === "GET" ? ["GET", "POST"] : ["POST", "GET"];
    for (const method of methods) {
      const url = new URL("/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1", location.href);
      url.searchParams.set("galaxy", String(point.galaxy)); url.searchParams.set("system", String(point.system));
      if (planetId) url.searchParams.set("cp", planetId);
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await fetch(url.href, { method, credentials: "same-origin", cache: "no-store", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" }, ...(method === "POST" ? { body: new URLSearchParams({ galaxy: String(point.galaxy), system: String(point.system) }) } : {}), signal: abort.signal });
        if (response.redirected) throw new Error("Lecture Galaxie redirigée par OGame.");
        if (response.status === 405) { campaignLog("Méthode de lecture Galaxie refusée; essai du lecteur suivant", { method, galaxy: point.galaxy, system: point.system }); continue; }
        if (!response.ok) throw new Error(`Lecture Galaxie impossible (HTTP ${response.status}).`);
        const text = await response.text();
        if (/^\s*</.test(text)) { campaignLog("La route Galaxie renvoie une page HTML; essai du lecteur suivant", { method }); continue; }
        const payload = JSON.parse(text);
        if (payload?.success !== true || Number(payload.system?.galaxy) !== point.galaxy || Number(payload.system?.system) !== point.system) throw new Error("Réponse Galaxie incomplète ou provenant d’un autre système.");
        try { sessionStorage.setItem(key, method); } catch { /* Request still succeeded. */ }
        return payload;
      } finally { clearTimeout(timeout); }
    }
    const payload = await fetchGalaxyViaNativeFrame(point, planetId);
    try { sessionStorage.setItem(key, "native"); } catch { /* Native read succeeded. */ }
    return payload;
  }
  async function fetchGalaxyViaNativeFrame(point, planetId) {
    const player = getPlayerContext();
    if (!player || !document.body) throw new Error("Lecteur Galaxie natif indisponible.");
    return new Promise((resolve, reject) => {
      const frame = document.createElement("iframe"); frame.hidden = true; frame.title = "Lecture native de la galaxie";
      const url = new URL(actionURL(coordinates(point.galaxy, point.system, 1), "galaxy", planetId)); frame.src = url.href;
      let settled = false, jqDocument, renderTimer;
      const finish = (payload, error) => {
        if (settled) return; settled = true;
        clearTimeout(timeout); if (renderTimer) clearTimeout(renderTimer);
        try { jqDocument?.off(".sephiGalaxyRead"); } catch { /* Detached frame. */ }
        frame.remove();
        if (error) reject(error); else resolve(payload);
      };
      const timeout = setTimeout(() => finish(null, new Error("Les lecteurs HTTP Galaxie refusent la méthode (405) et le lecteur natif n’a pas répondu.")), 20000);
      frame.addEventListener("load", () => {
        if (settled) return;
        try {
          const game = frame.contentWindow, doc = frame.contentDocument;
          if (new URL(game.location.href).origin !== location.origin || doc.querySelector('meta[name="ogame-player-id"]')?.content !== player.playerId) throw new Error("Compte du lecteur Galaxie natif non vérifiable.");
          const jq = game.jQuery ?? game.$;
          if (typeof jq !== "function") throw new Error("Canal Galaxie natif indisponible.");
          jqDocument = jq(doc);
          jqDocument.on("ajaxComplete.sephiGalaxyRead", (event, xhr, settings) => {
            if (settled || xhr.status !== 200 || !/action=(?:fetchGalaxyContent|fetchSolarSystemData)\b/.test(String(settings.url))) return;
            try {
              const payload = JSON.parse(xhr.responseText);
              if (payload?.success === true && payload.system?.galaxyContent !== undefined && Number(payload.system.galaxy) === point.galaxy && Number(payload.system.system) === point.system) return finish(payload);
            } catch { /* Read the fully rendered native rows below. */ }
            const requestURL = new URL(settings.url, location.href), data = new URLSearchParams(typeof settings.data === "string" ? settings.data : settings.data ?? {});
            if (Number(data.get("galaxy") ?? requestURL.searchParams.get("galaxy")) !== point.galaxy || Number(data.get("system") ?? requestURL.searchParams.get("system")) !== point.system) return;
            renderTimer = setTimeout(() => {
              if (settled || Number(doc.querySelector(selectors.galaxyInput)?.value) !== point.galaxy || Number(doc.querySelector(selectors.systemInput)?.value) !== point.system) return;
              const rows = [...doc.querySelectorAll(selectors.galaxyRows)];
              if (rows.length) finish({ success: true, system: { galaxy: point.galaxy, system: point.system, galaxyContent: rows.map((row) => row.outerHTML).join("\n") } });
            }, 500);
          });
          if (typeof game.loadContentNew === "function") game.loadContentNew(point.galaxy, point.system);
          else {
            const galaxy = doc.querySelector(selectors.galaxyInput), system = doc.querySelector(selectors.systemInput);
            if (!galaxy || !system) throw new Error("Formulaire Galaxie natif introuvable.");
            galaxy.value = String(point.galaxy); system.value = String(point.system);
            if (typeof game.submitForm === "function") game.submitForm();
            else if (typeof galaxy.closest("form")?.requestSubmit === "function") galaxy.closest("form").requestSubmit();
            else throw new Error("Actualisation Galaxie native indisponible.");
          }
        } catch (error) { finish(null, error); }
      });
      document.body.append(frame);
    });
  }
  // Manual discovery: persistent progress, explicit inactivity and fresh evidence.
  function discoveryOffsets(input) {
    const match = String(input).trim().match(/^(-?\d+)\s*:\s*(-?\d+)$/);
    if (!match) throw new Error("Intervalle attendu : 0:10, 10:20 ou -20:-10.");
    const a = Number(match[1]), b = Number(match[2]);
    if (![a, b].every((value) => Number.isSafeInteger(value) && Math.abs(value) <= 999)) throw new Error("Intervalle limité à −999…999.");
    const low = a === 0 && b >= 0 ? -b : Math.min(a, b), high = Math.max(a, b);
    return Array.from({ length: high - low + 1 }, (_, index) => low + index).sort((x, y) => Math.abs(x) - Math.abs(y) || x - y);
  }
  function discoverySystemAt(scan) {
    const perZone = scan.config.axis === "galaxies" ? scan.bounds.systems : 1;
    const zone = scan.zones[Math.floor(scan.cursor / perZone)];
    if (zone === undefined) return null;
    if (scan.config.axis === "systems") return { galaxy: scan.home.coords.galaxy, system: zone };
    const systems = Array.from({ length: scan.bounds.systems }, (_, index) => index + 1).sort((a, b) => Math.abs(a - scan.home.coords.system) - Math.abs(b - scan.home.coords.system) || a - b);
    return { galaxy: zone, system: systems[scan.cursor % perZone] };
  }
  function discoveryCandidates(payload, point, playerId) {
    if (payload?.success !== true || Number(payload.system?.galaxy) !== point.galaxy || Number(payload.system?.system) !== point.system) throw new Error("Réponse Galaxie incomplète ou provenant d’un autre système.");
    const content = payload.system.galaxyContent, found = [];
    if (Array.isArray(content) && content.every((entry) => entry && typeof entry === "object")) {
      for (const row of content) {
        if (row.galaxy != null && Number(row.galaxy) !== point.galaxy || row.system != null && Number(row.system) !== point.system) throw new Error("Une ligne Galaxie ne correspond pas au système demandé.");
        const player = row.player ?? {};
        // Accept explicit inactive flags only; never infer inactivity from names.
        const status = String(player.status ?? player.playerStatus ?? row.status ?? player.statusClass ?? "");
        const inactive = [player.isInactive, player.isLongInactive, player.isInactive7Days, player.isInactive28Days, row.isInactive, row.isLongInactive].some((value) => value === true || value === 1 || value === "1") || /(?:^|\s)(?:i|I|inactive|longinactive|status_abbr_inactive|status_abbr_longinactive)(?:$|\s)/.test(status);
        const vacation = [player.isVacation, player.isOnVacation, row.isVacation].some((value) => value === true || value === 1 || value === "1") || /(?:^|\s)(?:v|vacation|status_abbr_vacation)(?:$|\s)/i.test(status);
        if (!inactive || vacation || String(player.playerId) === playerId) continue;
        const planets = Array.isArray(row.planets) ? row.planets : Object.values(row.planets ?? {});
        const planet = planets.find((entry) => Number(entry?.planetType) === 1 && Number(entry.planetId) > 0 && entry.isDestroyed !== true);
        if (!planet || Number(row.position) < 1 || Number(row.position) > 15) continue;
        const coords = coordinates(point.galaxy, point.system, row.position);
        found.push({ id: targetId(coords), coords, playerId: String(player.playerId ?? ""), name: String(player.playerName ?? planet.planetName ?? "Inactif").slice(0, 500) });
      }
    } else {
      const html = typeof content === "string" ? content : Array.isArray(content) && content.every((entry) => typeof entry === "string") ? content.join("\n") : null;
      if (html === null) throw new Error("Format Galaxie inconnu : scan interrompu sans sonder de joueur actif.");
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const row of doc.querySelectorAll('.galaxyRow, [data-role="galaxy-row"]')) {
        if (!row.querySelector('.status_abbr_inactive, .status_abbr_longinactive, .status_abbr_inactive_long') || row.querySelector('.status_abbr_vacation, .vacation, .ownPlayerRow')) continue;
        if (!row.querySelector('.microplanet, [data-planet-id]')) continue;
        const position = row.getAttribute("data-position") ?? row.id.match(/^galaxyRow(\d+)$/)?.[1];
        try {
          const coords = coordinates(point.galaxy, point.system, position);
          const player = row.querySelector('.cellPlayerName, .playername, [data-player-id]');
          const id = String(player?.getAttribute("data-player-id") ?? row.getAttribute("data-player-id") ?? "");
          if (id && id === playerId) continue;
          found.push({ id: targetId(coords), coords, playerId: id, name: (player?.textContent?.trim() || row.querySelector(selectors.galaxyName)?.textContent?.trim() || "Inactif").slice(0, 500) });
        } catch { /* Empty/non-planet rows are not candidates. */ }
      }
    }
    return [...new Map(found.map((item) => [item.id, item])).values()];
  }
  function discoveryDecision(report, config, deep = false) {
    const total = Object.values(report.resources).reduce((sum, value) => sum + value, 0);
    const loot = calculateLoot(report.resources, report.lootFactor ?? config.lootFactor);
    if (total >= config.bigResources || (report.fleet ?? 0) >= config.bigMilitary || (report.defense ?? 0) >= config.bigMilitary) return { action: "big", loot, total };
    if (loot < config.minimumLoot) return { action: "ban", loot, total };
    if ((report.fleet ?? 0) > 0 || (report.defense ?? 0) > 0) return { action: "defended", loot, total };
    if (report.fleet === undefined || report.defense === undefined) return { action: deep ? "unknown" : "deep", loot, total };
    if (total > 1000000) return { action: deep ? "test" : "deep", loot, total };
    return { action: "add", loot, total };
  }
  function discoveryFlights(doc) {
    const flights = [];
    const rows = [...doc.querySelectorAll(".fleetDetails")], missions = inspectOwnFleetMissions(doc).missions;
    for (const [index, row] of rows.entries()) {
      try {
        const node = row.querySelector(".destCoords, .destination, .destinationCoords, .coordsDestination, .destFleet");
        const moon = row.getAttribute("data-destination-type") === "3" || row.querySelector('.destFleet figure.moon');
        const coords = parseCoords(row.getAttribute("data-destination-coordinates") ?? node?.textContent ?? "", moon ? "moon" : "planet");
        const mission = missions[index];
        const id = row.getAttribute("data-fleet-id") ?? row.querySelector("[data-fleet-id]")?.getAttribute("data-fleet-id") ?? row.querySelector(".reversal[ref]")?.getAttribute("ref") ?? row.id?.match(/(?:fleetDetails|fleet)[_-]?(\d+)/i)?.[1];
        if (id && mission === 1) flights.push({ id: String(id), targetId: targetId(coords), returning: Boolean(row.matches('[data-return-flight="1"], [data-return-flight="true"]') || row.querySelector(".fleet_icon_reverse")) });
      } catch { /* An unidentified flight cannot prove survival. */ }
    }
    return flights;
  }
  async function discoveryFetch(url, options = {}) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, credentials: "same-origin", cache: "no-store", signal: abort.signal });
      if (!response.ok || response.redirected) throw new Error(`Lecture OGame impossible (HTTP ${response.status}).`);
      return await response.text();
    } finally { clearTimeout(timeout); }
  }
  async function discoveryMovement(planetId) {
    const url = new URL("/game/index.php", location.href);
    url.searchParams.set("page", "ingame"); url.searchParams.set("component", "movement"); url.searchParams.set("cp", planetId);
    const doc = new DOMParser().parseFromString(await discoveryFetch(url.href), "text/html");
    if (!doc.querySelector("#movement, #movementcomponent, .fleetDetails, #slots")) throw new Error("Liste des mouvements absente.");
    return { ...inspectOwnFleetMissions(doc), flights: discoveryFlights(doc) };
  }
  function discoveryCombatMessages(doc) {
    const reports = [], messageIds = [];
    for (const root of doc.querySelectorAll(selectors.reports)) {
      if (root.querySelector(selectors.reports)) continue;
      const raw = root.querySelector(selectors.rawReport), messageId = root.getAttribute("data-msg-id");
      const observedAt = Number(raw?.getAttribute("data-raw-timestamp")) * 1000;
      const text = root.textContent ?? "";
      let coords;
      try { coords = parseCoords(root.getAttribute("data-messages-filters-coordinates") || root.querySelector(selectors.title)?.textContent || text); } catch { continue; }
      // Require an explicit first-round loss statement, not the mere absence of a fleet.
      const firstRound = /premier (?:tour|round)|first (?:round|battle round)|(?:tour|round)\s*1\b/i.test(text);
      const lost = /(?:votre flotte|your fleet|attaquant|attacker)[\s\S]{0,200}(?:détruit|détruite|abattue?|destroyed|perdu le contact|lost contact)/i.test(text) || /(?:perdu le contact|lost contact)[\s\S]{0,200}(?:flotte|fleet)/i.test(text);
      if (messageId) messageIds.push(messageId);
      if (messageId && firstRound && lost && Number.isSafeInteger(observedAt) && observedAt > 0) reports.push({ messageId, coords, observedAt, destroyed: true });
    }
    return { messageIds, reports };
  }
  function isDiscoveryWorker() {
    try {
      const token = new URL(location.href).searchParams.get("sephiDiscovery"), frame = window.frameElement;
      return Boolean(window.top !== window.self && token && frame?.id === "sephi-discovery-worker" && frame.dataset.sephiWorker === token && window.parent.location.origin === location.origin);
    } catch { return false; }
  }
  async function runDiscoveryWorker() {
    const context = getPlayerContext();
    if (!context) return;
    const key = `sephiogame:v4:${context.universe}:${context.playerId}`, scanKey = `${key}:discovery`;
    const token = new URL(location.href).searchParams.get("sephiDiscovery");
    const state = () => readJSON(scanKey), owns = () => state().worker?.token === token;
    const result = (value) => {
      traceDiscoveryEvent("Résultat de l’étape de découverte", { outcome: value.error ? "error" : value.excluded ? "excluded" : value.wait ? "waiting" : value.sentAt ? "sent" : value.report ? "report" : "observed", message: value.error ?? value.excluded ?? value.message ?? null, ...(value.diagnostic ? { diagnostic: value.diagnostic } : {}) });
      const scan = state(); if (owns()) localStorage.setItem(scanKey, JSON.stringify({ ...scan, worker: { ...scan.worker, pending: false, result: value } }));
    };
    const scan = state(), candidate = scan.queue?.[0], task = scan.worker?.task;
    if (!owns() || scan.status !== "running" || !candidate || context.planetId !== scan.home.id) return;
    window.frameElement.dataset.sephiReady = "1";
    traceDiscoveryEvent("Moteur de découverte prêt", { task, coords: candidate.coords, sourcePlanetId: scan.home.id, page: context.page });
    try {
      if (["report", "deepReport"].includes(task)) {
        await openEspionageMessages();
        const fresh = (item) => item.timestampVerified && targetId(item.report.coords) === candidate.id && item.report.observedAt >= Math.floor(candidate.sentAt / 1000) * 1000;
        const visible = inspectVisibleEspionageReports(), snapshot = visible.reports.some(fresh) ? { reports: [] } : await fetchFreshEspionageReports("20", inspectVisibleEspionageReports, (page) => page.reports.some(fresh));
        const items = [...visible.reports, ...snapshot.reports].filter((item) => item.timestampVerified && targetId(item.report.coords) === candidate.id && item.report.observedAt >= Math.floor(candidate.sentAt / 1000) * 1000).sort((a, b) => b.report.observedAt - a.report.observedAt);
        return result(items.length ? { report: items[0].report } : { wait: true });
      }
      if (task === "track") {
        for (let attempt = 0; attempt < 20 && !document.querySelector(".fleetDetails"); attempt++) await new Promise((resolve) => setTimeout(resolve, 250));
        return result({ movement: document.querySelector(".fleetDetails") ? { ...inspectOwnFleetMissions(document), flights: discoveryFlights(document) } : await discoveryMovement(scan.home.id) });
      }
      if (task === "combat") {
        traceNativeMessageRequests();
        let tab;
        for (let attempt = 0; attempt < 40; attempt++) {
          tab = [...document.querySelectorAll('[data-tabid], .js_subtabs_fleets a, .tabs_btn a')].find((node) => /combat|battle/i.test(node.textContent ?? ""));
          if (tab) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const clickable = tab?.matches("a, button") ? tab : tab?.querySelector("a, button");
        const tabId = tab?.getAttribute("data-tabid") ?? clickable?.closest("[data-tabid]")?.getAttribute("data-tabid");
        if (!clickable || !/^\d+$/.test(tabId ?? "")) return result({ wait: true });
        clickable.click();
        await new Promise((resolve) => setTimeout(resolve, 750));
        const messages = await fetchFreshEspionageReports(tabId, discoveryCombatMessages);
        return result({ destroyed: messages.reports.some((item) => targetId(item.coords) === candidate.id && item.observedAt >= Math.floor(candidate.test.sentAt / 1000) * 1000) });
      }
      let fleet;
      for (let attempt = 0; attempt < 40; attempt++) {
        fleet = dispatcher();
        if (fleet && Array.isArray(fleet.shipsOnPlanet) && fleet.targetPlanet) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!fleet || !Array.isArray(fleet.shipsOnPlanet)) throw new Error("Dispatcher indisponible.");
      if (task === "return") return result({ probeCount: Number(fleet.shipsOnPlanet.find((ship) => Number(ship.id) === 210)?.number ?? 0) });
      const point = { galaxy: candidate.coords.galaxy, system: candidate.coords.system };
      const galaxy = await fetchGalaxySystem(point, scan.home.id);
      const stillInactive = discoveryCandidates(galaxy, point, context.playerId).find((item) => item.id === candidate.id && (!candidate.playerId || !item.playerId || candidate.playerId === item.playerId));
      if (!stillInactive) return result({ excluded: "Joueur plus inactif, planète absente ou propriétaire modifié · ignoré." });
      const latest = new Storage(localStorage, key).load();
      if (latest.targets.some((target) => target.id === candidate.id)) return result({ excluded: "Frigo déjà enregistré pendant le scan." });
      if (latest.discoveryBanned.some((entry) => entry.id === candidate.id && (!entry.playerId || !candidate.playerId || entry.playerId === candidate.playerId))) return result({ excluded: "Cible ajoutée à Banned pendant le scan." });
      if (latest.discoveryBigFish.some((entry) => entry.id === candidate.id && (!entry.playerId || !candidate.playerId || entry.playerId === candidate.playerId))) return result({ excluded: "Gros poisson déjà mis de côté · ignoré." });
      const movements = await discoveryMovement(scan.home.id);
      if (movements.unresolvedAttacks.length) throw new Error("Destination d’une attaque existante illisible.");
      if (movements.activeAttackIds.includes(candidate.id)) return result({ excluded: "Attaque déjà en cours vers cette cible." });
      const bridge = Object.create(Panel.prototype);
      bridge.context = context; bridge.data = { ...latest, targets: [createTarget(candidate.coords, candidate.name, task === "deepSpy" ? 40 : scan.config.probes)] };
      bridge.store = new Storage(localStorage, key); bridge.campaignTabId = scan.owner;
      bridge.campaignContinuationKey = `${key}:discovery-continuation`;
      const phase = task === "test" ? "attack" : "spy";
      bridge.campaign = { status: "running", runnerId: scan.owner, sourcePlanetId: scan.home.id, phase, discoveryTest: task === "test", targetIds: [candidate.id], index: 0, attackIds: [candidate.id], attackIndex: 0, pending: null, reports: { [candidate.id]: candidate.report } };
      let currentCampaign = bridge.campaign;
      Object.defineProperty(bridge, "campaign", { get() {
        if ((!owns() || state().status !== "running" || ["preparing", "pending"].includes(readJSON(`${key}:eject-job`).status)) && !currentCampaign?.pending) currentCampaign.status = "paused";
        return currentCampaign;
      }, set(value) { currentCampaign = value; }, configurable: true });
      bridge.persistCampaign = (campaign) => {
        bridge.campaign = campaign;
        const current = state();
        if (owns()) localStorage.setItem(scanKey, JSON.stringify({ ...current, worker: { ...current.worker, pending: Boolean(campaign.pending) } }));
      };
      const probeBefore = Number(fleet.shipsOnPlanet.find((ship) => Number(ship.id) === 210)?.number ?? 0);
      bridge.recordAutoAttackDispatchResult = (action, id, response) => {
        bridge.campaign = { ...bridge.campaign, pending: null };
        if (response.success !== true) return result({ error: "OGame a refusé l’envoi.", retry: true, diagnostic: { dispatch: fleetDispatchDiagnostic(fleet, phase === "spy" ? 6 : 1), serverErrors: response.errors ?? [], success: false } });
        const duration = Number(fleet.getDuration?.());
        result({ sentAt: Date.now(), test: task === "test" ? { sentAt: Date.now(), fleetId: String(response.fleetId ?? response.fleetID ?? response.fleet?.id ?? ""), beforeIds: movements.flights.map((item) => item.id), probeBefore, expectedArrivalAt: Number.isFinite(duration) && duration > 0 ? Date.now() + duration * 1000 : null, expectedReturnAt: Number.isFinite(duration) && duration > 0 ? Date.now() + duration * 2000 : null, seenReturn: false } : undefined });
      };
      bridge.scheduleCampaignRetry = (message) => result({ error: message, retry: true, diagnostic: bridge.lastDispatchDiagnostic ?? fleetDispatchDiagnostic(fleet, phase === "spy" ? 6 : 1) });
      bridge.skipAutoAttackTarget = (message) => result({ excluded: message });
      bridge.discardUnavailableFuelTarget = () => result({ excluded: "Calcul du carburant indisponible · cible non ajoutée." });
      bridge.waitForAutoAttackFleet = (message) => result({ wait: true, message, diagnostic: fleetDispatchDiagnostic(fleet, phase === "spy" ? 6 : 1) });
      bridge.abandonAutoAttackRound = (message) => result({ error: message });
      bridge.recoverUncertainDispatch = (message) => result({ error: message, uncertain: true });
      bridge.stopBlockedAutoAttackRound = (message) => result({ wait: true, message });
      bridge.message = () => {}; bridge.continueAutoAttacks = () => {};
      await bridge.dispatchAutoAttackFleet();
    } catch (error) { result({ error: String(error), ...(state().worker?.pending ? { uncertain: true } : { retry: true }) }); }
  }

  // src/core/version.ts
  var VERSION = "4.0.0-alpha.51";
  // Update check: compares @version of the published file with VERSION. The raw URL is also the update link:
  // Tampermonkey intercepts *.user.js files and offers to update the installed script.
  var UPDATE_SOURCE = "https://raw.githubusercontent.com/dadoclear/sephi-ogame-reborn/main/sephi-ogame-reborn.user.js";
  var UPDATE_KEY = "sephiogame:update-check", UPDATE_INTERVAL = 6 * 36e5;
  function compareVersions(a, b) {
    const parse = (value) => {
      const [main, pre = ""] = String(value).trim().replace(/^v/i, "").split("-", 2);
      return { main: main.split(".").map((n) => Number(n) || 0), pre: pre ? pre.split(".").map((p) => /^\d+$/.test(p) ? Number(p) : p) : [] };
    };
    const x = parse(a), y = parse(b);
    for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) { const d = (x.main[i] ?? 0) - (y.main[i] ?? 0); if (d) return Math.sign(d); }
    // A release (no suffix) is newer than any pre-release of the same number.
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      const p = x.pre[i], q = y.pre[i];
      if (p === void 0) return -1;
      if (q === void 0) return 1;
      if (p === q) continue;
      if (typeof p === "number" && typeof q === "number") return Math.sign(p - q);
      if (typeof p === "number") return -1;
      if (typeof q === "number") return 1;
      return p < q ? -1 : 1;
    }
    return 0;
  }
  function fetchRemoteText(url) {
    // GM_xmlhttpRequest is not subject to the game's CSP; fetch is the fallback outside Tampermonkey.
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: "GET", url, timeout: 15e3, headers: { "Cache-Control": "no-cache" },
        onload: (r) => r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
        onerror: () => reject(new Error("erreur r\xE9seau")), ontimeout: () => reject(new Error("d\xE9lai d\xE9pass\xE9"))
      }));
    }
    return fetch(url, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
  }
  async function checkForUpdate({ force = false } = {}) {
    const cached = readJSON(UPDATE_KEY, {});
    if (!force && cached.checkedAt && Date.now() - cached.checkedAt < UPDATE_INTERVAL) return cached;
    const text = await fetchRemoteText(`${UPDATE_SOURCE}?t=${Date.now()}`);
    const latest = text.match(/^\/\/\s*@version\s+(\S+)/m)?.[1];
    if (!latest) throw new Error("version publi\xE9e introuvable dans le fichier");
    const result = { checkedAt: Date.now(), latest };
    localStorage.setItem(UPDATE_KEY, JSON.stringify(result));
    return result;
  }

  // src/ui/panel.ts
  var styles = `
:host{--panel:rgba(11,19,34,.9);--line:rgba(130,175,230,.15);--line2:rgba(120,200,255,.32);--text:#e7eef8;--muted:#9bb0c7;--a1:#46e0c8;--a2:#7f8cff;--grad:linear-gradient(135deg,var(--a1),var(--a2));--glow:rgba(70,224,200,.45);--danger:#ff9484;--ease:cubic-bezier(.2,.8,.2,1);font:13.5px/1.5 "Segoe UI",system-ui,sans-serif;color:var(--text);color-scheme:dark}
*{box-sizing:border-box}button,input,select,textarea{font:inherit}
button,a.button{position:relative;cursor:pointer;color:#eaf4ff;background:linear-gradient(180deg,rgba(64,96,138,.34),rgba(28,45,70,.6));border:1px solid var(--line2);border-radius:8px;padding:7px 12px;text-decoration:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);transition:transform .18s var(--ease),box-shadow .18s var(--ease),border-color .18s,background-color .18s,color .18s,filter .18s}
button:hover:not(:disabled),a.button:hover{transform:translateY(-1px);border-color:rgba(110,230,212,.7);box-shadow:0 5px 16px -6px var(--glow),inset 0 1px 0 rgba(255,255,255,.12)}
button:active:not(:disabled),a.button:active{transform:translateY(0) scale(.97);transition-duration:.06s}
button:focus-visible,a.button:focus-visible{outline:2px solid var(--a1);outline-offset:2px}
button:disabled{opacity:.45;cursor:default}
button[type=submit],button.primary{background:var(--grad);border-color:transparent;color:#05161d;font-weight:600;box-shadow:0 4px 14px -6px var(--glow)}
button[type=submit]:hover:not(:disabled),button.primary:hover:not(:disabled){filter:brightness(1.1);box-shadow:0 8px 22px -8px var(--glow)}
button.danger{color:#ffc9c0}button.danger:hover:not(:disabled){border-color:rgba(255,148,132,.75);box-shadow:0 5px 16px -6px rgba(255,120,100,.5)}
.launcher{position:fixed;right:20px;bottom:20px;z-index:1000000;background:var(--grad);color:#05161d;font-weight:600;border:0;border-radius:999px;padding:10px 18px;box-shadow:0 10px 26px -8px var(--glow)}
.launcher::after{content:"";position:absolute;inset:-3px;border-radius:inherit;border:2px solid var(--a1);opacity:0;animation:sephi-ring 3s var(--ease) infinite;pointer-events:none}
.panel{background:radial-gradient(120% 50% at 0% 0%,rgba(70,224,200,.09),transparent 60%),radial-gradient(90% 50% at 100% 0%,rgba(127,140,255,.12),transparent 60%),var(--panel);-webkit-backdrop-filter:blur(14px) saturate(1.25);backdrop-filter:blur(14px) saturate(1.25);border:1px solid var(--line2);border-radius:16px;padding:24px;max-width:1280px;margin:32px auto;box-shadow:0 26px 60px -14px rgba(0,0,0,.7),inset 0 0 0 1px rgba(255,255,255,.03)}
.overlay{container:sephi/inline-size;position:fixed;top:48px;left:16px;width:460px;height:calc(100vh - 64px);min-width:300px;min-height:140px;max-width:calc(100vw - 32px);max-height:calc(100vh - 64px);z-index:999999;overflow:auto;resize:both;margin:0;padding:12px 14px;border-radius:14px;scrollbar-width:thin;scrollbar-color:rgba(120,190,255,.3) transparent;animation:sephi-in .34s var(--ease) both}
.overlay .header{position:sticky;top:-12px;z-index:3;margin:-12px -14px 0;padding:12px 14px 10px;background:linear-gradient(180deg,rgba(9,16,29,.97),rgba(9,16,29,.86));-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);cursor:move;user-select:none;touch-action:none;flex-wrap:wrap;gap:6px 8px}
.overlay .header::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--a1),var(--a2),transparent);background-size:200% 100%;animation:sephi-sheen 7s linear infinite;pointer-events:none}
.overlay .header>div:first-child{flex:1 1 220px;min-width:0}.header-actions{display:flex;gap:6px;margin-left:auto;flex:none}
.overlay .header button{padding:4px 10px;font-size:12px}.overlay .header span{color:var(--muted);font-size:11.5px}.overlay .header p{margin:2px 0 0;font-size:12px;color:var(--muted)}.overlay .header .tag{font-size:11px;padding:2px 9px}
h1{display:flex;align-items:center;gap:8px;font-size:24px;margin:0;letter-spacing:.3px}.overlay h1{font-size:17px}
h1::before{content:"";flex:none;width:9px;height:9px;border-radius:50%;background:var(--a1);box-shadow:0 0 0 3px rgba(70,224,200,.15),0 0 12px var(--a1);animation:sephi-blink 2.6s ease-in-out infinite}
.brand{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
[hidden]{display:none!important}
h2{display:flex;align-items:center;gap:8px;font-size:17px;margin:0 0 12px;letter-spacing:.2px}h2::before{content:"";flex:none;width:3px;height:1em;border-radius:3px;background:var(--grad)}
p{color:var(--muted)}a{color:var(--a1)}small{color:var(--muted)}
.header,.toolbar,.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.header{justify-content:space-between}
.tag{background:rgba(70,224,200,.09);border:1px solid rgba(70,224,200,.32);border-radius:999px;padding:3px 10px;color:#a3f1e4}
.tabs{display:flex;gap:3px;flex-wrap:wrap;margin:20px 0;padding:4px;background:rgba(5,10,20,.55);border:1px solid var(--line);border-radius:12px}.overlay .tabs{margin:12px 0}
.tabs button{background:transparent;border-color:transparent;box-shadow:none;color:var(--muted);padding:5px 10px;font-size:12px;border-radius:8px}
.tabs button:hover:not(:disabled){transform:none;color:var(--text);background:rgba(255,255,255,.06);border-color:transparent;box-shadow:none}
.tabs button[aria-selected=true]{background:var(--grad);color:#05161d;font-weight:600;box-shadow:0 4px 14px -6px var(--glow)}
.card{background:linear-gradient(180deg,rgba(30,48,74,.5),rgba(16,27,44,.55));border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0;transition:border-color .25s,box-shadow .25s}.card:hover{border-color:var(--line2);box-shadow:0 10px 30px -18px var(--glow)}
.overlay .card{padding:13px;margin:10px 0}.overlay h2{font-size:14.5px}
main.enter>*{animation:sephi-rise .4s var(--ease) both}main.enter>:nth-child(2){animation-delay:.05s}main.enter>:nth-child(3){animation-delay:.1s}main.enter>:nth-child(n+4){animation-delay:.15s}
label{display:grid;gap:4px;color:var(--muted);font-size:12.5px}
input,textarea,select{background:rgba(5,11,21,.7);color:#edf5fc;border:1px solid rgba(120,175,230,.24);border-radius:8px;padding:8px 10px;width:100%;min-width:0;transition:border-color .18s,box-shadow .18s,background-color .18s}
input:hover,textarea:hover,select:hover{border-color:rgba(120,200,255,.42)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--a1);background:rgba(5,11,21,.9);box-shadow:0 0 0 3px rgba(70,224,200,.17)}
input::placeholder,textarea::placeholder{color:rgba(155,176,199,.5)}input[type=checkbox]{width:auto;accent-color:var(--a1)}select option{background:#0c1626}input[type=file]{padding:6px}
input[type=file]::file-selector-button{margin-right:10px;border:1px solid var(--line2);border-radius:6px;background:rgba(64,96,138,.4);color:#eaf4ff;padding:4px 10px;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.wide{grid-column:1/-1}textarea{min-height:90px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px}
tbody tr{transition:background-color .2s}tbody tr:hover{background:rgba(120,190,255,.045)}
.overlay table{font-size:12px}.overlay th,.overlay td{padding:7px 5px}
td button{padding:5px 8px;margin:2px}.table{overflow:auto}
.status{white-space:pre-wrap;color:#a3f1e4}.status:not(:empty){margin:4px 0 2px;padding:8px 12px;border-radius:10px;background:rgba(70,224,200,.07);border:1px solid rgba(70,224,200,.24);animation:sephi-rise .3s var(--ease) both}
.status.error{color:var(--danger)}.status.error:not(:empty){background:rgba(255,120,100,.08);border-color:rgba(255,148,132,.35)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(5,11,21,.6);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:11.5px}
details summary{cursor:pointer;color:var(--a1);font-size:12px}details[open] summary{margin-bottom:4px}
.summary{font-size:22px;margin:10px 0;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:600}
.report-warning{background:rgba(255,170,90,.12);color:#ffd08a;font-weight:600}
form>h2{margin-top:18px}form>small{display:block;margin-top:8px}
a.update{display:inline-flex;align-items:center;gap:5px;margin-left:2px;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.2px;color:#2a0b06;background:linear-gradient(135deg,#ffd36b,#ff8a5c);text-decoration:none;cursor:pointer;animation:sephi-update 2.2s ease-out infinite}
a.update::before{content:"\\2B06";font-size:11px}a.update:hover{filter:brightness(1.1)}
@keyframes sephi-update{0%{box-shadow:0 0 0 0 rgba(255,170,90,.6)}70%,100%{box-shadow:0 0 0 8px rgba(255,170,90,0)}}
button.plain{background:linear-gradient(180deg,rgba(64,96,138,.34),rgba(28,45,70,.6));border-color:var(--line2);color:#eaf4ff;font-weight:400;box-shadow:inset 0 1px 0 rgba(255,255,255,.07)}button.plain:hover:not(:disabled){filter:none}
button.launch{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:12px;padding:12px 16px;font-size:15px;font-weight:700;letter-spacing:.3px;color:#05161d;background:var(--grad);border:0;border-radius:12px;box-shadow:0 10px 28px -10px var(--glow),inset 0 1px 0 rgba(255,255,255,.35);overflow:hidden}
button.launch::before{content:"\\1F680";font-size:16px}
button.launch::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.35) 50%,transparent 70%);transform:translateX(-120%);animation:sephi-shine 3.5s ease-in-out infinite;pointer-events:none}
button.launch:hover:not(:disabled){filter:brightness(1.08);box-shadow:0 14px 34px -10px var(--glow),inset 0 1px 0 rgba(255,255,255,.4)}
button.launch.danger{background:linear-gradient(135deg,#ffb36b,#ff6f6f);color:#2a0b06;box-shadow:0 10px 28px -10px rgba(255,111,111,.65);animation:sephi-armed 1s ease-in-out infinite}
button.launch.danger::before{content:"\\26A0"}
@keyframes sephi-shine{0%,60%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
@keyframes sephi-armed{50%{transform:scale(1.015)}}.grid.ships{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:12px}.grid.ships small{font-size:11px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px}.stats>div{display:grid;gap:2px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:rgba(5,11,21,.4)}.stats small{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px}.stats strong{font-size:13px}
.timeline{list-style:none;margin:0 0 10px;padding:0 0 0 14px;border-left:2px solid var(--line2)}.timeline li{position:relative;margin:4px 0;font-size:12px;color:var(--text)}.timeline li::before{content:"";position:absolute;left:-19px;top:6px;width:8px;height:8px;border-radius:50%;background:var(--a1)}
.warn{color:var(--danger)!important}
table.exp-stats{margin-bottom:6px}table.exp-stats tr.current td{background:rgba(70,224,200,.07)}table.exp-stats tr.current td:first-child{color:#a3f1e4;font-weight:600}.timeline li.warn::before{background:var(--danger)}
a.button{display:inline-flex;align-items:center;justify-content:center;line-height:1.3;white-space:nowrap}
.btns{display:flex;flex-wrap:wrap;gap:5px}.btns+.btns{margin-top:5px}.btns button,.btns a.button{margin:0;padding:4px 10px;line-height:1.3;white-space:nowrap}
td.actions{width:45%}td.actions details{margin-top:6px}
.overlay.collapsed{height:auto!important;min-height:0;resize:none;overflow:hidden}.overlay.collapsed .tabs,.overlay.collapsed .status,.overlay.collapsed main{display:none}
@container sephi (max-width:600px){
table.targets,table.targets tbody{display:block}table.targets thead{display:none}
table.targets tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 12px;padding:11px;margin-bottom:8px;background:rgba(5,11,21,.35);border:1px solid var(--line);border-radius:10px;transition:border-color .2s,background-color .2s}
table.targets tr:hover{border-color:var(--line2)}
table.targets td{display:block;padding:0;border:0;width:auto;min-width:0;overflow-wrap:anywhere}
table.targets td[data-label]::before{content:attr(data-label);display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
table.targets td:first-child,table.targets td.actions{grid-column:1/-1}
.btns>*{flex:1 1 auto}
}
@container sephi (max-width:380px){table.targets tr{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.panel{padding:14px;margin:12px}.overlay{top:48px;left:16px;width:calc(100vw - 32px);height:calc(100vh - 64px);margin:0}.grid{grid-template-columns:1fr}h1{font-size:20px}}
@keyframes sephi-in{from{opacity:0;transform:translateY(10px) scale(.985)}}
@keyframes sephi-rise{from{opacity:0;transform:translateY(8px)}}
@keyframes sephi-sheen{to{background-position:-200% 0}}
@keyframes sephi-blink{50%{opacity:.45}}
@keyframes sephi-ring{0%{opacity:.7;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.18)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;
  function element(tag, text = "") {
    const el = document.createElement(tag);
    el.textContent = text;
    return el;
  }
  var fmt = (n) => n.toLocaleString("fr-FR");
  var Panel = class {
    constructor(store, context) {
      __publicField(this, "store", store);
      __publicField(this, "context", context);
      __publicField(this, "data");
      __publicField(this, "shadow");
      __publicField(this, "panel");
      __publicField(this, "content");
      __publicField(this, "status");
      __publicField(this, "activeTab", "Frigos");
      __publicField(this, "editing");
      __publicField(this, "filter", "");
      __publicField(this, "sort", "coords");
      __publicField(this, "onChange", () => {
      });
      __publicField(this, "campaignKey", `${store.key}:auto-attack`);
      __publicField(this, "campaignContinuationKey", `${store.key}:auto-attack-continuation`);
      __publicField(this, "campaign");
      __publicField(this, "campaignBusy", false);
      __publicField(this, "campaignTimer");
      __publicField(this, "campaignTabId");
      __publicField(this, "backgroundCoordinator", window.top === window.self);
      __publicField(this, "workerWatchdog");
      this.data = store.load();
      this.campaignTabId = sessionStorage.getItem(`${store.key}:campaign-tab`) ?? (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
      sessionStorage.setItem(`${store.key}:campaign-tab`, this.campaignTabId);
      this.campaign = this.loadCampaign();
      const host = element("div");
      host.id = "sephi-root";
      document.body.append(host);
      this.shadow = host.attachShadow({ mode: "open" });
      const style = element("style", styles);
      this.shadow.append(style);
      this.panel = element("section");
      this.panel.className = `panel${context ? " overlay" : ""}`;
      const header = element("header");
      header.className = "header";
      const heading = element("div");
      const title = element("h1"), brand = element("span", "SephiOGame");
      brand.className = "brand";
      title.append(brand);
      heading.append(title, element("span", `${VERSION} \xB7 userscript priv\xE9`));
      // Update notice (hidden until a newer published version is found).
      this.updateBadge = element("a");
      this.updateBadge.className = "update";
      this.updateBadge.href = UPDATE_SOURCE;
      this.updateBadge.target = "_blank";
      this.updateBadge.rel = "noopener noreferrer";
      this.updateBadge.hidden = true;
      title.append(this.updateBadge);
      if (context && window.top === window.self) {
        const countdown = element("p", nextAttackText(this.campaign));
        countdown.dataset.sephiCountdown = "";
        heading.append(countdown);
      }
      header.append(heading);
      const badge = element("span", context ? `${context.playerName} \xB7 ${context.universe}` : "Mode local");
      badge.className = "tag";
      header.append(badge);
      if (context) {
        const headerActions = element("div");
        headerActions.className = "header-actions";
        headerActions.append(this.button("Fermer", () => {
          this.panel.hidden = true;
        }));
        header.append(headerActions);
        // Open by default in the main game window; hidden worker iframes keep it closed.
        this.panel.hidden = window.top !== window.self;
        const launcher =this.button("SephiOGame \xB7 Frigos", () => {
          this.panel.hidden = !this.panel.hidden;
        });
        launcher.className = "launcher";
        this.shadow.append(launcher);
      }
      const tabs = element("nav");
      tabs.className = "tabs";
      tabs.setAttribute("aria-label", "SephiOGame");
      for (const name of ["Frigos", "Espionnage", "Découverte", "Auto-attaques", "Exp\xE9ditions", "Constructions", "Param\xE8tres", "Sauvegardes", "Diagnostic"]) {
        const b = this.button(name, () => {
          this.activeTab = name;
          this.render();
        });
        b.dataset.tab = name;
        tabs.append(b);
      }
      this.status = element("div");
      this.status.className = "status";
      this.status.setAttribute("role", "status");
      this.content = element("main");
      this.panel.append(header, tabs, this.status, this.content);
      this.shadow.append(this.panel);
      if (context) this.makeFloating(header);
      if (window.top === window.self) {
        this.showUpdate(readJSON(UPDATE_KEY, {}).latest);
        void this.refreshUpdate();
      }
      if (this.campaign?.status === "running" && this.campaign.phase !== "wait" && this.campaign.runnerId === this.campaignTabId) {
        this.activeTab = "Auto-attaques";
        this.panel.hidden = false;
      }
      this.render();
      window.addEventListener("storage", (event) => {
        if (event.key === `${store.key}:discovery` && this.activeTab === "Découverte") this.render();
        if (event.key === `${store.key}:expedition-state`) this.updateExpeditionStatus();
        if (event.key === this.campaignKey) {
          this.campaign = this.loadCampaign();
          if (this.campaignTimer) clearTimeout(this.campaignTimer);
          this.campaignTimer = void 0;
          if (this.activeTab === "Auto-attaques") this.render();
          if (this.backgroundCoordinator && (!this.campaign || this.campaign.status !== "running" || this.campaign.runnerId !== this.campaignTabId)) this.stopCampaignWorker();
          if (this.backgroundCoordinator && this.campaign?.phase === "wait") {
            this.stopCampaignWorker();
            this.closeFinishedCampaignPanel();
            this.continueAutoAttacks();
          }
          if (this.backgroundCoordinator && this.campaign?.retry) this.continueAutoAttacks();
        }
        if (event.key === store.key) {
          try {
            this.data = store.load();
            this.render();
            this.onChange();
            this.message("Donn\xE9es actualis\xE9es depuis un autre onglet.");
          } catch (error) {
            this.error(error);
          }
        }
      });
    }
    loadCampaign() {
      try {
        const campaign = JSON.parse(localStorage.getItem(this.campaignKey));
        if (campaign?.version === 1 && campaign.playerId === this.context?.playerId && ["running", "paused", "completed"].includes(campaign.status) && ["baseline", "spy", "reports", "attack", "wait"].includes(campaign.phase) && Array.isArray(campaign.targetIds) && Array.isArray(campaign.baselineIds)) {
          if (campaign.status === "paused" || campaign.status === "completed") {
            campaign.uncertainDispatch = campaign.pending ?? campaign.uncertainDispatch;
            campaign.pending = null;
            campaign.waiting = null;
            campaign.repeatMinutes = campaign.repeatMinutes > 0 ? campaign.repeatMinutes : this.data.settings.autoAttackIntervalMinutes;
            campaign.status = "running";
            campaign.phase = "wait";
            campaign.nextRunAt = Date.now() + campaign.repeatMinutes * 60000;
            campaign.message = "Cycle précédent terminé ou abandonné; prochain lancement programmé.";
            localStorage.setItem(this.campaignKey, JSON.stringify(campaign));
          }
          return { ...campaign, runnerId: campaign.runnerId ?? this.campaignTabId };
        }
      } catch {
      }
      return null;
    }
    markCampaignContinuation() {
      sessionStorage.setItem(this.campaignContinuationKey, JSON.stringify({ runnerId: this.campaignTabId, expiresAt: Date.now() + 120000 }));
    }
    consumeCampaignContinuation() {
      let continuation;
      try {
        continuation = JSON.parse(sessionStorage.getItem(this.campaignContinuationKey));
      } catch {
      }
      sessionStorage.removeItem(this.campaignContinuationKey);
      return continuation?.runnerId === this.campaignTabId && continuation.expiresAt >= Date.now();
    }
    persistCampaign(campaign) {
      this.campaign = campaign;
      if (this.backgroundCoordinator && (!campaign || campaign.status !== "running" || campaign.phase === "wait")) this.stopCampaignWorker();
      if (!campaign || campaign.status === "paused" || campaign.status === "completed") sessionStorage.removeItem(this.campaignContinuationKey);
      if (!campaign && this.campaignTimer) {
        clearTimeout(this.campaignTimer);
        this.campaignTimer = void 0;
      }
      if (campaign) localStorage.setItem(this.campaignKey, JSON.stringify(campaign));
      else localStorage.removeItem(this.campaignKey);
      if (this.activeTab === "Auto-attaques") this.render();
      if (campaign?.phase === "wait") this.closeFinishedCampaignPanel();
    }
    closeFinishedCampaignPanel() {
      if (this.backgroundCoordinator && this.activeTab === "Auto-attaques" && this.panel) this.panel.hidden = true;
    }
    makeFloating(header) {
      const panel = this.panel, key = `${this.store.key}:window`;
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(key)) ?? {}; } catch { saved = {}; }
      // Layout limits: keep a margin from the window edges and never cover the Gameforge bar at the top.
      const GAP = 16, LAYOUT = 2;
      const topLimit = () => {
        // The Gameforge bar (#mmonetbar) is injected late; assume its usual 32px height until it exists.
        const bar = document.querySelector("#mmonetbar, #siteHeader")?.getBoundingClientRect();
        return Math.ceil(Math.max(32, bar && bar.height > 0 && bar.top < 80 ? bar.bottom : 0)) + GAP;
      };
      const place = (left, top) => {
        const minTop = topLimit(), maxH = Math.max(140, innerHeight - minTop - GAP);
        panel.style.maxHeight = `${maxH}px`;
        panel.style.maxWidth = `${Math.max(300, innerWidth - 2 * GAP)}px`;
        const r = panel.getBoundingClientRect();
        const w = r.width || parseFloat(panel.style.width) || 460, h = r.height || maxH;
        panel.style.left = `${Math.round(Math.min(Math.max(GAP, left), Math.max(GAP, innerWidth - w - GAP)))}px`;
        panel.style.top = `${Math.round(Math.min(Math.max(minTop, top), Math.max(minTop, innerHeight - h - GAP)))}px`;
      };
      const defaultPlacement = () => {
        // Centre the panel in the free space left of the OGame layout, right below the top bar.
        const minTop = topLimit();
        panel.style.height = `${Math.max(140, innerHeight - minTop - GAP)}px`;
        const width = panel.getBoundingClientRect().width || parseFloat(panel.style.width) || 460;
        const gutter = ["#pageContent", "#box", "#left", "#bar"].map((s) => document.querySelector(s)?.getBoundingClientRect()).find((r) => r && r.width > 0)?.left ?? 0;
        place(gutter >= width + 2 * GAP ? (gutter - width) / 2 : GAP, minTop);
      };
      const save = () => {
        const r = panel.getBoundingClientRect();
        const next = { v: LAYOUT, left: Math.round(r.left), top: Math.round(r.top), collapsed: panel.classList.contains("collapsed") };
        if (!next.collapsed && r.width > 0) { next.width = Math.round(r.width); next.height = Math.round(r.height); } else { next.width = saved.width; next.height = saved.height; }
        saved = next;
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { }
      };
      const clamp = () => {
        const r = panel.getBoundingClientRect();
        if (r.width === 0) return;
        place(r.left, r.top);
      };
      if (Number.isFinite(saved.width)) panel.style.width = `${saved.width}px`;
      // Positions saved by older versions could sit in the corner over the top bar: re-place those.
      const restore = () => {
        if (saved.v === LAYOUT && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
          if (Number.isFinite(saved.height)) panel.style.height = `${saved.height}px`;
          place(saved.left, saved.top);
        } else defaultPlacement();
      };
      if (panel.isConnected && !panel.hidden) restore();
      else requestAnimationFrame(restore);
      const collapse = this.button("Réduire", () => {
        const collapsed = panel.classList.toggle("collapsed");
        collapse.textContent = collapsed ? "Agrandir" : "Réduire";
        save();
      });
      collapse.title = "Réduire / agrandir la fenêtre";
      (header.querySelector(".header-actions") ?? header).append(collapse);
      if (saved.collapsed) { panel.classList.add("collapsed"); collapse.textContent = "Agrandir"; }
      let drag = null;
      header.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button, a")) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: event.clientX - r.left, dy: event.clientY - r.top };
        header.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      header.addEventListener("pointermove", (event) => {
        if (!drag) return;
        place(event.clientX - drag.dx, event.clientY - drag.dy);
      });
      const stop = () => { if (!drag) return; drag = null; save(); };
      header.addEventListener("pointerup", stop);
      header.addEventListener("pointercancel", stop);
      header.addEventListener("dblclick", (event) => { if (!event.target.closest("button, a")) collapse.click(); });
      let timer;
      if (typeof ResizeObserver === "function") new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(save, 400); }).observe(panel);
      window.addEventListener("resize", () => { clamp(); });
      // Re-check once OGame has finished building its layout (top bar, side gutters).
      const settle = () => { if (saved.v === LAYOUT) clamp(); else defaultPlacement(); };
      if (document.readyState === "complete") setTimeout(settle, 300);
      else window.addEventListener("load", () => setTimeout(settle, 300), { once: true });
    }
    open(tab = "Frigos") {
      this.activeTab = tab;
      this.panel.hidden = false;
      this.render();
    }
    message(text) {
      this.status.className = "status";
      this.status.textContent = text;
    }
    error(error) {
      this.status.className = "status error";
      this.status.textContent = error instanceof Error ? error.message : String(error);
      this.panel.hidden = false;
    }
    guarded(action) {
      try {
        const result = action();
        if (result instanceof Promise) result.catch((e) => this.error(e));
      } catch (e) {
        this.error(e);
      }
    }
    button(text, action) {
      const b = element("button", text);
      b.type = "button";
      if (/^(Enregistrer|D\xE9marrer|Analyser|Calculer|Lancer|Programmer|Importer|Nouvelle campagne)/.test(text)) b.classList.add("primary");
      else if (/^(Supprimer|Annuler|Abandonner|Terminer|\xC9carter)/.test(text)) b.classList.add("danger");
      b.addEventListener("click", () => this.guarded(action));
      return b;
    }
    field(parent, title, name, value, type = "text") {
      const label = element("label", title), input = element("input");
      input.name = name;
      input.type = type;
      input.value = value;
      label.append(input);
      parent.append(label);
      return input;
    }
    select(parent, title, name, values, value) {
      const label = element("label", title), select = element("select");
      select.name = name;
      for (const [key, label2] of values) {
        const option = element("option", label2);
        option.value = key;
        select.append(option);
      }
      select.value = value;
      label.append(select);
      parent.append(label);
      return select;
    }
    card(title) {
      const card = element("section");
      card.className = "card";
      card.append(element("h2", title));
      this.content.append(card);
      return card;
    }
    save(next) {
      this.store.save(next);
      this.data = next;
      this.render();
      this.onChange();
    }
    render() {
      // Animate the content only when the tab actually changes, not on background refreshes.
      const switched = this.renderedTab !== this.activeTab;
      this.renderedTab = this.activeTab;
      this.content.classList.remove("enter");
      if (switched) { void this.content.offsetWidth; this.content.classList.add("enter"); }
      this.content.replaceChildren();
      this.shadow.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === this.activeTab)));
      if (this.activeTab === "Frigos") this.targets();
      if (this.activeTab === "Espionnage") this.reports();
      if (this.activeTab === "Découverte") this.discovery();
      if (this.activeTab === "Auto-attaques") this.autoAttacks();
      if (this.activeTab === "Exp\xE9ditions") this.expeditions();
      if (this.activeTab === "Constructions") this.constructions();
      if (this.activeTab === "Param\xE8tres") this.settings();
      if (this.activeTab === "Sauvegardes") this.backups();
      if (this.activeTab === "Diagnostic") this.diagnostics();
    }
    discoveryState() { return this.store?.key ? readJSON(`${this.store.key}:discovery`, null) : null; }
    discoveryActive() { const scan = this.discoveryState(); return scan?.status === "running" || Boolean(scan?.worker?.pending); }
    discoveryDiagnostic() {
      const scan = this.discoveryState();
      if (!scan) return null;
      const candidate = scan.queue?.[0];
      return diagnosticValue({ version: VERSION, status: scan.status, message: scan.message, startedAt: scan.startedAt, systemsRead: scan.cursor, totalSystems: scan.totalSystems, home: scan.home, current: candidate ? { name: candidate.name, coords: candidate.coords, step: candidate.step, retries: candidate.errors ?? 0, sentAt: candidate.sentAt ?? null } : null, worker: scan.worker ? { task: scan.worker.task, pending: scan.worker.pending, startedAt: scan.worker.startedAt, lastEvent: scan.worker.lastEvent ?? null, lastEventAt: scan.worker.lastEventAt ?? null } : null, lastDiagnostic: scan.lastDiagnostic ?? candidate?.lastDiagnostic ?? null, failures: scan.failures ?? [], events: scan.debug ?? [] });
    }
    saveDiscovery(scan) {
      localStorage.setItem(`${this.store.key}:discovery`, JSON.stringify(scan));
      if (this.activeTab === "Découverte") this.render();
    }
    discovery() {
      const card = this.card("Découverte manuelle de frigos inactifs");
      if (!this.context) { card.append(element("p", "Ouvrez OGame pour lancer un scan.")); return; }
      const scan = this.discoveryState(), config = readJSON(`${this.store.key}:discovery-config`, { axis: "systems", range: "0:10", minimumLoot: 100000, bigResources: 10000000, bigMilitary: 5000000 });
      card.append(element("p", "Lancement manuel uniquement, depuis la planète mère. Seuls les joueurs marqués i / I sont sondés. Les frigos existants et les cibles bannies sont ignorés. Le scan suspend la rotation des planètes et le lancement des campagnes."));
      const form = element("form"), grid = element("div"); grid.className = "grid";
      this.select(grid, "Étendue", "axis", [["systems", "Systèmes autour de la PM"], ["galaxies", "Galaxies entières"]], config.axis);
      this.field(grid, "Intervalle relatif à la PM", "range", config.range);
      this.field(grid, "Butin minimum pour conserver un frigo", "minimumLoot", String(config.minimumLoot), "number").min = "0";
      this.field(grid, "Gros poisson : ressources totales à partir de", "bigResources", String(config.bigResources), "number").min = "1000001";
      this.field(grid, "Gros poisson : valeur flotte / défense à partir de", "bigMilitary", String(config.bigMilitary), "number").min = "1";
      grid.append(element("small", "0:10 = 0, −1, +1…−10, +10. 10:20 = +10…+20. −20:−10 = −10…−20. Hors limites de l’univers : ignoré, sans boucle. Les valeurs de flotte/défense sont celles du rapport."));
      const start = element("button", "Lancer ce scan"); start.type = "submit"; start.disabled = ["running", "paused"].includes(scan?.status);
      form.append(grid, start); card.append(form);
      form.addEventListener("submit", (event) => { event.preventDefault(); this.guarded(async () => {
        const values = new FormData(form), next = { axis: String(values.get("axis")), range: String(values.get("range")), minimumLoot: Number(values.get("minimumLoot")), bigResources: Number(values.get("bigResources")), bigMilitary: Number(values.get("bigMilitary")) };
        await this.startDiscovery(next);
      }); });
      card.append(element("p", "Au-delà d’un million de ressources : espionnage avec 40 sondes, puis attaque de test avec une sonde uniquement si flotte et défense sont explicitement nulles. Le retour de cette sonde doit être confirmé avant l’ajout. Un rapport trop incomplet ou un retour non vérifié reste à examiner."));
      if (scan) {
        card.append(element("p", `${scan.status === "completed" ? "Scan terminé" : scan.status === "paused" ? "Scan en pause" : "Scan en cours"} · ${scan.cursor}/${scan.totalSystems} systèmes · ${scan.rows.length} résultat(s). ${scan.message ?? ""}`));
        const candidate = scan.queue?.[0], steps = { spy: "envoi du sondage", report: "attente / lecture du rapport", deepSpy: "envoi de 40 sondes", deepReport: "lecture du rapport à 40 sondes", test: "attaque de test à une sonde", track: "suivi de la sonde", combat: "lecture du rapport de combat", return: "vérification du retour" };
        card.append(element("p", `Départ : ${scan.home.name ?? "Planète mère"} ${formatCoords(scan.home.coords)} · planète ${scan.home.id}.`));
        card.append(element("small", "Le compteur mesure les systèmes dont la liste a été lue. Leurs sondages peuvent encore être en cours."));
        if (candidate) {
          const remaining = Math.max(0, Math.ceil((scan.nextAt - Date.now()) / 1000));
          card.append(element("p", `Cible en cours : ${candidate.name} ${formatCoords(candidate.coords)} · ${steps[candidate.step] ?? candidate.step} · reprise ${Math.min(candidate.errors ?? 0, 3)}/3${!scan.worker && remaining ? ` · prochaine tentative à ${new Date(scan.nextAt).toLocaleTimeString("fr-FR")}` : ""}.`));
          if (scan.worker?.lastEvent) card.append(element("p", `Moteur : ${scan.worker.lastEvent} · ${new Date(scan.worker.lastEventAt).toLocaleTimeString("fr-FR")}`));
        }
        const diagnostic = this.discoveryDiagnostic();
        if (diagnostic.lastDiagnostic) {
          const detail = element("details"); detail.open = true;
          detail.append(element("summary", "Dernier diagnostic du scan"), element("pre", JSON.stringify(diagnostic.lastDiagnostic, null, 2)));
          card.append(detail);
        }
        if (diagnostic.events.length) {
          const events = element("details");
          events.append(element("summary", `Journal détaillé (${diagnostic.events.length} événements conservés)`));
          for (const entry of diagnostic.events.slice(-30)) events.append(element("pre", `${new Date(entry.at).toLocaleTimeString("fr-FR")} · ${entry.coords ? formatCoords(entry.coords) : ""} · ${entry.task} · ${entry.event}\n${JSON.stringify(entry.details, null, 2)}`));
          card.append(events);
        }
        card.append(this.button("Exporter diagnostic du scan", () => this.download("SephiOGame-scan-diagnostic.json", JSON.stringify(this.discoveryDiagnostic(), null, 2))));
        if (scan.owner === this.campaignTabId && scan.status === "running") card.append(this.button("Mettre en pause", () => this.saveDiscovery({ ...this.discoveryState(), status: "paused", message: "Scan en pause. Les envois déjà effectués continuent dans OGame." })));
        if (scan.status === "paused") card.append(this.button("Reprendre ici", () => {
          const current = this.discoveryState();
          if (current.worker?.pending) throw new Error("Un envoi attend sa confirmation. Vérifiez les mouvements avant de reprendre.");
          if (this.campaign?.status === "running" && this.campaign.phase !== "wait") throw new Error("Attendez la fin du cycle d’auto-attaque.");
          this.saveDiscovery({ ...current, owner: this.campaignTabId, status: "running", errors: 0, nextAt: 0, message: "Scan repris." });
        }));
        if (scan.status === "running" && scan.owner !== this.campaignTabId && !scan.worker?.pending) card.append(this.button("Poursuivre dans cet onglet", () => this.saveDiscovery({ ...this.discoveryState(), owner: this.campaignTabId })));
        if (scan.worker?.pending && Date.now() - scan.worker.startedAt >= 45000) card.append(this.button("Écarter l’envoi incertain et reprendre", () => {
          const current = this.discoveryState();
          if (!current.worker?.pending) return;
          document.getElementById("sephi-discovery-worker")?.remove();
          this.finishDiscoveryCandidate({ ...current, owner: this.campaignTabId, status: "running" }, current.queue[0], "Envoi incertain écarté manuellement · cible non ajoutée, aucun renvoi.");
        }));
        if (["running", "paused"].includes(scan.status)) card.append(this.button("Terminer le scan", () => {
          const current = this.discoveryState();
          if (current.worker?.pending) throw new Error("Attendez la confirmation de l’envoi en cours avant de terminer.");
          document.getElementById("sephi-discovery-worker")?.remove();
          this.saveDiscovery({ ...current, status: "completed", worker: null, message: "Scan terminé manuellement · résultats conservés." });
          this.continueAutoAttacks();
        }));
        this.discoveryTable(card, scan);
        card.append(this.button("Exporter ce rapport JSON", () => this.download(`SephiOGame-scan-${scan.startedAt}.json`, JSON.stringify(scan, null, 2))));
      }
      const banned = this.card(`Banned · ${this.data.discoveryBanned?.length ?? 0} cible(s)`);
      banned.append(element("p", "Les cibles sous le seuil sont exclues des scans suivants, même après rechargement. Retirez une entrée pour la réévaluer. Un changement de joueur vérifiable autorise une nouvelle évaluation."));
      for (const entry of this.data.discoveryBanned ?? []) {
        const row = element("div", `${formatCoords(entry.coords)} · ${entry.name} · butin ${fmt(entry.loot)} `);
        row.append(this.button("Réautoriser", () => { const latest = this.store.load(); this.save({ ...latest, discoveryBanned: latest.discoveryBanned.filter((item) => item.id !== entry.id) }); }));
        banned.append(row);
      }
      const fish = this.data.discoveryBigFish ?? [];
      if (fish.length) {
        const card = this.card(`Gros poissons potentiels · ${fish.length}`);
        this.discoveryTable(card, { rows: fish.map((item) => ({ ...item, added: false, big: true, reason: "Mis de côté pour examen manuel." })) });
        for (const item of fish) card.append(this.button(`Réévaluer ${formatCoords(item.coords)} au prochain scan`, () => { const latest = this.store.load(); this.save({ ...latest, discoveryBigFish: latest.discoveryBigFish.filter((entry) => entry.id !== item.id) }); }));
      }
      const archives = readJSON(`${this.store.key}:discovery-reports`, []);
      if (archives.length) {
        const archive = this.card("Rapports des scans précédents");
        for (const report of archives.slice().reverse()) {
          const details = element("details"); details.append(element("summary", `${new Date(report.startedAt).toLocaleString("fr-FR")} · ${report.rows.length} résultat(s)`));
          this.discoveryTable(details, report); archive.append(details);
        }
      }
    }
    discoveryTable(host, scan) {
      const wrapper = element("div"), table = element("table"), head = element("thead"), heading = element("tr"), body = element("tbody"); wrapper.className = "table";
      for (const title of ["Coordonnées", "Butin trouvé", "Flotte", "Défense", "Ajouté aux frigos", "Gros poisson", "Résultat"]) heading.append(element("th", title));
      head.append(heading); table.append(head);
      for (const item of scan.rows) {
        const row = element("tr");
        for (const value of [formatCoords(item.coords), item.loot === undefined ? "?" : fmt(item.loot), item.fleet === undefined ? "?" : fmt(item.fleet), item.defense === undefined ? "?" : fmt(item.defense), item.added ? "Oui" : "Non", item.big ? "Oui" : "Non", item.reason]) row.append(element("td", value));
        if (item.diagnostic) { const detail = element("details"); detail.append(element("summary", "Diagnostic"), element("pre", JSON.stringify(item.diagnostic, null, 2))); row.lastElementChild?.append(detail); }
        body.append(row);
      }
      table.append(body); wrapper.append(table); host.append(wrapper);
    }
    async startDiscovery(config) {
      if (this.discoveryStarting || this.discoveryActive()) return;
      if (this.discoveryState()?.status === "paused") throw new Error("Terminez ou reprenez le scan en pause avant d’en lancer un autre.");
      const campaign = readJSON(this.campaignKey, this.campaign);
      if (campaign?.pending || campaign?.status === "running" && campaign.phase !== "wait") throw new Error("Attendez la fin du cycle d’auto-attaque avant de scanner.");
      if (!["systems", "galaxies"].includes(config.axis)) throw new Error("Étendue de scan invalide.");
      discoveryOffsets(config.range);
      for (const name of ["minimumLoot", "bigResources", "bigMilitary"]) number(config[name], name === "minimumLoot" ? 0 : name === "bigResources" ? 1000001 : 1);
      const home = ownedPlanets().find((planet) => planet.id === this.homePlanetId());
      if (!home || home.coords.type !== "planet") throw new Error("Configurez une planète mère détectable dans Paramètres.");
      this.discoveryStarting = true;
      try {
        const xml = new DOMParser().parseFromString(await discoveryFetch(new URL("/api/serverData.xml", location.href).href), "application/xml");
        const bounds = { galaxies: Number(xml.querySelector("galaxies")?.textContent), systems: Number(xml.querySelector("systems")?.textContent) };
        number(bounds.galaxies, 1, 99); number(bounds.systems, 1, 999);
        const liveCampaign = readJSON(this.campaignKey, this.campaign);
        if (this.discoveryActive() || liveCampaign?.pending || liveCampaign?.status === "running" && liveCampaign.phase !== "wait") throw new Error("Une autre opération a commencé pendant la préparation du scan.");
        const origin = config.axis === "galaxies" ? home.coords.galaxy : home.coords.system, maximum = config.axis === "galaxies" ? bounds.galaxies : bounds.systems;
        const zones = discoveryOffsets(config.range).map((offset) => origin + offset).filter((value) => value >= 1 && value <= maximum);
        if (!zones.length) throw new Error("Cet intervalle est entièrement hors de l’univers.");
        const previous = this.discoveryState();
        if (previous?.rows?.length) localStorage.setItem(`${this.store.key}:discovery-reports`, JSON.stringify([...readJSON(`${this.store.key}:discovery-reports`, []), { startedAt: previous.startedAt, rows: previous.rows, config: previous.config }].slice(-5)));
        localStorage.setItem(`${this.store.key}:discovery-config`, JSON.stringify(config));
        this.saveDiscovery({ version: 1, status: "running", owner: this.campaignTabId, home, bounds, config: { ...config, lootFactor: this.data.settings.lootFactor, probes: this.data.settings.defaultProbes }, zones, cursor: 0, totalSystems: zones.length * (config.axis === "galaxies" ? bounds.systems : 1), queue: [], rows: [], worker: null, startedAt: Date.now(), nextAt: 0, message: "Scan manuel démarré." });
        if (this.campaignTimer) clearTimeout(this.campaignTimer); this.campaignTimer = void 0;
        this.open("Découverte");
      } finally { this.discoveryStarting = false; }
    }
    finishDiscoveryCandidate(scan, candidate, reason, { add = false, ban = false, big = false } = {}) {
      const latest = this.store.load();
      if (ban) { latest.discoveryBanned = latest.discoveryBanned.filter((item) => item.id !== candidate.id); latest.discoveryBanned.push({ id: candidate.id, coords: candidate.coords, name: candidate.name, playerId: candidate.playerId, loot: candidate.loot, at: Date.now(), reason }); }
      if (big) { latest.discoveryBigFish = latest.discoveryBigFish.filter((item) => item.id !== candidate.id); latest.discoveryBigFish.push({ id: candidate.id, coords: candidate.coords, name: candidate.name, playerId: candidate.playerId, loot: candidate.loot, fleet: candidate.report?.fleet, defense: candidate.report?.defense, at: Date.now(), tags: ["gros poisson potentiel"] }); }
      let added = false;
      if (add && candidate.report && !latest.targets.some((item) => item.id === candidate.id)) {
        const target = recordReport(createTarget(candidate.coords, candidate.name, scan.config.probes), candidate.report);
        target.tags = ["découverte", ...(candidate.test?.seenReturn ? ["sonde revenue"] : [])]; latest.targets.push(target); added = true;
      }
      this.store.save(latest); this.data = latest; this.onChange?.();
      const row = { coords: candidate.coords, name: candidate.name, playerId: candidate.playerId, loot: candidate.loot, fleet: candidate.hiddenResistance ? undefined : candidate.report?.fleet, defense: candidate.hiddenResistance ? undefined : candidate.report?.defense, hiddenResistance: Boolean(candidate.hiddenResistance), added, big, tags: big ? ["gros poisson potentiel"] : [], reason, at: Date.now(), ...(candidate.lastDiagnostic ? { diagnostic: candidate.lastDiagnostic } : {}) };
      this.saveDiscovery({ ...scan, rows: [...scan.rows, row], queue: scan.queue.slice(1), worker: null, nextAt: Date.now() + 2000, message: `${formatCoords(candidate.coords)} · ${reason}` });
    }
    applyDiscoveryResult(scan, value) {
      if (!scan.queue?.length) return;
      const candidate = { ...scan.queue[0] };
      if (!candidate) return;
      if (value.diagnostic) {
        candidate.lastDiagnostic = { at: Date.now(), coords: candidate.coords, task: candidate.step, details: diagnosticValue(value.diagnostic) };
        scan = { ...scan, lastDiagnostic: candidate.lastDiagnostic };
      }
      const finish = (reason, options) => this.finishDiscoveryCandidate(scan, candidate, reason, options);
      if (value.uncertain) return finish("Résultat d’envoi incertain · aucune nouvelle tentative automatique.");
      if (value.excluded) return finish(value.excluded);
      if (value.error) {
        candidate.errors = (candidate.errors ?? 0) + 1;
        scan = { ...scan, failures: [...(scan.failures ?? []), { at: Date.now(), coords: candidate.coords, task: candidate.step, attempt: candidate.errors, message: value.error, diagnostic: candidate.lastDiagnostic ?? null }].slice(-50) };
        if (!value.retry || candidate.errors > 3) return finish(`Échec : ${value.error}`);
      } else if (value.sentAt) {
        candidate.sentAt = value.sentAt;
        candidate.errors = 0;
        candidate.step = candidate.step === "test" ? "track" : candidate.step === "deepSpy" ? "deepReport" : "report";
        if (value.test) candidate.test = value.test;
      } else if (value.report) {
        candidate.report = value.report;
        const decision = discoveryDecision(value.report, scan.config, candidate.step === "deepReport");
        candidate.loot = decision.loot;
        if (decision.action === "ban") return finish("Butin sous le seuil · Banned.", { ban: true });
        if (decision.action === "big") return finish("Gros poisson potentiel · à examiner manuellement.", { big: true });
        if (decision.action === "add") return finish("Flotte et défense nulles · ajouté aux frigos.", { add: true });
        if (decision.action === "defended") return finish("Flotte ou défense présente · non ajouté.");
        if (decision.action === "unknown") return finish("Informations toujours incomplètes après 40 sondes · non ajouté.");
        candidate.step = decision.action === "deep" ? "deepSpy" : "test";
      } else if (value.movement) {
        const test = { ...candidate.test };
        const matches = value.movement.flights.filter((flight) => flight.targetId === candidate.id && (test.fleetId ? flight.id === test.fleetId : !test.beforeIds.includes(flight.id)));
        if (matches.length === 1) {
          if (matches[0].returning && test.expectedArrivalAt && Date.now() < test.expectedArrivalAt - 2000) return finish("Sonde rappelée avant l’impact · test non validé.");
          test.fleetId = matches[0].id;
          test.seenReturn ||= matches[0].returning;
        } else if (!matches.length && test.seenReturn && (!test.expectedReturnAt || Date.now() >= test.expectedReturnAt)) candidate.step = "return";
        else if (!matches.length && Date.now() - test.sentAt > 30000) candidate.step = "combat";
        candidate.test = test;
      } else if (candidate.step === "combat") {
        if (value.destroyed) { candidate.hiddenResistance = true; return finish("Sonde détruite au premier tour · défense/flotte cachée, non ajouté."); }
        candidate.step = "track";
      } else if (candidate.step === "return" && Number.isSafeInteger(value.probeCount)) {
        if (candidate.test.seenReturn && value.probeCount >= candidate.test.probeBefore) return finish("Retour de la sonde confirmé · ajouté aux frigos.", { add: true });
        candidate.step = "track";
      }
      const reportTimedOut = ["report", "deepReport"].includes(candidate.step) && Date.now() - candidate.sentAt > 30 * 60000;
      const testTimedOut = candidate.test && Date.now() > Math.max(candidate.test.sentAt + 30 * 60000, (candidate.test.expectedReturnAt ?? 0) + 10 * 60000);
      if (reportTimedOut || testTimedOut) return finish("Rapport ou retour non confirmé dans le délai · non ajouté.");
      this.saveDiscovery({ ...scan, queue: [candidate, ...scan.queue.slice(1)], worker: null, nextAt: Date.now() + (value.wait || value.error || ["track", "combat", "return", "report", "deepReport"].includes(candidate.step) ? 15000 : 2000), ...(candidate.lastDiagnostic ? { lastDiagnostic: candidate.lastDiagnostic } : {}), message: value.error ? `${formatCoords(candidate.coords)} · ${candidate.step} · reprise ${candidate.errors}/3 · ${value.error}` : value.message ?? `${formatCoords(candidate.coords)} · ${candidate.step}` });
    }
    async monitorDiscovery() {
      if (!this.backgroundCoordinator || this.discoveryBusy) return;
      let scan = this.discoveryState();
      if (!scan || scan.owner !== this.campaignTabId || scan.status !== "running") return;
      const frame = document.getElementById("sephi-discovery-worker");
      if (scan.worker?.result) {
        frame?.remove(); this.applyDiscoveryResult(scan, scan.worker.result); return;
      }
      if (scan.worker) {
        if (Date.now() - scan.worker.startedAt < 45000) return;
        if (scan.worker.pending) {
          this.saveDiscovery({ ...scan, status: "paused", lastDiagnostic: { at: Date.now(), coords: scan.queue[0]?.coords, task: scan.worker.task, details: { pending: true, lastEvent: scan.worker.lastEvent ?? null, lastEventAt: scan.worker.lastEventAt ?? null, frameReady: Boolean(frame?.dataset.sephiReady), ageMs: Date.now() - scan.worker.startedAt } }, message: "Envoi non confirmé · scan en pause, aucun renvoi automatique. Vérifiez les mouvements." }); return;
        }
        const diagnostic = { lastEvent: scan.worker.lastEvent ?? null, lastEventAt: scan.worker.lastEventAt ?? null, frameReady: Boolean(frame?.dataset.sephiReady), ageMs: Date.now() - scan.worker.startedAt, task: scan.worker.task };
        frame?.remove(); this.applyDiscoveryResult(scan, { error: "Le moteur de scan n’a pas répondu.", retry: true, diagnostic }); return;
      }
      if (Date.now() < scan.nextAt) return;
      const campaign = readJSON(this.campaignKey, this.campaign), eject = readJSON(`${this.store.key}:eject-job`);
      if (campaign?.pending || campaign?.status === "running" && campaign.phase !== "wait" || ["preparing", "pending"].includes(eject.status)) return;
      if (!scan.queue.length) {
        const point = discoverySystemAt(scan);
        if (!point) { this.saveDiscovery({ ...scan, status: "completed", finishedAt: Date.now(), message: "Scan terminé · rapport conservé." }); this.continueAutoAttacks(); return; }
        this.discoveryBusy = true;
        try {
          const payload = await fetchGalaxySystem(point, scan.home.id);
          const latest = this.store.load(), candidates = discoveryCandidates(payload, point, this.context.playerId);
          const queue = [], rows = [...scan.rows];
          for (const candidate of candidates) {
            const existing = latest.targets.some((target) => target.id === candidate.id);
            const banned = latest.discoveryBanned.find((entry) => entry.id === candidate.id && (!entry.playerId || !candidate.playerId || entry.playerId === candidate.playerId));
            const fish = latest.discoveryBigFish.find((entry) => entry.id === candidate.id && (!entry.playerId || !candidate.playerId || entry.playerId === candidate.playerId));
            if (existing || banned || fish) rows.push({ ...candidate, added: false, big: Boolean(fish), reason: existing ? "Déjà dans les frigos · ignoré." : banned ? "Banned · ignoré." : "Gros poisson déjà mis de côté · ignoré.", loot: banned?.loot ?? fish?.loot, fleet: fish?.fleet, defense: fish?.defense });
            else queue.push({ ...candidate, step: "spy", errors: 0 });
          }
          const current = this.discoveryState();
          if (current.startedAt !== scan.startedAt || current.status !== "running") return;
          this.saveDiscovery({ ...current, cursor: scan.cursor + 1, queue, rows, errors: 0, debug: [...(current.debug ?? []), { at: Date.now(), version: VERSION, event: "Système lu", task: "galaxy", coords: null, details: { ...point, inactiveCandidates: candidates.length, ignored: candidates.length - queue.length, queued: queue.map((item) => item.id) } }].slice(-150), nextAt: Date.now() + 2000, message: `Galaxie ${point.galaxy}, système ${point.system} · ${queue.length} nouvelle(s) cible(s) inactive(s).` });
        } catch (error) {
          const current = this.discoveryState(), errors = (current.errors ?? 0) + 1;
          if (current.startedAt !== scan.startedAt) return;
          this.saveDiscovery({ ...current, errors, status: errors > 3 ? "paused" : current.status, debug: [...(current.debug ?? []), { at: Date.now(), version: VERSION, event: "Lecture du système en échec", task: "galaxy", coords: null, details: { ...point, error: String(error), attempt: errors } }].slice(-150), nextAt: Date.now() + 15000, message: `Lecture Galaxie : ${String(error)} · progression conservée.` });
        } finally { this.discoveryBusy = false; }
        return;
      }
      const candidate = scan.queue[0], latest = this.store.load();
      if (latest.targets.some((target) => target.id === candidate.id)) { this.finishDiscoveryCandidate(scan, candidate, "Déjà enregistré · ignoré."); return; }
      const task = candidate.step, token = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const url = ["spy", "deepSpy", "test"].includes(task) ? new URL(actionURL(candidate.coords, task === "test" ? "attack" : "spy", scan.home.id)) : new URL("/game/index.php", location.href);
      if (!["spy", "deepSpy", "test"].includes(task)) { url.searchParams.set("page", "ingame"); url.searchParams.set("component", ["report", "deepReport", "combat"].includes(task) ? "messages" : task === "return" ? "fleetdispatch" : "movement"); url.searchParams.set("cp", scan.home.id); }
      url.searchParams.set("sephiDiscovery", token);
      this.saveDiscovery({ ...scan, worker: { token, task, startedAt: Date.now(), pending: false } });
      const nextFrame = document.createElement("iframe"); nextFrame.id = "sephi-discovery-worker"; nextFrame.hidden = true; nextFrame.dataset.sephiWorker = token; nextFrame.title = "Découverte de frigos inactifs"; nextFrame.src = url.href; document.body.append(nextFrame);
    }
    addTarget(coords, name) {
      const id = targetId(coords);
      if (this.data.targets.some((t) => t.id === id)) {
        this.message("Cette cible est d\xE9j\xE0 suivie.");
        return;
      }
      this.save({ ...this.data, targets: [...this.data.targets, createTarget(coords, name, this.data.settings.defaultProbes)] });
      this.message("Frigo ajout\xE9.");
    }
    removeTarget(id) {
      this.save({ ...this.data, targets: this.data.targets.filter((t) => t.id !== id) });
      this.message("Frigo supprim\xE9.");
    }
    ingest(report) {
      const id = targetId(report.coords), existing = this.data.targets.find((t) => t.id === id);
      const target = recordReport(existing ?? createTarget(report.coords, report.name, this.data.settings.defaultProbes), report);
      this.save({ ...this.data, targets: [...this.data.targets.filter((t) => t.id !== id), target] });
      this.message("Rapport enregistr\xE9 dans le frigo.");
    }
    targets() {
      const card = this.card(`${this.data.targets.length} frigos suivis`);
      const toolbar = element("div");
      toolbar.className = "toolbar";
      const filter = this.field(toolbar, "Filtrer nom, coordonn\xE9es, notes, tags", "search", this.filter, "search");
      const sort = this.select(toolbar, "Trier", "sort", [["coords", "Coordonn\xE9es"], ["loot", "Butin d\xE9croissant"], ["recent", "Dernier scan"]], this.sort);
      const tableHost = element("div");
      tableHost.className = "table";
      const draw = () => {
        tableHost.replaceChildren();
        const table = element("table"), head = element("thead"), tr = element("tr");
        table.className = "targets";
        for (const label of ["Cible", "Butin estim\xE9", "Dernier scan", "\xC9tat", "Actions"]) tr.append(element("th", label));
        const labelled = (td, label) => { td.dataset.label = label; return td; };
        head.append(tr);
        table.append(head);
        const body = element("tbody");
        const loot = (t) => t.lastReport ? calculateLoot(t.lastReport.resources, t.lastReport.lootFactor ?? this.data.settings.lootFactor) : 0;
        const targets = this.data.targets.filter((t) => `${t.name} ${formatCoords(t.coords)} ${t.notes} ${t.tags.join(" ")}`.toLowerCase().includes(this.filter.toLowerCase()));
        const failures = this.campaignFailureHistory();
        targets.sort((a, b) => this.sort === "loot" ? loot(b) - loot(a) : this.sort === "recent" ? (b.lastReport?.observedAt ?? 0) - (a.lastReport?.observedAt ?? 0) : a.coords.galaxy - b.coords.galaxy || a.coords.system - b.coords.system || a.coords.position - b.coords.position || a.coords.type.localeCompare(b.coords.type));
        for (const target2 of targets) {
          const row = element("tr"), name = element("td");
          name.append(element("strong", target2.name), element("br"), element("small", formatCoords(target2.coords)));
          const failed = failures.filter((entry) => entry.targetId === target2.id);
          if (failed.length) {
            const last = failed[failed.length - 1], detail = element("small", `${failed.length} échec(s) · ${new Date(last.at).toLocaleString("fr-FR")}`);
            detail.title = last.message;
            name.append(element("br"), detail);
          }
          row.append(name);
          const amount = element("td", target2.lastReport ? fmt(loot(target2)) : "\u2014");
          if (target2.lastReport) amount.append(element("br"), element("small", `${calculateRequiredCargo(loot(target2), this.data.settings.smallCargo)} PT \xB7 ${calculateRequiredCargo(loot(target2), this.data.settings.largeCargo)} GT`));
          row.append(labelled(amount, "Butin estim\xE9"), labelled(element("td", target2.lastReport ? new Date(target2.lastReport.observedAt).toLocaleString("fr-FR") : "\u2014"), "Dernier scan"), labelled(element("td", targetStatus(target2)), "\xC9tat"));
          const cell = element("td"), actions = element("div"), links = element("div");
          cell.className = "actions";
          actions.className = "btns";
          links.className = "btns";
          cell.append(actions, links);
          actions.append(this.button("Modifier", () => {
            this.editing = target2.id;
            this.render();
          }), this.button(target2.enabled ? "D\xE9sactiver" : "Activer", () => this.save({ ...this.data, targets: this.data.targets.map((t) => t.id === target2.id ? { ...t, enabled: !t.enabled } : t) })), this.button("Supprimer", () => {
            if (window.confirm(`Supprimer ${target2.name} ${formatCoords(target2.coords)} ?`)) this.removeTarget(target2.id);
          }));
          if (this.context) {
            for (const [action, label] of [["galaxy", "Galaxie"], ["spy", `Sonder (${target2.probeCount})`], ["attack", "Pr\xE9parer attaque"]]) {
              const a = element("a", label);
              a.href = action === "spy" ? fleetURL(target2.coords, "spy", this.context, 210, target2.probeCount) : actionURL(target2.coords, action, this.context.planetId);
              a.className = "button";
              a.title = "Ouvre la page flotte ; s\xE9lection et envoi \xE0 confirmer dans OGame.";
              links.append(a);
            }
          }
          if (this.context && target2.lastReport && loot(target2) > 0) {
            for (const [ship, label, capacity] of [[202, "Raid PT", this.data.settings.smallCargo], [203, "Raid GT", this.data.settings.largeCargo]]) {
              const a = element("a", label);
              a.className = "button";
              a.href = fleetURL(target2.coords, "attack", this.context, ship, calculateRequiredCargo(loot(target2), capacity), loot(target2));
              links.append(a);
            }
          }
          if (target2.history.length) {
            const details = element("details");
            details.append(element("summary", `Historique (${target2.history.length})`));
            for (const r of [...target2.history].reverse()) details.append(element("p", `${new Date(r.observedAt).toLocaleString("fr-FR")} \xB7 M ${fmt(r.resources.metal)} / C ${fmt(r.resources.crystal)} / D ${fmt(r.resources.deuterium)} \xB7 flotte ${r.fleet ?? "?"} \xB7 d\xE9fense ${r.defense ?? "?"}`));
            cell.append(details);
          }
          if (!links.childElementCount) links.remove();
          row.append(cell);
          body.append(row);
        }
        table.append(body);
        tableHost.append(table);
        if (!targets.length) tableHost.append(element("p", "Aucune cible. Ajoutez un frigo ou importez une sauvegarde."));
      };
      filter.addEventListener("input", () => {
        this.filter = filter.value;
        draw();
      });
      sort.addEventListener("change", () => {
        this.sort = sort.value;
        draw();
      });
      card.append(toolbar, tableHost);
      draw();
      const target = this.data.targets.find((t) => t.id === this.editing), formCard = this.card(target ? "Modifier le frigo" : "Ajouter un frigo");
      const form = element("form"), grid = element("div");
      grid.className = "grid";
      this.field(grid, "Nom", "name", target?.name ?? "").required = true;
      this.field(grid, "Coordonn\xE9es", "coords", target ? formatCoords(target.coords) : "").placeholder = "[2:143:7]";
      this.select(grid, "Type", "type", [["planet", "Plan\xE8te"], ["moon", "Lune"]], target?.coords.type ?? "planet");
      const probes = this.field(grid, "Sondes", "probes", String(target?.probeCount ?? this.data.settings.defaultProbes), "number");
      probes.min = "1";
      probes.max = "1000000";
      this.field(grid, "Flotte personnalis\xE9e (m\xE9mo)", "customFleet", target?.customFleet ?? "");
      this.field(grid, "Flotte de r\xE9f\xE9rence (valeur du rapport)", "knownFleet", target?.knownFleet?.toString() ?? "", "number").min = "0";
      this.field(grid, "D\xE9fense de r\xE9f\xE9rence (valeur du rapport)", "knownDefense", target?.knownDefense?.toString() ?? "", "number").min = "0";
      this.field(grid, "Notes", "notes", target?.notes ?? "");
      this.field(grid, "Tags (s\xE9par\xE9s par des virgules)", "tags", target?.tags.join(", ") ?? "");
      this.select(grid, "Ignorer", "ignore", [["no", "Non"], ["yes", "Oui"]], target?.ignore ? "yes" : "no");
      const submit = element("button", "Enregistrer");
      submit.type = "submit";
      form.append(grid, submit);
      if (target) form.append(this.button("Annuler", () => {
        this.editing = void 0;
        this.render();
      }));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this.guarded(() => {
          const f = new FormData(form), get = (name) => String(f.get(name) ?? "");
          const c = parseCoords(get("coords"), get("type"));
          c.type = get("type");
          if (this.data.targets.some((t) => t.id === targetId(c) && t.id !== target?.id)) throw new Error("Cette cible existe d\xE9j\xE0.");
          if (target && target.id !== targetId(c) && target.history.length) throw new Error("Cr\xE9ez une nouvelle cible pour changer les coordonn\xE9es d\u2019un frigo avec historique.");
          const updated = {
            ...target ?? createTarget(c, get("name")),
            id: targetId(c),
            coords: c,
            name: get("name"),
            probeCount: Number(get("probes")),
            notes: get("notes"),
            customFleet: get("customFleet"),
            tags: get("tags").split(",").map((s) => s.trim()).filter(Boolean),
            ignore: get("ignore") === "yes",
            updatedAt: Date.now(),
            knownFleet: get("knownFleet") === "" ? void 0 : Number(get("knownFleet")),
            knownDefense: get("knownDefense") === "" ? void 0 : Number(get("knownDefense"))
          };
          this.save({ ...this.data, targets: [...this.data.targets.filter((t) => t.id !== target?.id), updated] });
          this.editing = void 0;
          this.render();
          this.message("Frigo enregistr\xE9.");
        });
      });
      formCard.append(form);
    }
    showReport(parent, report) {
      const loot = calculateLoot(report.resources, report.lootFactor ?? this.data.settings.lootFactor);
      parent.append(element("h2", `${report.name} ${formatCoords(report.coords)}`), element("p", `M\xE9tal ${fmt(report.resources.metal)} \xB7 Cristal ${fmt(report.resources.crystal)} \xB7 Deut\xE9rium ${fmt(report.resources.deuterium)}`));
      const summary = element("div", `Butin estim\xE9 ${fmt(loot)} \xB7 ${calculateRequiredCargo(loot, this.data.settings.smallCargo)} PT \xB7 ${calculateRequiredCargo(loot, this.data.settings.largeCargo)} GT`);
      summary.className = "summary";
      parent.append(summary);
      const warning = attackReportWarning(report);
      if (warning) {
        const alert = element("p", warning);
        alert.className = "report-warning";
        parent.append(alert);
      }
      parent.append(element("p", `Flotte : ${report.fleet ?? "inconnue"} \xB7 D\xE9fense : ${report.defense ?? "inconnue"} \xB7 Pillage : ${(report.lootFactor ?? this.data.settings.lootFactor) * 100} %`), this.button("Enregistrer dans les frigos", () => this.ingest(report)));
    }
    reports() {
      const card = this.card("Analyser un rapport d\u2019espionnage");
      card.append(element("p", "Collez le HTML du rapport d\xE9taill\xE9. Vous pouvez aussi saisir les valeurs manuellement ci-dessous. Le HTML reste inerte."));
      const area = element("textarea");
      area.setAttribute("aria-label", "HTML du rapport");
      area.placeholder = '<li class="msg">\u2026</li>';
      const result = element("div");
      card.append(area, this.button("Analyser", () => {
        const report = parseReportHTML(area.value);
        result.replaceChildren();
        this.showReport(result, report);
      }), result);
      const manual = this.card("Saisie manuelle / calculateur local"), form = element("form"), grid = element("div");
      grid.className = "grid";
      this.field(grid, "Nom", "name", "").required = true;
      this.field(grid, "Coordonn\xE9es", "coords", "").placeholder = "[2:143:7]";
      this.select(grid, "Type", "type", [["planet", "Plan\xE8te"], ["moon", "Lune"]], "planet");
      for (const [key, label] of [["metal", "M\xE9tal"], ["crystal", "Cristal"], ["deuterium", "Deut\xE9rium"], ["fleet", "Flotte (vide = inconnue)"], ["defense", "D\xE9fense (vide = inconnue)"]]) {
        const i = this.field(grid, label, key, "", "number");
        i.min = "0";
        if (["metal", "crystal", "deuterium"].includes(key)) i.required = true;
      }
      const submit = element("button", "Calculer");
      submit.type = "submit";
      const manualResult = element("div");
      form.append(grid, submit);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this.guarded(() => {
          const f = new FormData(form), get = (key) => String(f.get(key) ?? "");
          const coords = parseCoords(get("coords"), get("type"));
          coords.type = get("type");
          const report = {
            name: get("name"),
            coords,
            resources: { metal: Number(get("metal")), crystal: Number(get("crystal")), deuterium: Number(get("deuterium")) },
            fleet: get("fleet") === "" ? void 0 : Number(get("fleet")),
            defense: get("defense") === "" ? void 0 : Number(get("defense")),
            observedAt: Date.now()
          };
          manualResult.replaceChildren();
          this.showReport(manualResult, report);
        });
      });
      manual.append(form, manualResult);
    }
    settings() {
      this.ejectSettings();
      const card = this.card("Capacit\xE9s et calculs");
      card.append(element("p", "Indiquez les capacit\xE9s effectives affich\xE9es dans votre jeu (technologies, classe et formes de vie incluses). Les valeurs initiales sont des valeurs de base \xE0 ajuster. Le calcul estime le volume total : r\xE9partition du butin et carburant peuvent n\xE9cessiter une marge."));
      const form = element("form"), grid = element("div");
      grid.className = "grid";
      const s = this.data.settings;
      this.select(grid, "Déclenchement des auto-attaques", "autoAttackMode", [["interval", "Intervalle entre les cycles"], ["slots", "Slots libres + joueur inactif"]], s.autoAttackMode ?? "interval");
      this.field(grid, "Slots utilisables libres nécessaires (hors réserve)", "freeSlotsTrigger", String(s.freeSlotsTrigger ?? 3), "number").min = "1";
      this.field(grid, "Inactivité avant lancement par slots (secondes)", "attackIdleSeconds", String(s.attackIdleSeconds ?? 60), "number").min = "15";
      const homes = ownedPlanets().filter((planet) => planet.coords.type !== "moon");
      this.select(grid, "Planète mère pour les campagnes", "homePlanetId", [["", "Première planète de la liste OGame"], ...homes.map((planet) => [planet.id, planetLabel(planet)])], s.homePlanetId ?? "");
      this.field(grid, "Maximum de vagues par frigo et par cycle", "maxAttackWaves", String(s.maxAttackWaves ?? 10), "number").min = "1";
      grid.append(element("small", "Le mode slots surveille la planète mère toutes les 15 secondes pendant votre absence. La rotation des planètes attend deux minutes sans activité."));
      this.field(grid, "Capacit\xE9 effective PT", "smallCargo", String(s.smallCargo), "number").min = "1";
      this.field(grid, "Capacit\xE9 effective GT", "largeCargo", String(s.largeCargo), "number").min = "1";
      this.field(grid, "Butin minimum pour attaquer", "minimumLoot", String(s.minimumLoot), "number").min = "0";
      const interval = this.field(grid, "Intervalle entre les cycles d’auto-attaques (minutes)", "autoAttackIntervalMinutes", String(s.autoAttackIntervalMinutes), "number");
      interval.min = "1";
      interval.max = "10080";
      const waitTimeout = this.field(grid, "Attente maximale des slots / vaisseaux (minutes)", "fleetWaitTimeoutMinutes", String(s.fleetWaitTimeoutMinutes ?? defaults.fleetWaitTimeoutMinutes), "number");
      waitTimeout.min = "1";
      waitTimeout.max = "120";
      const reserved = this.field(grid, "Slots de flotte à garder libres pour les auto-attaques et sondages", "reservedFleetSlots", String(s.reservedFleetSlots ?? 1), "number");
      reserved.min = "0";
      reserved.max = "100";
      const factor = this.field(grid, "Pillage par d\xE9faut (%)", "lootFactor", String(s.lootFactor * 100), "number");
      factor.min = "0";
      factor.max = "100";
      factor.step = "0.1";
      this.field(grid, "Sondes par d\xE9faut", "defaultProbes", String(s.defaultProbes), "number").min = "1";
      const submit = element("button", "Enregistrer les param\xE8tres");
      submit.type = "submit";
      form.append(grid, submit);
      card.append(form);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this.guarded(() => {
          const f = new FormData(form);
          const settings = validateSettings({ ...s, autoAttackMode: String(f.get("autoAttackMode")), freeSlotsTrigger: Number(f.get("freeSlotsTrigger")), attackIdleSeconds: Number(f.get("attackIdleSeconds")), homePlanetId: String(f.get("homePlanetId")), maxAttackWaves: Number(f.get("maxAttackWaves")), smallCargo: Number(f.get("smallCargo")), largeCargo: Number(f.get("largeCargo")), lootFactor: Number(f.get("lootFactor")) / 100, defaultProbes: Number(f.get("defaultProbes")), minimumLoot: Number(f.get("minimumLoot")), autoAttackIntervalMinutes: Number(f.get("autoAttackIntervalMinutes")), fleetWaitTimeoutMinutes: Number(f.get("fleetWaitTimeoutMinutes")), reservedFleetSlots: Number(f.get("reservedFleetSlots")) });
          this.save({ ...this.data, settings });
          if (this.campaign) {
            if (this.campaignTimer) clearTimeout(this.campaignTimer);
            this.campaignTimer = void 0;
            this.persistCampaign({ ...this.campaign, triggerMode: settings.autoAttackMode });
            this.continueAutoAttacks();
          }
          this.message("Param\xE8tres enregistr\xE9s.");
        });
      });
    }
    ejectSettings() {
      if (!this.context) return;
      const card = this.card("Auto-éject · planète / lune courante"), id = this.context.planetId;
      const config = this.data.settings.autoEject?.[id];
      card.append(element("p", "Évacuation automatique 5 minutes avant une attaque identifiée, à 10 % de vitesse. Tous les vaisseaux mobiles et le maximum de ressources transportables sont sélectionnés. Le carburant et la capacité de soute limitent les ressources évacuées. Un transport qui reviendrait avant l’impact est refusé. Le navigateur doit rester ouvert et connecté."));
      const enabled = this.select(card, "Auto-éject", "ejectEnabled", [["off", "Désactivé"], ["on", "Activé"]], config?.enabled ? "on" : "off");
      const coords = this.field(card, "Destination d’évacuation", "ejectCoords", config ? formatCoords(config.coords) : "");
      coords.placeholder = "[1:234:5]";
      const type = this.select(card, "Destination", "ejectType", [["planet", "Planète"], ["moon", "Lune"]], config?.coords.type ?? "planet");
      const mission = this.select(card, "Mission", "ejectMission", [["3", "Transport"], ["4", "Stationnement (chez vous)"]], String(config?.mission ?? 3));
      card.append(this.button("Enregistrer l’auto-éject de cette planète", () => {
        const configs = { ...this.data.settings.autoEject };
        if (enabled.value === "off" && !coords.value.trim()) delete configs[id];
        else {
          const destination = parseCoords(coords.value, type.value);
          destination.type = type.value;
          const own = ownedPlanets();
          if (own.some((planet) => planet.id === id && targetId(planet.coords) === targetId(destination))) throw new Error("La destination doit différer de la planète de départ.");
          if (mission.value === "4" && !own.some((planet) => targetId(planet.coords) === targetId(destination))) throw new Error("Le stationnement nécessite une destination vous appartenant.");
          configs[id] = { enabled: enabled.value === "on", coords: destination, mission: Number(mission.value) };
        }
        this.save({ ...this.data, settings: validateSettings({ ...this.data.settings, autoEject: configs }) });
        this.message("Auto-éject enregistré pour cette planète / lune.");
      }));
      const job = readJSON(`${this.store.key}:eject-job`);
      if (job.message) card.append(element("p", job.message));
    }
    async monitorAutoEject() {
      if (this.ejectCheckBusy || Date.now() - (this.ejectLastCheck ?? 0) < 10000) return;
      if (!Object.values(this.store.load().settings.autoEject ?? {}).some((config) => config.enabled)) return;
      this.ejectLastCheck = Date.now();
      this.ejectCheckBusy = true;
      try {
        const events = await fetchAttackEvents(), attacks = incomingAttacks(events, ownedPlanets());
        const check = () => {
          const current = readJSON(`${this.store.key}:eject-job`), history = readJSON(`${this.store.key}:eject-history`);
          if (current.token && ["confirmed", "pending"].includes(current.status)) {
            history[current.attack.id] = { status: current.status, planetId: current.planetId, arrival: current.attack.arrival };
            localStorage.setItem(`${this.store.key}:eject-history`, JSON.stringify(history));
          }
          const frame = document.getElementById("sephi-eject-worker");
          if (current.status === "pending" && current.attack.arrival > Date.now() || current.status === "preparing" && Date.now() - current.startedAt < 45000) return;
          const settings = this.store.load().settings;
          const attack = attacks.find((value) => value.arrival - Date.now() <= 300000 && settings.autoEject[value.planetId]?.enabled && !["confirmed", "pending"].includes(history[value.id]?.status));
          if (!attack) return;
          const build = document.getElementById("sephi-construction-worker");
          if (this.campaign?.pending || build && this.constructionState(build.dataset.sephiPlanet).busy) return;
          if (this.campaign?.status === "running" && this.campaign.phase !== "wait") this.abandonAutoAttackRound("Attaque entrante · priorité à l’évacuation.");
          if (attack.planetId !== this.context.planetId) {
            showPreparation(`Attaque imminente sur ${formatCoords(attack.coords)} · changement de planète pour l’évacuation.`);
            const target = new URL("/game/index.php", location.href);
            target.searchParams.set("page", "ingame");
            target.searchParams.set("component", "overview");
            target.searchParams.set("cp", attack.planetId);
            location.href = target.href;
            return;
          }
          build?.remove();
          frame?.remove();
          const config = settings.autoEject[attack.planetId], token = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
          localStorage.setItem(`${this.store.key}:eject-job`, JSON.stringify({ token, owner: this.campaignTabId, status: "preparing", attack, planetId: attack.planetId, startedAt: Date.now(), message: "Attaque entrante · préparation de l’évacuation." }));
          showPreparation(`Attaque sur ${formatCoords(attack.coords)} dans ${formatRemaining(attack.arrival - Date.now())}. Évacuation vers ${formatCoords(config.coords)} en cours.`);
          const worker = document.createElement("iframe");
          worker.id = "sephi-eject-worker";
          worker.dataset.sephiWorker = token;
          worker.hidden = true;
          worker.title = "Auto-éject SephiOGame";
          const url = new URL(actionURL(config.coords, "attack", attack.planetId));
          url.searchParams.set("mission", String(config.mission));
          url.searchParams.set("sephiEjectWorker", token);
          worker.src = url.href;
          document.body.append(worker);
        };
        if (navigator.locks?.request) await navigator.locks.request(`${this.store.key}:eject-claim`, { ifAvailable: true }, (lock) => { if (lock) check(); });
        else this.message("Auto-éject indisponible : verrouillage entre onglets non pris en charge.");
        const job = readJSON(`${this.store.key}:eject-job`);
        if (job.message && job.status !== "preparing") showPreparation(job.message);
      } catch (error) {
        campaignLog("Surveillance auto-éject indisponible", { error: String(error) });
        showPreparation(`Surveillance auto-éject indisponible : ${String(error)}`);
      } finally { this.ejectCheckBusy = false; }
    }
    campaignRows() {
      const campaign = this.campaign;
      const ids = campaign?.targetIds ?? this.data.targets.filter((target) => target.enabled && !target.ignore).map((target) => target.id);
      const currentId = campaign?.phase === "attack" ? campaign.attackIds?.[campaign.attackIndex] : campaign?.targetIds[campaign.index];
      return ids.map((id) => {
        const target = this.data.targets.find((item) => item.id === id);
        const report = campaign?.reports?.[id];
        const loot = report ? calculateLoot(report.resources, report.lootFactor ?? this.data.settings.lootFactor) : undefined;
        const ships = campaign?.attackDispatches?.[id];
        const waves = campaign?.attackCounts?.[id] ?? 0;
        let status = "À venir";
        if (campaign?.sentAt?.[id]) status = "Sondes envoyées";
        if (campaign?.phase === "reports" && campaign.sentAt?.[id]) status = report ? "Rapport lu" : "Lecture du rapport";
        if (report && campaign?.phase !== "reports") status = "Rapport lu · attaque à venir";
        if (report && ["attack", "wait"].includes(campaign?.phase) && !campaign.attackIds?.includes(id)) status = "Butin sous le seuil · aucune attaque";
        if (ships?.length) status = ships.map(([ship, count]) => `${fmt(count)} ${Number(ship) === 202 ? "PT" : "GT"}`).join(" + ") + " envoyés";
        // Older campaigns do not contain the confirmed ship composition.
        else if (campaign?.attackIds?.indexOf(id) >= 0 && campaign.attackIds.indexOf(id) < campaign.attackIndex) status = "Attaque envoyée";
        if (campaign?.deferredIds?.includes(id)) status = campaign.phase === "wait" ? "Reporté au prochain cycle" : "Non traité · cycle arrêté";
        if (waves > 1) status = `${waves} vagues envoyées`;
        if (waves && campaign?.phase === "attack" && campaign.attackIds.slice(campaign.attackIndex).includes(id)) status += ` · vague suivante estimée à ${fmt(plannedAttackLoot(campaign, id, this.data.settings))}`;
        if (waves && campaign?.deferredIds?.includes(id)) status += " · suite reportée au prochain cycle";
        if (campaign?.waiting?.targetId === id && campaign.status === "running") status = campaign.waiting.message;
        if (campaign?.retry?.targetId === id) status = `Reprise ${Math.min(campaign.retry.attempt, 3)}/3 · ${campaign.retry.message}`;
        if (campaign?.skippedTargets?.[id]) status = campaign.skippedTargets[id].message;
        if (campaign?.pending?.targetId === id) status = campaign.pending.action === "spy" ? "Envoi des sondes en cours" : "Envoi des transporteurs en cours";
        const warning = report ? attackReportWarning(report) : "";
        if (warning) status = ships?.length || waves || campaign?.pending?.targetId === id ? `${status} · ${warning}` : warning;
        return { id, name: target?.name ?? report?.name ?? "Frigo supprimé", coords: target ? formatCoords(target.coords) : report ? formatCoords(report.coords) : id, loot, fleet: report?.fleet, defense: report?.defense, warning, status };
      });
    }
    campaignTable(parent) {
      const host = element("div");
      host.className = "table";
      const table = element("table"), head = element("thead"), heading = element("tr"), body = element("tbody");
      for (const title of ["Nom du frigo", "Coordonnées", "Butin", "Flotte", "Défenses", "Statut"]) heading.append(element("th", title));
      head.append(heading);
      for (const item of this.campaignRows()) {
        const row = element("tr");
        row.dataset.targetId = item.id;
        if (item.warning) row.className = "report-warning";
        row.append(element("td", item.name), element("td", item.coords), element("td", item.loot === undefined ? "" : fmt(item.loot)), element("td", item.fleet === undefined ? "?" : fmt(item.fleet)), element("td", item.defense === undefined ? "?" : fmt(item.defense)), element("td", item.status));
        body.append(row);
      }
      table.append(head, body);
      host.append(table);
      parent.append(host);
    }
    autoAttacks() {
      const targets = this.data.targets.filter((target) => target.enabled && !target.ignore);
      const card = this.card("Campagne de frigos");
      if (this.data.settings.autoAttackMode === "slots") card.append(element("p", `Surveillance automatique active : lancement avec au moins ${this.data.settings.freeSlotsTrigger} slots utilisables libres après ${this.data.settings.attackIdleSeconds} secondes sans clic ni saisie. Départ depuis la planète mère configurée dans Paramètres. La réserve de slots est conservée.`));
      const failures = this.campaignFailureHistory();
      if (failures.length) {
        const history = element("details");
        history.append(element("summary", `Échecs et reprises mémorisés (${failures.length})`));
        for (const failure of failures.slice(-20).reverse()) history.append(element("p", `${new Date(failure.at).toLocaleString("fr-FR")} · ${failure.name}${failure.playerName ? ` · joueur ${failure.playerName} (${failure.playerId})` : ""} ${failure.coords ? formatCoords(failure.coords) : ""} · ${failure.phase} · ${failure.message}`));
        card.append(history);
      }
      card.append(element("p", "Les opérations s’exécutent en arrière-plan. Cette page reste sur le tableau de suivi."));
      card.append(element("p", `La campagne ignore les frigos déjà visés par une attaque à l’aller, sonde les autres, puis classe chaque vague par butin estimé restant (seuil ${fmt(this.data.settings.minimumLoot)}). Seuls les rapports indiquant explicitement zéro flotte et zéro défense autorisent une attaque. Plusieurs vagues peuvent viser un même frigo, dans la limite configurée. Les petits transporteurs sont prioritaires. Si les slots sont pleins avec des sondes encore en vol, une nouvelle vérification a lieu après 30 secondes. Les envois sont automatiques.`));
      if (!this.context) {
        card.append(element("p", "Ouvrez ce panneau depuis une page OGame pour lancer une campagne."));
        return;
      }
      if (this.campaign) {
        const campaign = this.campaign;
        const phase = { baseline: "Référence des messages", spy: "Espionnage", reports: "Lecture des rapports", attack: "Attaques", wait: "Attente du prochain cycle" }[campaign.phase] ?? campaign.phase;
        const progress = campaign.phase === "wait" ? this.data.settings.autoAttackMode === "slots" ? "selon slots libres et inactivité" : new Date(campaign.nextRunAt).toLocaleString("fr-FR") : campaign.phase === "attack" ? `${campaign.attackIndex ?? 0}/${campaign.attackIds?.length ?? 0}` : `${campaign.index ?? 0}/${campaign.targetIds.length}`;
        card.append(element("p", `État : ${campaign.phase === "wait" ? "Attente du prochain cycle" : campaign.status === "completed" ? "Terminée" : "En cours"} · ${phase} · ${progress}`));
        if (campaign.message) card.append(element("p", campaign.message));
        if (campaign.slotSnapshot) {
          const snapshot = campaign.slotSnapshot;
          card.append(element("small", `Mouvements observés : ${snapshot.observedCount}/${snapshot.expectedCount ?? "?"} · espionnage ${snapshot.espionage} · attaques ${snapshot.attacks}${snapshot.complete ? "" : " · identification incomplète"}`));
        }
        this.campaignTable(card);
        if (campaign.status === "running" && campaign.runnerId === this.campaignTabId && campaign.phase !== "wait") card.append(this.button("Abandonner ce cycle", () => this.abandonAutoAttackRound()));
        else if (campaign.status === "running" && campaign.runnerId !== this.campaignTabId) card.append(this.button("Suivre dans cet onglet", () => this.takeOverAutoAttacks()));
        card.append(this.button("Nouvelle campagne", () => {
          if (window.confirm("Effacer la progression actuelle et préparer une nouvelle campagne ?")) {
            this.persistCampaign(null);
            this.render();
          }
        }));
        return;
      }
      card.append(element("p", `${targets.length} frigos actifs seront traités. Les cibles ignorées ou désactivées sont exclues.`));
      this.campaignTable(card);
      card.append(this.button("Démarrer la campagne", () => this.startAutoAttacks()));
    }
    async startAutoAttacks(automatic = false) {
      if (this.discoveryActive()) throw new Error("Un scan de découverte est en cours. Mettez-le en pause avant de lancer une campagne.");
      if (!this.context) throw new Error("La campagne nécessite une page OGame.");
      if (this.campaignBusy) return;
      const targets = this.data.targets.filter((target) => target.enabled && !target.ignore);
      if (!targets.length) throw new Error("Aucun frigo actif à sonder.");
      const repeatText = this.data.settings.autoAttackMode === "slots" ? " Les cycles suivants attendront les slots libres et votre inactivité." : ` Elle recommencera toutes les ${this.data.settings.autoAttackIntervalMinutes} minutes tant que ce navigateur reste ouvert.`;
      if (!automatic && !window.confirm(`Démarrer une campagne pour ${targets.length} frigos ? Des sondes puis des attaques seront envoyées automatiquement depuis la planète mère.${repeatText}`)) return;
      this.campaignBusy = true;
      try {
        const campaign = {
          version: 1,
          playerId: this.context.playerId,
          runnerId: this.campaignTabId,
          sourcePlanetId: this.homePlanetId(),
          triggerMode: this.data.settings.autoAttackMode ?? "interval",
          repeatMinutes: this.data.settings.autoAttackIntervalMinutes,
          status: "running",
          phase: "spy",
          targetIds: targets.map((target) => target.id),
          index: 0,
          baselineIds: [],
          sentAt: {},
          reports: {},
          attackDispatches: {},
          attackCounts: {},
          remainingResourceTotals: {},
          waiting: null,
          deferredIds: [],
          skippedTargets: {},
          reportsLastProgressAt: null,
          attackIds: [],
          attackIndex: 0,
          attackSlotRetries: 0,
          pending: null,
          lastDispatch: null,
          startedAt: Date.now(),
          message: "Début de l’espionnage des frigos."
        };
        this.persistCampaign(campaign);
        if (this.panel) this.open("Auto-attaques");
        this.continueAutoAttacks();
      } finally {
        this.campaignBusy = false;
      }
    }
    abandonAutoAttackRound(message = "Cycle abandonné.") {
      if (!this.campaign) return;
      campaignLog("Cycle abandonné; attente du prochain lancement", { message, phase: this.campaign.phase, index: this.campaign.index, attackIndex: this.campaign.attackIndex, pending: this.campaign.pending?.action ?? null });
      sessionStorage.removeItem(this.campaignContinuationKey);
      if (this.campaignTimer) {
        clearTimeout(this.campaignTimer);
        this.campaignTimer = void 0;
      }
      const current = this.campaign;
      const deferredIds = current.phase === "attack" ? current.attackIds.slice(current.attackIndex) : current.targetIds.filter((id) => !current.attackDispatches?.[id]?.length);
      this.persistCampaign({ ...current, uncertainDispatch: current.pending ?? current.uncertainDispatch, pending: null, waiting: null, deferredIds });
      this.finishAutoAttackRound(message);
      this.message(message);
    }
    resumeAutoAttacks() {
      if (!this.campaign || this.campaign.status === "completed") return;
      if (this.campaign.pending) throw new Error("Un envoi est en cours ou son résultat est incertain. Vérifiez les mouvements de flotte avant de reprendre.");
      this.persistCampaign({ ...this.campaign, runnerId: this.campaignTabId, status: "running", ...(this.campaign.phase === "reports" ? { reportsLastProgressAt: Date.now() } : {}), message: "Campagne reprise." });
      this.continueAutoAttacks();
    }
    takeOverAutoAttacks() {
      if (!this.campaign || this.campaign.status !== "running") return this.resumeAutoAttacks();
      if (this.campaign.pending) throw new Error("Un envoi est en cours ou son résultat est incertain. Vérifiez les mouvements avant de reprendre dans cet onglet.");
      this.persistCampaign({ ...this.campaign, runnerId: this.campaignTabId, message: "Campagne reprise dans cet onglet." });
      this.continueAutoAttacks();
    }
    campaignFailureHistory() {
      return readJSON(`${this.store?.key ?? this.campaignKey ?? "sephiogame"}:failures`, []);
    }
    recordCampaignFailure(message, extra = {}) {
      const campaign = this.campaign;
      const id = Object.hasOwn(extra, "targetId") ? extra.targetId : campaign?.phase === "attack" ? campaign.attackIds[campaign.attackIndex] : campaign?.targetIds[campaign.index];
      const target = this.data.targets.find((item) => item.id === id);
      const entry = { at: Date.now(), phase: campaign?.phase ?? "unknown", targetId: id ?? null, name: target?.name ?? id ?? "Lecture des rapports", coords: target?.coords ?? null, message, ...extra };
      const history = [...this.campaignFailureHistory(), entry].slice(-300);
      localStorage.setItem(`${this.store?.key ?? this.campaignKey ?? "sephiogame"}:failures`, JSON.stringify(history));
      campaignLog("Échec de campagne mémorisé", entry);
      return entry;
    }
    discardUnavailableFuelTarget() {
      const campaign = this.campaign;
      if (!campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending || !["spy", "attack"].includes(campaign.phase)) return;
      const id = campaign.phase === "attack" ? campaign.attackIds[campaign.attackIndex] : campaign.targetIds[campaign.index];
      if (!id) return;
      this.recordCampaignFailure("Frigo supprimé selon la règle : calcul du carburant indisponible.", { targetId: id, deleted: true, deletionPolicy: "unavailable-consumption" });
      if (this.store) this.data = this.store.load();
      this.removeTarget(id);
      this.skipAutoAttackTarget("Frigo supprimé · calcul du carburant indisponible.");
    }
    purgeUnavailableFuelTargets() {
      // Apply the same user-requested rule to failures saved by older versions.
      const migrationKey = `${this.store.key}:fuel-rule-history-migrated`;
      if (localStorage.getItem(migrationKey) === "done") return;
      const failures = this.campaignFailureHistory(), latest = this.store.load();
      const affected = failures.filter((entry) => /^(?:Calcul du carburant indisponible\.|Cible écartée : calcul du carburant indisponible)/i.test(entry.message ?? ""));
      const deferred = affected.some((entry) => entry.targetId === this.campaign?.pending?.targetId);
      const ids = new Set(affected.filter((entry) => entry.targetId !== this.campaign?.pending?.targetId).map((entry) => entry.targetId));
      const removed = latest.targets.filter((target) => ids.has(target.id));
      if (!removed.length) { if (!deferred) localStorage.setItem(migrationKey, "done"); return; }
      for (const target of removed) this.recordCampaignFailure("Frigo supprimé selon la règle carburant : échec mémorisé dans une version précédente.", { targetId: target.id, name: target.name, coords: target.coords, deleted: true, deletionPolicy: "unavailable-consumption-history" });
      this.save({ ...latest, targets: latest.targets.filter((target) => !ids.has(target.id)) });
      if (this.campaign) {
        const skippedTargets = { ...this.campaign.skippedTargets };
        for (const target of removed) skippedTargets[target.id] = { phase: "spy", message: "Frigo supprimé · ancien échec de calcul du carburant.", at: Date.now() };
        this.persistCampaign({ ...this.campaign, retry: removed.some((target) => target.id === this.campaign.retry?.targetId) ? null : this.campaign.retry, waiting: removed.some((target) => target.id === this.campaign.waiting?.targetId) ? null : this.campaign.waiting, skippedTargets });
      }
      if (!deferred) localStorage.setItem(migrationKey, "done");
      this.message(`${removed.length} frigo(s) supprimé(s) à partir des échecs de calcul du carburant déjà mémorisés.`);
    }
    scheduleCampaignRetry(message, verifyTarget = false) {
      const campaign = this.campaign;
      if (!campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending) return;
      const id = campaign.phase === "attack" ? campaign.attackIds[campaign.attackIndex] : campaign.phase === "spy" ? campaign.targetIds[campaign.index] : null;
      const key = `${campaign.phase}:${id ?? "reports"}`, attempt = (campaign.retryCounts?.[key] ?? 0) + 1;
      const failure = this.recordCampaignFailure(message, { targetId: id, attempt });
      const delay = [15000, 30000, 60000][Math.min(attempt - 1, 2)];
      const retry = { key, targetId: id, attempt, at: Date.now() + delay, failureAt: failure.at, message, verifyTarget, exhausted: attempt > 3 && campaign.phase !== "reports" };
      this.persistCampaign({ ...campaign, retryCounts: { ...campaign.retryCounts, [key]: attempt }, retry, message: `${message} Reprise au même point dans ${delay / 1000} s (tentative ${attempt}).` });
      if (this.backgroundCoordinator) this.stopCampaignWorker();
      this.armCampaignRetry();
    }
    armCampaignRetry() {
      const retry = this.campaign?.retry;
      if (!retry || this.campaign.runnerId !== this.campaignTabId) return;
      if (this.campaignTimer) clearTimeout(this.campaignTimer);
      this.campaignTimer = setTimeout(() => {
        this.campaignTimer = void 0;
        void this.runCampaignRetry().catch((error) => this.scheduleCampaignRetry(String(error)));
      }, Math.max(0, retry.at - Date.now(), retry.claimedAt ? retry.claimedAt + 45000 - Date.now() : 0));
    }
    async runCampaignRetry() {
      const current = this.store ? readJSON(this.campaignKey, this.campaign) : this.campaign;
      if (!current?.retry || current.status !== "running" || current.runnerId !== this.campaignTabId || current.pending) return;
      if (current.retry.at > Date.now()) { this.campaign = current; this.armCampaignRetry(); return; }
      if (current.retry.claimedAt && Date.now() - current.retry.claimedAt < 45000) return;
      const retry = current.retry, claim = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      this.persistCampaign({ ...current, retry: { ...retry, claimedAt: Date.now(), claim } });
      const target = this.data.targets.find((item) => item.id === retry.targetId);
      let identity;
      const presence = target && (retry.verifyTarget || retry.exhausted) ? await verifyTargetPresence(target.coords, (value) => { identity = value; }) : "unknown";
      const latest = this.store ? readJSON(this.campaignKey, this.campaign) : this.campaign;
      if (latest?.retry?.claim !== claim || latest.runnerId !== this.campaignTabId || latest.pending || latest.status !== "running") return;
      if (identity) {
        const history = this.campaignFailureHistory().map((entry) => entry.targetId === retry.targetId && entry.at === retry.failureAt && entry.attempt === retry.attempt ? { ...entry, ...identity } : entry);
        localStorage.setItem(`${this.store?.key ?? this.campaignKey ?? "sephiogame"}:failures`, JSON.stringify(history));
      }
      this.persistCampaign({ ...latest, retry: null });
      if (presence === "missing" && target) {
        this.recordCampaignFailure("Frigo supprimé : absence confirmée par deux lectures de la galaxie.", { targetId: target.id, deleted: true });
        this.removeTarget(target.id);
        return this.skipAutoAttackTarget("Frigo supprimé · planète ou lune inexistante confirmée.");
      }
      if (retry.exhausted) return this.skipAutoAttackTarget(`Échec après 3 reprises · ${retry.message}`);
      if (this.backgroundCoordinator) this.stopCampaignWorker();
      this.continueAutoAttacks();
    }
    recoverUncertainDispatch(message) {
      const campaign = this.campaign;
      if (!campaign?.pending || campaign.runnerId !== this.campaignTabId) return;
      this.recordCampaignFailure(message, { targetId: campaign.pending.targetId, uncertain: true });
      this.persistCampaign({ ...campaign, uncertainDispatch: campaign.pending, pending: null, retry: null });
      this.skipAutoAttackTarget(`${message} Cible écartée pour éviter un double envoi.`);
    }
    continueAutoAttacks() {
      const campaign = this.campaign;
      if (!campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending) return;
      if ((this.discoveryStarting || this.discoveryActive()) && campaign.phase === "wait") {
        if (!this.campaignTimer) this.campaignTimer = setTimeout(() => { this.campaignTimer = void 0; this.continueAutoAttacks(); }, 15000);
        return;
      }
      if (campaign.constructionPauseUntil) {
        this.persistCampaign({ ...campaign, constructionPauseUntil: null });
        return this.continueAutoAttacks();
      }
      if (campaign.retry) {
        if (this.backgroundCoordinator) this.stopCampaignWorker();
        this.armCampaignRetry();
        return;
      }
      if (campaign.phase === "wait") {
        if (this.backgroundCoordinator) this.stopCampaignWorker();
        if (this.data.settings.autoAttackMode === "slots") return;
        const remaining = campaign.nextRunAt - Date.now();
        if (remaining <= 0) return void this.beginNextAutoAttackRound();
        if (!this.campaignTimer) this.campaignTimer = setTimeout(() => {
          this.campaignTimer = void 0;
          this.beginNextAutoAttackRound();
        }, remaining);
        return;
      }
      if (this.backgroundCoordinator) {
        this.open("Auto-attaques");
        this.startCampaignWorker();
        return;
      }
      if (campaign.phase === "baseline") {
        // Resume campaigns saved by older versions without reading Messages first.
        this.persistCampaign({ ...campaign, phase: "spy", message: "Début de l’espionnage des frigos." });
        return this.continueAutoAttacks();
      }
      if (campaign.phase === "reports") {
        if (this.context.page !== "messages") {
          campaignLog("Ouverture de Messages pour lire les rapports d’espionnage", { fromPage: this.context.page });
          this.markCampaignContinuation();
          location.href = messageListURL();
          return;
        }
        void this.collectAutoAttackReports();
        return;
      }
      const id = campaign.phase === "attack" ? campaign.attackIds[campaign.attackIndex] : campaign.targetIds[campaign.index];
      const target = this.data.targets.find((item) => item.id === id);
      if (!target) return this.skipAutoAttackTarget("Frigo supprimé · passage au suivant.");
      campaignLog("Navigation vers le dispatcher", { phase: campaign.phase, index: campaign.phase === "attack" ? campaign.attackIndex : campaign.index, total: campaign.phase === "attack" ? campaign.attackIds.length : campaign.targetIds.length, targetId: id, coords: formatCoords(target.coords) });
      this.persistCampaign({ ...campaign, waiting: null, message: `${campaign.phase === "spy" ? "Espionnage" : "Attaque"} en préparation : ${target.name} ${formatCoords(target.coords)}.` });
      this.markCampaignContinuation();
      const nextURL = campaignURL(target.coords, campaign.phase === "spy" ? "spy" : "attack", { ...this.context, planetId: campaign.sourcePlanetId ?? this.context.planetId }, campaign);
      if (nextURL === location.href) location.reload();
      else location.href = nextURL;
    }
    finishAutoAttackRound(message) {
      const campaign = this.campaign;
      if (!campaign) return;
      if (this.campaignTimer) clearTimeout(this.campaignTimer);
      this.campaignTimer = void 0;
      const repeatMinutes = campaign.repeatMinutes > 0 ? campaign.repeatMinutes : this.data.settings.autoAttackIntervalMinutes > 0 ? this.data.settings.autoAttackIntervalMinutes : defaults.autoAttackIntervalMinutes;
      const nextRunAt = Date.now() + repeatMinutes * 60000;
      this.persistCampaign({ ...campaign, retry: null, constructionPauseUntil: null, repeatMinutes, triggerMode: this.data.settings.autoAttackMode ?? "interval", slotNextRunAt: Date.now() + 60000, status: "running", phase: "wait", nextRunAt, pending: null, waiting: null, message: `${message} Prochain cycle le ${new Date(nextRunAt).toLocaleString("fr-FR")}.` });
      if (this.data.settings.autoAttackMode === "slots") this.persistCampaign({ ...this.campaign, message: `${message} Prochain cycle dès que les slots et l’inactivité le permettent.` });
      this.continueAutoAttacks();
    }
    stopBlockedAutoAttackRound(message) {
      const campaign = this.campaign;
      if (!campaign || campaign.status !== "running" || campaign.pending || campaign.runnerId !== this.campaignTabId) return;
      if (this.campaignTimer) clearTimeout(this.campaignTimer);
      this.campaignTimer = void 0;
      const deferredIds = campaign.phase === "attack" ? campaign.attackIds.slice(campaign.attackIndex) : campaign.targetIds.filter((id) => !campaign.attackDispatches?.[id]?.length);
      campaignLog("Cycle arrêté pour indisponibilité des flottes", { message, phase: campaign.phase, deferredIds });
      this.persistCampaign({ ...campaign, deferredIds, waiting: null });
      this.finishAutoAttackRound(message);
    }
    async stopIfSlotsHaveNoEspionage(fleet) {
      const campaign = this.campaign;
      let snapshot;
      try {
        snapshot = await fetchOwnFleetMissions(Number(fleet.fleetCount), campaign.sourcePlanetId);
        campaignLog("Répartition des missions occupant les slots", snapshot);
      } catch (error) {
        campaignLog("Missions des slots non vérifiables; attente limitée par timeout", { error: String(error) });
      }
      if (this.campaign !== campaign || campaign.status !== "running" || campaign.pending || campaign.runnerId !== this.campaignTabId) return true;
      if (snapshot) this.persistCampaign({ ...campaign, slotSnapshot: { ...snapshot, checkedAt: Date.now() } });
      if (campaign.phase === "attack") {
        if (snapshot?.complete && snapshot.espionage === 0) {
          this.stopBlockedAutoAttackRound("Limite de slots atteinte sans espionnage en vol · cibles restantes reportées au prochain cycle.");
        } else {
          // Reports arrive at impact, while their probes still occupy slots on
          // the return flight. Keep the same attack queue until those slots free.
          const message = snapshot?.espionage > 0 ? `Slots occupés · ${snapshot.espionage} espionnage(s) encore en vol; attente du retour des sondes.` : "Slots occupés · missions non confirmées; nouvelle vérification des retours.";
          this.waitForAutoAttackFleet(message, "espionageSlots");
        }
        return true;
      }
      if (snapshot?.complete && snapshot.espionage === 0) {
        campaignLog("Slots occupés hors espionnage; progression conservée pendant l’attente", snapshot);
      }
      return false;
    }
    async beginNextAutoAttackRound() {
      if (this.campaignBusy || !this.campaign || this.campaign.phase !== "wait" || this.campaign.status !== "running") return;
      if (this.discoveryStarting || this.discoveryActive()) return this.continueAutoAttacks();
      const targets = this.data.targets.filter((target) => target.enabled && !target.ignore);
      if (!targets.length) return this.abandonAutoAttackRound("Aucun frigo actif pour le prochain cycle.");
      this.campaignBusy = true;
      try {
        if (this.campaign?.runnerId !== this.campaignTabId) return;
        const campaign = {
          ...this.campaign,
          sourcePlanetId: this.homePlanetId(),
          triggerMode: this.data.settings.autoAttackMode ?? "interval",
          phase: "spy",
          targetIds: targets.map((target) => target.id),
          index: 0,
          baselineIds: [],
          sentAt: {},
          reports: {},
          attackDispatches: {},
          attackCounts: {},
          remainingResourceTotals: {},
          waiting: null,
          deferredIds: [],
          skippedTargets: {},
          retry: null,
          retryCounts: {},
          slotSnapshot: null,
          reportsLastProgressAt: null,
          attackIds: [],
          attackIndex: 0,
          attackSlotRetries: 0,
          pending: null,
          lastDispatch: null,
          startedAt: Date.now(),
          nextRunAt: void 0,
          message: "Début de l’espionnage des frigos pour le nouveau cycle."
        };
        this.persistCampaign(campaign);
        this.continueAutoAttacks();
      } catch (error) {
        this.abandonAutoAttackRound(error instanceof Error ? `Impossible de démarrer le cycle : ${error.message}` : String(error));
      } finally {
        this.campaignBusy = false;
      }
    }
    async collectAutoAttackReports() {
      if (this.campaignBusy || !this.campaign || this.campaign.phase !== "reports" || this.campaign.status !== "running") return;
      if (this.campaign.runnerId !== this.campaignTabId) return;
      const reportTargetIds = this.campaign.targetIds.filter((id) => this.campaign.sentAt[id] && this.campaign.skippedTargets?.[id]?.phase !== "spy");
      if (!reportTargetIds.length) return this.finishAutoAttackRound("Aucune cible n’a pu être sondée pendant ce cycle.");
      if (this.context.page !== "messages") {
        campaignLog("Collecte demandée hors de la page Messages", { page: this.context.page });
        this.markCampaignContinuation();
        location.href = messageListURL();
        return;
      }
      this.campaignBusy = true;
      try {
        await openEspionageMessages();
        if (this.campaign?.runnerId !== this.campaignTabId || this.campaign?.status !== "running" || this.campaign.phase !== "reports") return;
        campaignLog("Collecte de rapports démarrée", { targets: this.campaign.targetIds.length, baselineIds: this.campaign.baselineIds.length });
        const visible = inspectVisibleEspionageReports();
        let snapshot;
        try {
          snapshot = await fetchFreshEspionageReports();
        } catch (error) {
          // Native tab data remains usable when the historical endpoint changes.
          if (!visible.reports.length) throw error;
          campaignLog("Lecture AJAX indisponible; utilisation des rapports visibles", { error: String(error), visibleReports: visible.reports.length });
          snapshot = { reports: [], messageIds: [] };
        }
        // The live page and the AJAX reader can expose different message pages.
        // Keep both, preferring the freshly fetched version of a given message.
        const incoming = [...new Map([...visible.reports, ...snapshot.reports].map((item) => [item.messageId, item])).values()];
        if (this.campaign?.runnerId !== this.campaignTabId || this.campaign.status !== "running") return;
        campaignLog("Rapports lus depuis le DOM Messages", { count: incoming.length, visibleMessageIds: snapshot.messageIds.length });
        const baseline = new Set(this.campaign.baselineIds);
        const reports = { ...this.campaign.reports };
        for (const item of incoming) {
          if (baseline.has(item.messageId)) {
            campaignLog("Ancien rapport ignoré", { messageId: item.messageId, coords: formatCoords(item.report.coords) });
            continue;
          }
          const id = targetId(item.report.coords), sentAt = this.campaign.sentAt[id];
          if (!this.campaign.targetIds.includes(id)) continue;
          // Without a pre-scan of Messages, freshness must come from the game's
          // report timestamp. Date.now() used by manual parsing is not evidence.
          if (!sentAt || !item.timestampVerified) {
            campaignLog("Rapport sans date vérifiable ou sans sondage confirmé ignoré", { messageId: item.messageId, targetId: id, sentAt, timestampVerified: item.timestampVerified });
            continue;
          }
          if (item.report.observedAt < Math.floor(sentAt / 1000) * 1000) {
            campaignLog("Rapport antérieur au sondage ignoré", { messageId: item.messageId, coords: formatCoords(item.report.coords), observedAt: item.report.observedAt, sentAt });
            continue;
          }
          if (this.campaign.targetIds.includes(id) && (!reports[id] || reports[id].observedAt < item.report.observedAt)) {
            reports[id] = item.report;
            const loot = calculateLoot(item.report.resources, item.report.lootFactor ?? this.data.settings.lootFactor);
            campaignLog("Rapport associé au frigo", { messageId: item.messageId, targetId: id, coords: formatCoords(item.report.coords), loot, observedAt: item.report.observedAt });
          } else campaignLog("Rapport hors campagne ignoré", { messageId: item.messageId, targetId: id, coords: formatCoords(item.report.coords) });
        }
        const missing = reportTargetIds.filter((id) => !reports[id]);
        if (missing.length) {
          const received = reportTargetIds.length - missing.length;
          const previousCount = reportTargetIds.filter((id) => this.campaign.reports[id]).length;
          const reportsLastProgressAt = received > previousCount ? Date.now() : this.campaign.reportsLastProgressAt ?? Date.now();
          const missingCoords = missing.map((id) => {
            const target = this.data.targets.find((item) => item.id === id);
            return target ? formatCoords(target.coords) : id;
          }).join(", ");
          campaignLog("Rapports manquants; actualisation de la page dans 30 secondes", { received, expected: reportTargetIds.length, missing, reportsLastProgressAt });
          this.persistCampaign({ ...this.campaign, reports, reportsLastProgressAt, message: `${received}/${reportTargetIds.length} rapports frais reçus. Manquants : ${missingCoords}. Actualisation de la page dans 30 secondes.` });
          if (Date.now() - reportsLastProgressAt >= 30 * 60000) {
            const skippedTargets = { ...this.campaign.skippedTargets };
            for (const id of missing) {
              const message = "Rapport manquant après 30 minutes · autres frigos conservés.";
              this.recordCampaignFailure(message, { targetId: id });
              skippedTargets[id] = { phase: "spy", message, at: Date.now() };
            }
            this.persistCampaign({ ...this.campaign, reports, skippedTargets, message: "Rapports manquants écartés; poursuite avec les rapports déjà reçus." });
            if (this.campaignTimer) clearTimeout(this.campaignTimer);
            this.campaignTimer = setTimeout(() => { this.campaignTimer = void 0; this.continueAutoAttacks(); }, 1500);
            return;
          }
          if (!this.campaignTimer) this.campaignTimer = setTimeout(() => {
            this.campaignTimer = void 0;
            const current = this.campaign;
            if (!current || current.status !== "running" || current.runnerId !== this.campaignTabId || current.phase !== "reports" || current.pending) return;
            this.markCampaignContinuation();
            location.replace(messageListURL());
          }, 30000);
          return;
        }
        for (const report of Object.values(reports)) this.ingest(report);
        const skippedTargets = { ...this.campaign.skippedTargets };
        const attackIds = reportTargetIds.filter((id) => {
          const warning = attackReportWarning(reports[id]);
          if (warning) {
            skippedTargets[id] = { phase: "attack", message: warning, at: Date.now() };
            campaignLog("Cible exclue après lecture du rapport", { targetId: id, fleet: reports[id].fleet ?? null, defense: reports[id].defense ?? null, message: warning });
            return false;
          }
          const loot = calculateLoot(reports[id].resources, reports[id].lootFactor ?? this.data.settings.lootFactor);
          return loot > 0 && loot >= this.data.settings.minimumLoot;
        }).sort((a, b) => calculateLoot(reports[b].resources, reports[b].lootFactor ?? this.data.settings.lootFactor) - calculateLoot(reports[a].resources, reports[a].lootFactor ?? this.data.settings.lootFactor));
        campaignLog("File d’attaques calculée par butin décroissant", { attacks: attackIds.map((id) => ({ targetId: id, loot: calculateLoot(reports[id].resources, reports[id].lootFactor ?? this.data.settings.lootFactor) })), minimumLoot: this.data.settings.minimumLoot });
        const next = { ...this.campaign, reports, skippedTargets, attackIds, attackIndex: 0, phase: "attack", status: "running", message: `${attackIds.length} cible(s) sans flotte ni défenses au-dessus du seuil de butin.` };
        this.persistCampaign(next);
        if (!attackIds.length) {
          this.finishAutoAttackRound("Aucune cible attaquable : butin insuffisant, flotte ou défenses détectées, ou informations militaires inconnues.");
          return;
        }
        this.continueAutoAttacks();
      } catch (error) {
        campaignLog("Erreur pendant la collecte des rapports", { error: String(error) });
        this.scheduleCampaignRetry(error instanceof Error ? `Lecture des rapports interrompue : ${error.message}` : String(error));
      } finally {
        this.campaignBusy = false;
      }
    }
    recordAutoAttackDispatchResult(action, targetId2, response) {
      const campaign = this.campaign;
      if (!campaign || campaign.runnerId !== this.campaignTabId || campaign.pending?.targetId !== targetId2 || campaign.pending?.action !== action) {
        campaignLog("Réponse AJAX sans envoi pending correspondant", { action, targetId: targetId2, success: response.success, pending: campaign?.pending ?? null });
        return;
      }
      const errors = Array.isArray(response.errors) ? response.errors.map((error) => typeof error === "string" ? error : error?.message).filter(Boolean) : [];
      campaignLog("Réponse AJAX du dispatcher", { action, targetId: targetId2, success: response.success, errors, hasRedirectUrl: Boolean(response.redirectUrl) });
      if (response.success !== true) {
        this.persistCampaign({ ...campaign, pending: null });
        this.scheduleCampaignRetry(errors.join("; ") || "OGame a refusé l’envoi de la flotte.", true);
        return;
      }
      const target = this.data.targets.find((item) => item.id === targetId2);
      const shortfall = Number(campaign.pending.capacityShortfall ?? 0);
      const partialMessage = shortfall > 0 ? ` Capacité insuffisante : ${fmt(shortfall)} ressources resteront sur la cible.` : "";
      const confirmedAt = Date.now();
      const next = { ...campaign, pending: null, lastDispatch: { action, targetId: targetId2, confirmedAt }, message: `${action === "spy" ? "Espionnage envoyé" : "Attaque envoyée"}${target ? ` : ${target.name} ${formatCoords(target.coords)}` : ""}.${partialMessage}` };
      if (action === "spy") {
        next.sentAt = { ...campaign.sentAt, [targetId2]: confirmedAt };
        next.index++;
        if (next.index >= next.targetIds.length) {
          next.phase = "reports";
          next.reportsLastProgressAt = Date.now();
          next.message = "Tous les espionnages sont envoyés; lecture des rapports frais.";
        }
      } else {
        next.attackDispatches = { ...campaign.attackDispatches, [targetId2]: [...(campaign.attackDispatches?.[targetId2] ?? []), ...(campaign.pending.ships ?? [])] };
        next.attackCounts = { ...campaign.attackCounts, [targetId2]: (campaign.attackCounts?.[targetId2] ?? 0) + 1 };
        next.attackIndex++;
        next.attackSlotRetries = 0;
        const report = campaign.reports?.[targetId2];
        if (report) {
          const total = campaign.remainingResourceTotals?.[targetId2] ?? Object.values(report.resources).reduce((a, b) => a + b, 0);
          const capacity = (campaign.pending.ships ?? []).reduce((sum, [ship, count]) => sum + count * (Number(ship) === 202 ? this.data.settings.smallCargo : this.data.settings.largeCargo), 0);
          const taken = Math.min(plannedAttackLoot(campaign, targetId2, this.data.settings), capacity);
          next.remainingResourceTotals = { ...campaign.remainingResourceTotals, [targetId2]: Math.max(0, total - taken) };
          const remainingLoot = plannedAttackLoot(next, targetId2, this.data.settings);
          const tail = campaign.attackIds.slice(next.attackIndex);
          if (taken > 0 && remainingLoot > 0 && remainingLoot >= this.data.settings.minimumLoot && next.attackCounts[targetId2] < (this.data.settings.maxAttackWaves ?? defaults.maxAttackWaves)) tail.push(targetId2);
          tail.sort((a, b) => plannedAttackLoot(next, b, this.data.settings) - plannedAttackLoot(next, a, this.data.settings));
          next.attackIds = [...campaign.attackIds.slice(0, next.attackIndex), ...tail];
          campaignLog("Priorités des prochaines vagues recalculées", { targetId: targetId2, taken, remainingLoot, waves: next.attackCounts[targetId2], nextTargets: tail });
        }
      }
      this.persistCampaign(next);
      if (action === "attack" && next.attackIndex >= next.attackIds.length) this.finishAutoAttackRound("Toutes les attaques de la campagne ont été envoyées.");
      campaignLog("Campagne avancée après succès OGame", { action, phase: next.phase, index: next.index, attackIndex: next.attackIndex, pending: next.pending });
      // OGame can leave the dispatcher visible instead of redirecting to movement.
      // Advance only on confirmed success; the next document resumes via the token.
      if (!this.campaignTimer && this.campaign?.phase !== "wait") this.campaignTimer = setTimeout(() => {
        this.campaignTimer = void 0;
        this.continueAutoAttacks();
      }, 1500);
    }
    async handleAutoAttackNavigation() {
      let campaign = this.campaign;
      if (!campaign || campaign.playerId !== this.context?.playerId || campaign.runnerId !== this.campaignTabId) return;
      campaignLog("Navigation OGame détectée", { page: this.context.page, phase: campaign.phase, index: campaign.index, attackIndex: campaign.attackIndex, pending: campaign.pending?.action ?? null });
      if (campaign.pending) {
        if (campaign.status === "running") this.recoverUncertainDispatch("Résultat d’envoi incertain après navigation.");
        return;
      }
      if (campaign.status !== "running") return;
      if (campaign.retry) return this.continueAutoAttacks();
      if (campaign.phase === "baseline" || campaign.phase === "reports") return this.continueAutoAttacks();
      if (campaign.phase === "wait") return this.continueAutoAttacks();
      const params = new URLSearchParams(location.hash.slice(1));
      if (this.context.page === "fleetdispatch") {
        const previousId = campaign.phase === "spy" ? campaign.targetIds[campaign.index - 1] : campaign.attackIds[campaign.attackIndex - 1];
        const currentId = campaign.phase === "spy" ? campaign.targetIds[campaign.index] : campaign.attackIds[campaign.attackIndex];
        const lastDispatch = campaign.lastDispatch;
        // A confirmed dispatch can redirect back to fleetdispatch with no hash,
        // or with the old destination. Open the next target instead of pausing.
        if (lastDispatch?.action === campaign.phase && lastDispatch.targetId === previousId && Date.now() - lastDispatch.confirmedAt < 120000) {
          const target = this.data.targets.find((item) => item.id === currentId);
          const url = new URL(location.href);
          const isCurrentDestination = target && ["galaxy", "system", "position"].every((key) => Number(url.searchParams.get(key)) === target.coords[key]) && (url.searchParams.get("type") === "3") === (target.coords.type === "moon");
          if (params.get("sephiCampaign") !== "1" || !isCurrentDestination) {
            campaignLog("Redirection après envoi confirmé; poursuite de la liste", { previousId, currentId, phase: campaign.phase });
            return this.continueAutoAttacks();
          }
        }
        if (params.get("sephiCampaign") === "1" && params.get("sephiPlayer") === this.context.playerId) return this.dispatchAutoAttackFleet();
        return this.scheduleCampaignRetry("Le cadre de campagne a perdu sa destination; réouverture du dispatcher.");
      }
      this.continueAutoAttacks();
    }
    skipAutoAttackTarget(message) {
      const campaign = this.campaign;
      if (!campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending || !["spy", "attack"].includes(campaign.phase)) return;
      const id = campaign.phase === "spy" ? campaign.targetIds[campaign.index] : campaign.attackIds[campaign.attackIndex];
      if (!id) return;
      campaignLog("Cible indisponible; passage à la suivante", { targetId: id, phase: campaign.phase, message });
      const next = { ...campaign, retry: null, waiting: null, skippedTargets: { ...campaign.skippedTargets, [id]: { phase: campaign.phase, message, at: Date.now() } }, message };
      if (campaign.phase === "spy") {
        next.index++;
        if (next.index >= next.targetIds.length) {
          next.phase = "reports";
          next.reportsLastProgressAt = Date.now();
        }
      } else next.attackIndex++;
      this.persistCampaign(next);
      if (campaign.phase === "attack" && next.attackIndex >= next.attackIds.length) return this.finishAutoAttackRound("Toutes les cibles d’attaque ont été traitées ou écartées.");
      if (this.campaignTimer) clearTimeout(this.campaignTimer);
      this.campaignTimer = setTimeout(() => {
        this.campaignTimer = void 0;
        this.continueAutoAttacks();
      }, 1500);
    }
    waitForAutoAttackFleet(message, reason = "ships") {
      const campaign = this.campaign;
      if (!campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending) return;
      if (campaign.phase === "attack" && reason === "slots") return this.stopBlockedAutoAttackRound("Limite de slots atteinte · session d’attaques terminée; cibles restantes reportées au prochain cycle.");
      const retryInMs = reason === "espionageSlots" ? 30000 : 15000;
      const startedAt = campaign.waiting?.targetId === (campaign.phase === "attack" ? campaign.attackIds[campaign.attackIndex] : campaign.targetIds[campaign.index]) ? campaign.waiting.startedAt ?? Date.now() : Date.now();
      const timeoutMinutes = this.data.settings.fleetWaitTimeoutMinutes ?? defaults.fleetWaitTimeoutMinutes;
      if (Date.now() - startedAt >= timeoutMinutes * 60000) return this.scheduleCampaignRetry(`Disponibilités inchangées après ${timeoutMinutes} minutes; progression conservée.`);
      campaignLog("Attente du retour des flottes", { phase: campaign.phase, message, retryInMs });
      const targetId = campaign.phase === "attack" ? campaign.attackIds[campaign.attackIndex] : campaign.targetIds[campaign.index];
      this.persistCampaign({ ...campaign, waiting: { targetId, reason, startedAt, message: reason === "confirmation" ? "Confirmation OGame indisponible · attente" : reason === "fuel" ? "Calcul du carburant indisponible · attente" : reason === "espionageSlots" ? "Slots occupés · attente du retour des sondes" : reason === "slots" ? "Plus de slot disponible · attente" : "Plus assez de vaisseaux disponibles · attente" }, message: `${message} Nouvelle vérification dans ${retryInMs / 1000} secondes (limite ${timeoutMinutes} min).` });
      // This wait owns the next retry; do not leave an unrelated progression
      // timer in place and silently skip scheduling the resource refresh.
      if (this.campaignTimer) clearTimeout(this.campaignTimer);
      this.campaignTimer = setTimeout(() => {
        this.campaignTimer = void 0;
        const current = this.campaign;
        if (!current || current.status !== "running" || current.runnerId !== this.campaignTabId || current.pending || current.phase !== campaign.phase) {
          campaignLog("Vérification des disponibilités annulée", { status: current?.status, phase: current?.phase, ownedByThisTab: current?.runnerId === this.campaignTabId, pending: Boolean(current?.pending) });
          return;
        }
        campaignLog("Rechargement flotte pour vérifier les retours", { phase: current.phase, targetId, reason, index: current.index, attackIndex: current.attackIndex });
        // Replacing the same URL with a hash can be a same-document navigation.
        // reload preserves the campaign hash AND refreshes authoritative counts.
        this.markCampaignContinuation();
        location.reload();
      }, retryInMs);
      campaignLog("Minuteur de vérification des disponibilités armé", { targetId, reason, retryInMs });
    }
    async dispatchAutoAttackFleet() {
      let fleet;
      for (let attempt = 0; attempt < 20; attempt++) {
        fleet = dispatcher();
        if (fleet && Array.isArray(fleet.shipsOnPlanet) && fleet.targetPlanet && typeof fleet.selectShip === "function") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const campaign = this.campaign;
      if (!campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending) return;
      if (!fleet) return this.scheduleCampaignRetry("Dispatcher de flotte indisponible.");
      if (campaign.sourcePlanetId && campaign.sourcePlanetId !== this.context.planetId) return this.scheduleCampaignRetry("La planète de départ a changé; retour à la planète de campagne.");
      if (fleet.currentPage !== "fleet1") return this.scheduleCampaignRetry("Le dispatcher n’est pas à l’étape de sélection.");
      if (fleet.hasShipsSelected?.() || fleet.shipsToSend?.some((ship) => Number(ship.number) > 0)) return this.scheduleCampaignRetry("Sélection déjà présente; réouverture du dispatcher de campagne.");
      const id = campaign.phase === "attack" ? campaign.attackIds[campaign.attackIndex] : campaign.targetIds[campaign.index];
      const target = this.data.targets.find((item) => item.id === id);
      if (!target) return this.skipAutoAttackTarget("La cible courante a été supprimée des frigos.");
      if (campaign.phase === "attack" && !campaign.discoveryTest && campaign.reports[id]) {
        const warning = attackReportWarning(campaign.reports[id]);
        if (warning) return this.skipAutoAttackTarget(warning);
      }
      campaignLog("Dispatcher prêt", { phase: campaign.phase, targetId: id, coords: formatCoords(target.coords), currentPage: fleet.currentPage, shipsOnPlanet: fleet.shipsOnPlanet.filter((ship) => Number(ship.number) > 0).map((ship) => ({ id: ship.id, number: ship.number })) });
      const url = new URL(location.href);
      const expected = target.coords;
      if (["galaxy", "system", "position", "type"].some((key) => Number(fleet.targetPlanet[key]) !== Number(url.searchParams.get(key))) || Number(url.searchParams.get("galaxy")) !== expected.galaxy || Number(url.searchParams.get("system")) !== expected.system || Number(url.searchParams.get("position")) !== expected.position || (url.searchParams.get("type") === "3") !== (expected.type === "moon")) return this.scheduleCampaignRetry("La destination affichée ne correspond pas au frigo courant.", true);
      const reserve = this.data.settings.reservedFleetSlots ?? defaults.reservedFleetSlots;
      const hasFreeSlots = campaignSlotsAvailable(fleet, reserve);
      campaignLog("Disponibilités de flotte vérifiées", { targetId: id, hasFreeSlots, fleetCount: fleet.fleetCount ?? null, maxFleetCount: fleet.maxFleetCount ?? null });
      if (!hasFreeSlots) {
        if (await this.stopIfSlotsHaveNoEspionage(fleet)) return;
        return this.waitForAutoAttackFleet(`Limite de slots atteinte (${reserve} réservé(s)); attente d’un retour de flotte.`, "slots");
      }
      if (campaign.phase === "spy") {
        try {
          const movements = await fetchOwnFleetMissions(Number(fleet.fleetCount), campaign.sourcePlanetId);
          if (this.campaign !== campaign || campaign.status !== "running" || campaign.pending) return;
          if (movements.unresolvedAttacks.length) return this.scheduleCampaignRetry("Destination d’une attaque en cours illisible; vérification des mouvements à reprendre.");
          if (movements.activeAttackIds.includes(id)) return this.skipAutoAttackTarget("Attaque déjà en route vers ce frigo · espionnage et attaque ignorés pour ce cycle.");
        } catch (error) {
          return this.scheduleCampaignRetry(`Vérification des attaques en cours indisponible : ${String(error)}`);
        }
      }
      let mission, shipsToSelect, capacityShortfall = 0;
      if (campaign.phase === "spy") {
        shipsToSelect = [[210, target.probeCount]];
        mission = 6;
        const available = Number(fleet.shipsOnPlanet.find((ship) => Number(ship.id) === 210)?.number ?? 0);
        if (!Number.isSafeInteger(available) || available < 0) return this.scheduleCampaignRetry("Nombre de sondes disponible illisible.");
        if (available < target.probeCount) return this.waitForAutoAttackFleet(`Sondes disponibles : ${available}/${target.probeCount}; attente de leur retour.`);
      } else if (campaign.discoveryTest) {
        if (Number(fleet.shipsOnPlanet.find((ship) => Number(ship.id) === 210)?.number ?? 0) < 1) return this.waitForAutoAttackFleet("Aucune sonde disponible pour le test.");
        if (fleet.moveInProgress || fleet.warningsEnabled && fleet.targetIsStrong && !fleet.targetIsOutlaw && !fleet.targetIsBuddyOrAllyMember && !fleet.playerIsOutlaw) return this.skipAutoAttackTarget("Confirmation manuelle demandée · test non effectué.");
        shipsToSelect = [[210, 1]];
        mission = 1;
      } else {
        const report = campaign.reports[id];
        if (!report) return this.scheduleCampaignRetry("Rapport absent pour la cible courante.");
        const loot = plannedAttackLoot(campaign, id, this.data.settings);
        const requiredPT = calculateRequiredCargo(loot, this.data.settings.smallCargo);
        const availablePT = Number(fleet.shipsOnPlanet.find((ship) => Number(ship.id) === 202)?.number ?? 0);
        const availableGT = Number(fleet.shipsOnPlanet.find((ship) => Number(ship.id) === 203)?.number ?? 0);
        const ptCount = Math.min(requiredPT, availablePT);
        const remainingLoot = Math.max(0, loot - ptCount * this.data.settings.smallCargo);
        const gtRequired = calculateRequiredCargo(remainingLoot, this.data.settings.largeCargo);
        const gtCount = Math.min(gtRequired, availableGT);
        const totalCapacity = ptCount * this.data.settings.smallCargo + gtCount * this.data.settings.largeCargo;
        capacityShortfall = Math.max(0, loot - totalCapacity);
        if (ptCount + gtCount === 0) return this.waitForAutoAttackFleet("Aucun transporteur disponible; attente de leur retour.");
        if (capacityShortfall > 0) campaignLog("Transport partiel disponible; attaque maintenue", { targetId: id, loot, ptCount, gtCount, totalCapacity, capacityShortfall });
        shipsToSelect = [[202, ptCount], [203, gtCount]].filter(([, count]) => count > 0);
        mission = 1;
        if (fleet.moveInProgress || fleet.warningsEnabled && fleet.targetIsStrong && !fleet.targetIsOutlaw && !fleet.targetIsBuddyOrAllyMember && !fleet.playerIsOutlaw) {
          this.recordCampaignFailure("Confirmation manuelle demandée par OGame; aucune attaque envoyée.");
          return this.skipAutoAttackTarget("Cible écartée · confirmation manuelle requise.");
        }
      }
      for (const [shipId, count] of shipsToSelect) fleet.selectShip(shipId, count);
      fleet.refresh();
      campaignLog("Vaisseaux sélectionnés", { phase: campaign.phase, shipsToSelect, mission, shipsToSend: fleet.shipsToSend?.filter((ship) => Number(ship.number) > 0) });
      if (!fleet.hasShipsSelected()) return this.scheduleCampaignRetry("OGame n’a pas appliqué la sélection de vaisseaux.");
      if (!fleet.hasValidTarget()) {
        fleet.resetShips?.();
        return this.scheduleCampaignRetry("Destination invalide; vérification de l’existence du frigo.", true);
      }
      const originalFuelCheck = fleet.hasEnoughFuel;
      let fuel = fleetFuelStatus(fleet, originalFuelCheck);
      if (fuel.enough === null || fuel.consumption === null) campaignLog("Attente du calcul carburant", { phase: campaign.phase, targetId: id, ...fuel });
      for (let attempt = 0; attempt < 50 && (fuel.enough === null || fuel.consumption === null); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.campaign !== campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending) {
          fleet.resetShips?.();
          return;
        }
        fleet.refresh();
        fuel = fleetFuelStatus(fleet, originalFuelCheck);
      }
      campaignLog("Vérification du carburant", { phase: campaign.phase, targetId: id, ...fuel });
      if (fuel.consumption === null) {
        fleet.resetShips?.();
        return this.discardUnavailableFuelTarget();
      }
      if (fuel.enough === null) {
        fleet.resetShips?.();
        return this.scheduleCampaignRetry("Données de deutérium ou de chargement indisponibles.");
      }
      if (!fuel.enough) return this.scheduleCampaignRetry(`Carburant refusé : deutérium ${fuel.available ?? "inconnu"}, consommation ${fuel.consumption ?? "inconnue"}.`);
      // Native fleet1/fleet2 validation also calls hasEnoughFuel. Apply the
      // same fallback throughout this dispatch, and restore the game method.
      fleet.hasEnoughFuel = function () { return fleetFuelStatus(this, originalFuelCheck).enough === true; };
      try {
        fleet.trySubmitFleet1();
        campaignLog("Transition vers fleet2", { currentPage: fleet.currentPage, targetValid: fleet.hasValidTarget(), fuelValid: fleet.hasEnoughFuel() });
        if (fleet.currentPage !== "fleet2") return this.scheduleCampaignRetry("OGame n’a pas accepté le passage à la confirmation de flotte.");
        refreshHiddenFleetTarget(fleet);
        fleet.selectMission(mission);
        fleet.refresh();
        campaignLog("Carburant à la confirmation", { phase: campaign.phase, targetId: id, mission: fleet.mission, ...fleetFuelStatus(fleet, originalFuelCheck) });
        let sendButton, confirmationFuel;
        for (let attempt = 0; attempt < 100; attempt++) {
          if (this.campaign !== campaign || campaign.status !== "running" || campaign.runnerId !== this.campaignTabId || campaign.pending) {
            fleet.switchToPage("fleet1");
            fleet.resetShips();
            return;
          }
          fleet.refresh();
          // Target AJAX updates can clear an already selected mission. Use the
          // native selector again once that update has released the dispatcher.
          if (!fleet.loading && Number(fleet.mission) !== mission) {
            campaignLog("Réapplication de la mission après actualisation OGame", { targetId: id, expectedMission: mission, previousMission: fleet.mission ?? null });
            fleet.selectMission(mission);
            fleet.refresh();
          }
          fleet.refreshNavigationFleet2(false);
          confirmationFuel = fleetFuelStatus(fleet, originalFuelCheck);
          sendButton = document.getElementById("sendFleet");
          if (!fleet.loading && Number(fleet.mission) === mission && fleet.hasMission() && campaignSlotsAvailable(fleet, reserve) && confirmationFuel.consumption !== null && confirmationFuel.enough === true && sendButton && !sendButton.classList.contains("off") && !sendButton.hasAttribute("disabled")) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const confirmationDiagnostic = fleetDispatchDiagnostic(fleet, mission, confirmationFuel);
        confirmationDiagnostic.reservedFleetSlots = reserve;
        confirmationDiagnostic.slotsUsable = campaignSlotsAvailable(fleet, reserve);
        confirmationDiagnostic.blockers = fleetConfirmationBlockers(confirmationDiagnostic);
        this.lastDispatchDiagnostic = confirmationDiagnostic;
        if (!campaignSlotsAvailable(fleet, reserve)) {
          fleet.switchToPage("fleet1");
          fleet.resetShips();
          if (await this.stopIfSlotsHaveNoEspionage(fleet)) return;
          return this.waitForAutoAttackFleet(`Réserve de ${reserve} slot(s) à préserver.`, "slots");
        }
        if (fleet.loading || Number(fleet.mission) !== mission || !fleet.hasMission() || confirmationFuel?.consumption === null || confirmationFuel?.enough !== true || !sendButton || sendButton.classList.contains("off") || sendButton.hasAttribute("disabled")) {
          campaignLog("Envoi bloqué à la confirmation", { expectedMission: mission, mission: fleet.mission, loading: Boolean(fleet.loading), hasMission: fleet.hasMission(), hasFreeSlots: fleet.hasFreeSlots(), targetValid: fleet.hasValidTarget(), button: sendButton?.className ?? null, fuel: confirmationFuel, diagnostic: confirmationDiagnostic });
          fleet.refreshNavigationFleet2(true);
          fleet.switchToPage("fleet1");
          fleet.resetShips();
          if (confirmationFuel?.consumption === null) return this.discardUnavailableFuelTarget();
          return this.scheduleCampaignRetry(`Confirmation OGame indisponible : ${confirmationDiagnostic.blockers.join(" ; ") || "motif interne non exposé par OGame, voir le diagnostic"}.`, true);
        }
        campaignLog("Bouton d’envoi actif", { mission: fleet.mission, hasMission: fleet.hasMission(), sendButton: sendButton.className });
        if (!campaignSlotsAvailable(fleet, reserve)) {
          fleet.switchToPage("fleet1");
          fleet.resetShips();
          if (await this.stopIfSlotsHaveNoEspionage(fleet)) return;
          return this.waitForAutoAttackFleet(`Réserve de ${reserve} slot(s) à préserver.`, "slots");
        }
        if (this.campaign !== campaign || this.campaign?.status !== "running" || this.campaign.runnerId !== this.campaignTabId || this.campaign.pending) {
          fleet.switchToPage("fleet1");
          fleet.resetShips();
          return;
        }
        const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
        const gameJQuery = gameWindow.jQuery ?? gameWindow.$;
        if (typeof gameJQuery?.post !== "function") return this.scheduleCampaignRetry("Canal AJAX OGame indisponible; aucun envoi effectué.");
        const originalSubmit = fleet.submitFleet2;
        if (campaign.phase === "attack" && typeof originalSubmit !== "function") return this.scheduleCampaignRetry("Méthode d’envoi OGame introuvable.");
        if (campaign.phase === "attack") {
          const thisPanel = this;
          fleet.submitFleet2 = function (force) {
            if (force) {
              fleet.submitFleet2 = originalSubmit;
              if (thisPanel.campaign?.pending) thisPanel.recoverUncertainDispatch("Confirmation de limite Bash demandée; aucun forçage.");
              else {
                thisPanel.recordCampaignFailure("Confirmation de limite Bash demandée; aucun forçage.");
                thisPanel.skipAutoAttackTarget("Cible écartée · limite Bash signalée par OGame.");
              }
              return;
            }
            return originalSubmit.call(this, false);
          };
        }
        this.persistCampaign({ ...campaign, waiting: null, pending: { action: campaign.phase, targetId: id, capacityShortfall, ships: shipsToSelect, startedAt: Date.now() }, message: `Envoi ${campaign.phase === "spy" ? "des sondes" : "de l’attaque"} en cours.` });
        const originalPost = gameJQuery.post;
        const thisPanel = this;
        let postObserved = false;
        gameJQuery.post = function (requestURL, data, callback, ...args) {
          const matchesFleetRequest = String(requestURL) === String(fleet.sendFleetUrl) && typeof callback === "function";
          campaignLog(matchesFleetRequest ? "POST flotte intercepté" : "POST non lié à l’envoi flotte", { requestURL: String(requestURL), expectedURL: String(fleet.sendFleetUrl) });
          if (!matchesFleetRequest) return originalPost.call(this, requestURL, data, callback, ...args);
          postObserved = true;
          const wrappedCallback = function (response, ...callbackArgs) {
            let confirmed = false;
            try {
              const result = typeof response === "string" ? JSON.parse(response) : response;
              if (result && typeof result.success === "boolean") {
                const pending = thisPanel.campaign?.pending;
                const ownsDispatch = thisPanel.campaign?.runnerId === thisPanel.campaignTabId && pending?.action === campaign.phase && pending?.targetId === id;
                thisPanel.recordAutoAttackDispatchResult(campaign.phase, id, result);
                confirmed = ownsDispatch && result.success === true && !thisPanel.campaign?.pending;
              }
              else campaignLog("Réponse AJAX sans champ success", { responseType: typeof response, keys: result && typeof result === "object" ? Object.keys(result) : [] });
            } catch (error) {
              campaignLog("Réponse AJAX illisible", { error: String(error), responseType: typeof response });
            }
            if (confirmed && (isCampaignWorker() || thisPanel.campaign?.status === "running" && thisPanel.campaign.phase !== "wait")) {
              // The campaign owns the next navigation. The native success callback
              // would redirect to fleetdispatch and discard the campaign URL.
              campaignLog("Envoi confirmé; navigation suivante gérée par la campagne", { action: campaign.phase, targetId: id });
              return;
            }
            return callback.call(this, response, ...callbackArgs);
          };
          return originalPost.call(this, requestURL, data, wrappedCallback, ...args);
        };
        try {
          campaignLog("Appel trySubmitFleet2", { mission: fleet.mission, hasMission: fleet.hasMission(), button: document.getElementById("sendFleet")?.className });
          this.markCampaignContinuation();
          fleet.trySubmitFleet2();
          if (!postObserved) {
            campaignLog("Aucun POST flotte émis par trySubmitFleet2", { mission: fleet.mission, hasMission: fleet.hasMission(), button: document.getElementById("sendFleet")?.className, loading: fleet.loading, fuel: fleetFuelStatus(fleet, originalFuelCheck) });
            sessionStorage.removeItem(this.campaignContinuationKey);
            this.persistCampaign({ ...this.campaign, pending: null });
            return this.scheduleCampaignRetry("La validation interne OGame a interrompu l’envoi avant la requête serveur.");
          }
        } finally {
          gameJQuery.post = originalPost;
        }
        setTimeout(() => {
          if (this.campaign?.pending && this.context.page === "fleetdispatch") this.recoverUncertainDispatch("OGame n’a pas confirmé cet envoi.");
        }, 10000);
      } finally {
        fleet.hasEnoughFuel = originalFuelCheck;
      }
    }
    startCampaignWorker() {
      if (document.getElementById("sephi-campaign-worker")) return;
      const frame = document.createElement("iframe");
      const token = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      frame.id = "sephi-campaign-worker";
      frame.dataset.sephiWorker = token;
      frame.hidden = true;
      frame.title = "Exécution de la campagne SephiOGame";
      frame.setAttribute("aria-hidden", "true");
      const url = new URL("/game/index.php", location.href);
      url.searchParams.set("page", "ingame");
      url.searchParams.set("component", "overview");
      url.searchParams.set("cp", this.campaign.sourcePlanetId ?? this.context.planetId);
      url.searchParams.set("sephiWorker", token);
      frame.src = url.href;
      document.body.append(frame);
      campaignLog("Exécution de la campagne en arrière-plan démarrée", { phase: this.campaign.phase });
      this.workerWatchdog = setTimeout(() => {
        this.workerWatchdog = void 0;
        if (frame.isConnected && !frame.dataset.sephiReady && this.campaign?.status === "running") this.scheduleCampaignRetry(`Le moteur de campagne ${VERSION} n’a pas démarré.`);
      }, 20000);
    }
    stopCampaignWorker() {
      // An uncertain dispatch must retain its callback until OGame responds.
      if (this.campaign?.pending) return;
      if (this.workerWatchdog) clearTimeout(this.workerWatchdog);
      this.workerWatchdog = void 0;
      document.getElementById("sephi-campaign-worker")?.remove();
    }
    constructionState(planetId = this.constructionPlanetId ?? this.context.planetId) {
      return readJSON(constructionStateKey(this.store.key, planetId));
    }
    setConstructionState(value, planetId = this.constructionPlanetId ?? this.context.planetId) {
      localStorage.setItem(constructionStateKey(this.store.key, planetId), JSON.stringify(value));
      if (this.activeTab === "Constructions") this.render();
      this.scanNativeEnhancements();
    }
    changeConstructionQueue(update) {
      const latest = this.store.load();
      this.save({ ...latest, constructionQueue: update(latest.constructionQueue) });
    }
    renderConstructionBars(host, planetId = this.constructionPlanetId ?? this.context.planetId) {
      const state = this.constructionState(planetId), queue = planetQueue(this.data.constructionQueue ?? [], planetId);
      const economy = this.store ? readJSON(`${this.store.key}:economies`)[planetId] : undefined;
      const cumulativeCosts = { metal: 0, crystal: 0, deuterium: 0 };
      let knownCosts = true;
      const lockedId = state.pending?.id ?? (state.busy ? queue[0]?.id : undefined);
      const names = { supplies: "Ressources", facilities: "Installations", research: "Recherche", shipyard: "Chantier", defenses: "Défense" };
      for (const item of queue) {
        const bar = element("div");
        bar.dataset.constructionId = item.id;
        bar.draggable = item.id !== lockedId;
        bar.style.cssText = "box-sizing:border-box;display:flex;align-items:center;gap:7px;height:27px;margin:0 0 2px;padding:0 8px 0 14px;border:1px solid #344d61;border-top-color:#50677a;border-bottom-color:#0b121c;border-radius:2px;background:linear-gradient(100deg,#182c3b,#263c4e 45%,#142431);box-shadow:inset 0 1px #ffffff0b;color:#6f9fc8;font:12px Verdana,Arial,sans-serif;text-shadow:0 1px #000";
        const label = element("span", `${item.id === lockedId ? "[En cours] " : ""}${item.name}${item.quantity > 1 ? ` × ${fmt(item.quantity)}` : ""}`);
        label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        label.title = `${names[item.page]} · planète ${planetLabelById(item.planetId)}`;
        bar.append(label);
        const category = element("small", names[item.page]);
        category.dataset.sephiEstimate = item.id;
        category.dataset.sephiPlanet = planetId;
        if (!item.costs) knownCosts = false;
        if (item.costs) for (const key of resourceKeys) cumulativeCosts[key] += item.costs[key];
        const estimate = constructionEstimate(knownCosts ? cumulativeCosts : undefined, economy);
        category.textContent = `${names[item.page]} · ${estimate.text}`;
        category.title = resourceKeys.map((key) => `${key} manquant : ${estimate.missing[key] ?? "?"}`).join(" · ") + " · Estimation des ressources cumulées ; les chantiers, transports et variations de production peuvent la modifier.";
        category.style.cssText = "max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#728da4;font:10px Verdana,Arial,sans-serif";
        const handle = element("span", "⠿");
        handle.title = "Glisser pour déplacer";
        handle.style.cssText = `font-size:21px;line-height:20px;color:#aac0d0;cursor:${item.id === lockedId ? "default" : "grab"}`;
        const remove = this.button("×", () => {
          const current = this.constructionState(planetId);
          if (current.pending?.id === item.id || current.busy && planetQueue(this.store.load().constructionQueue, planetId)[0]?.id === item.id) return;
          this.changeConstructionQueue((items) => items.filter((entry) => entry.id !== item.id));
        });
        remove.title = "Retirer cette construction";
        remove.disabled = item.id === lockedId;
        remove.style.cssText = "padding:0;border:0;background:none;color:#9dadb8;font:20px Arial;line-height:22px;cursor:pointer";
        bar.append(category, handle, remove);
        bar.addEventListener("dragstart", (event) => {
          if (item.id === lockedId) { event.preventDefault(); return; }
          event.dataTransfer.setData("text/plain", item.id);
          event.dataTransfer.effectAllowed = "move";
          bar.style.opacity = ".45";
        });
        bar.addEventListener("dragend", () => { bar.style.opacity = "1"; });
        bar.addEventListener("dragover", (event) => {
          if (item.id === lockedId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          bar.style.borderTopColor = "#8ecbff";
        });
        bar.addEventListener("dragleave", () => { bar.style.borderTopColor = "#50677a"; });
        bar.addEventListener("drop", (event) => {
          event.preventDefault();
          const current = this.constructionState(planetId);
          this.changeConstructionQueue((items) => {
            const local = planetQueue(items, planetId), ordered = moveConstruction(local, event.dataTransfer.getData("text/plain"), item.id, current.pending?.id ?? (current.busy ? local[0]?.id : undefined));
            let index = 0;
            return items.map((entry) => entry.planetId === planetId ? ordered[index++] : entry);
          });
        });
        host.append(bar);
      }
    }
    addConstruction(info) {
      if (!this.context) return;
      const quantity = ["shipyard", "defenses"].includes(this.context.page) ? Number(document.getElementById("build_amount")?.value ?? 1) : 1;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw new Error("Quantité à programmer invalide.");
      const costs = constructionCosts(info.detail, quantity);
      const economy = capturePlanetEconomy(this.store.key, this.context);
      const item = { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, planetId: this.context.planetId, page: this.context.page, technology: info.technology, name: info.name, quantity, ...(costs ? { costs } : {}) };
      this.changeConstructionQueue((queue) => [...queue, item]);
      const local = planetQueue(this.data.constructionQueue, this.context.planetId), total = { metal: 0, crystal: 0, deuterium: 0 };
      for (const entry of local) if (entry.costs) for (const key of resourceKeys) total[key] += entry.costs[key];
      this.message(`${info.name} ajouté à la file de cette planète. ${constructionEstimate(local.every((entry) => entry.costs) ? total : undefined, economy).text}.`);
    }
    showUpdate(latest) {
      const badge = this.updateBadge;
      if (!badge) return;
      const newer = Boolean(latest) && compareVersions(latest, VERSION) > 0;
      badge.hidden = !newer;
      if (newer) {
        badge.textContent = `Mise \xE0 jour ${latest}`;
        badge.title = `Version install\xE9e : ${VERSION}. Cliquer ouvre le fichier publi\xE9 : Tampermonkey propose alors la mise \xE0 jour.`;
      }
    }
    async refreshUpdate(force = false) {
      try {
        const result = await checkForUpdate({ force });
        this.showUpdate(result.latest);
        return result;
      } catch (error) {
        if (force) throw new Error(`V\xE9rification des mises \xE0 jour impossible : ${error instanceof Error ? error.message : error}`);
        return null;
      }
    }
    expeditionConfig() { return { ...defaultExpeditionConfig(), ...readJSON(`${this.store.key}:expedition-config`, {}) }; }
    expeditionState() { return readJSON(`${this.store.key}:expedition-state`, {}); }
    setExpeditionState(patch) {
      const next = { ...this.expeditionState(), ...patch };
      localStorage.setItem(`${this.store.key}:expedition-state`, JSON.stringify(next));
      this.updateExpeditionStatus();
      return next;
    }
    logExpedition(text, ok = true) {
      const log = [{ at: Date.now(), text, ok }, ...(this.expeditionState().log ?? [])].slice(0, 15);
      this.setExpeditionState({ log });
    }
    // Results of the last 7 days, kept apart from the reports themselves (which the player may delete).
    expeditionResults() {
      const since = Date.now() - EXPEDITION_STATS_DAYS * 864e5;
      return readJSON(`${this.store.key}:expedition-results`, []).filter((r) => r.at >= since);
    }
    async collectExpeditionResults() {
      const since = Date.now() - EXPEDITION_STATS_DAYS * 864e5, known = this.expeditionResults();
      const fresh = await fetchExpeditionReports(new Set(known.map((r) => r.id)), since);
      const results = [...fresh, ...known].sort((a, b) => b.at - a.at).slice(0, 2e3);
      localStorage.setItem(`${this.store.key}:expedition-results`, JSON.stringify(results));
      return { results, fresh: fresh.length };
    }
    // Returns the new target when the current system is exhausted, otherwise null.
    async exhaustedSystemSwitch(target, results) {
      const current = systemStats(results, target.galaxy, target.system);
      if (current.count < EXPEDITION_SWITCH_MIN || current.ratio < EXPEDITION_SWITCH_RATIO) return null;
      const max = await universeSystemCount();
      const candidates = [target.system + EXPEDITION_SWITCH_STEP, target.system - EXPEDITION_SWITCH_STEP].filter((s) => s >= 1 && s <= max)
        .map((s) => systemStats(results, target.galaxy, s))
        // Least exhausted neighbour first (no data counts as fresh); +10 wins a tie.
        .sort((a, b) => a.ratio - b.ratio || Number(b.system.split(":")[1]) - Number(a.system.split(":")[1]));
      if (!candidates.length) return null;
      const [galaxy, system] = candidates[0].system.split(":").map(Number);
      return { galaxy, system, current };
    }
    // Called every second by the automation clock; does real work only when a check is due.
    monitorExpeditions() {
      if (window.top !== window.self || !this.context || this.expeditionBusy) return;
      const config = this.expeditionConfig(), state = this.expeditionState(), now = Date.now();
      if (!config.enabled || (state.nextCheckAt ?? 0) > now) return;
      const leaseKey = `${this.store.key}:expedition-lease`, lease = readJSON(leaseKey);
      if (lease.owner && lease.owner !== this.campaignTabId && now - (lease.at ?? 0) < 9e4) return;
      // Fleet-page work of other features (campaign send, auto-eject) goes first.
      const ejectJob = readJSON(`${this.store.key}:eject-job`);
      if (this.campaign?.pending || ["preparing", "pending"].includes(ejectJob.status)) { this.setExpeditionState({ nextCheckAt: now + 6e4, message: "Autre envoi de flotte en cours \xB7 nouvel essai dans 1 min." }); return; }
      localStorage.setItem(leaseKey, JSON.stringify({ owner: this.campaignTabId, at: now }));
      void this.runExpeditionCycle({ send: true });
    }
    async runExpeditionCycle({ send }) {
      if (this.expeditionBusy) return;
      this.expeditionBusy = true;
      const config = this.expeditionConfig();
      try {
        const planet = ownedPlanets().find((p) => p.id === config.planetId);
        if (!planet) throw new Error("Choisissez une plan\xE8te de d\xE9part dans l’onglet Exp\xE9ditions.");
        let target = config.target ? parseSystem(config.target) : { galaxy: planet.coords.galaxy, system: planet.coords.system };
        // Read the latest expedition reports, then move away from an exhausted system before sending.
        try {
          this.setExpeditionState({ message: "Lecture des rapports d’exp\xE9dition…" });
          const { results, fresh } = await this.collectExpeditionResults();
          if (fresh) this.logExpedition(`${fresh} nouveau(x) rapport(s) d’exp\xE9dition analys\xE9(s).`);
          const next = config.autoSwitch !== false ? await this.exhaustedSystemSwitch(target, results) : null;
          if (next) {
            const text = `${next.galaxy}:${next.system}`;
            localStorage.setItem(`${this.store.key}:expedition-config`, JSON.stringify({ ...this.expeditionConfig(), target: text }));
            this.logExpedition(`Syst\xE8me ${next.current.system} \xE9puis\xE9 (${next.current.empty}/${next.current.count} sans gain sur ${EXPEDITION_STATS_DAYS} j) → passage en ${text}.`);
            target = { galaxy: next.galaxy, system: next.system };
          }
        } catch (error) {
          this.logExpedition(`Rapports d’exp\xE9dition non lus : ${error instanceof Error ? error.message : error}`, false);
        }
        const fleet = Object.fromEntries(Object.entries(config.ships ?? {}).map(([id, count]) => [id, Math.max(0, Math.floor(Number(count) || 0))]).filter(([, count]) => count > 0));
        if (send && !Object.keys(fleet).length) throw new Error("Aucun vaisseau configur\xE9 pour les exp\xE9ditions.");
        this.setExpeditionState({ message: "Lecture de la page flotte…" });
        const snapshot = await fetchFleetSnapshot(planet.id);
        const p = snapshot.planet;
        if (p.galaxy !== planet.coords.galaxy || p.system !== planet.coords.system || p.position !== planet.coords.position || (p.type === 3) !== (planet.coords.type === "moon"))
          throw new Error(`OGame a ouvert ${p.name ?? "une autre plan\xE8te"} [${p.galaxy}:${p.system}:${p.position}] au lieu de ${planetLabel(planet)}.`);
        const reserved = Math.max(0, Number(this.data.settings.reservedFleetSlots ?? 1) || 0);
        const limit = config.maxConcurrent > 0 ? Math.min(config.maxConcurrent, snapshot.maxExpeditionCount) : snapshot.maxExpeditionCount;
        let free = Math.max(0, Math.min(limit - snapshot.expeditionCount, snapshot.maxFleetCount - reserved - snapshot.fleetCount));
        let token = snapshot.token, sent = 0, stop = "";
        const ships = { ...snapshot.ships };
        while (send && free > 0) {
          const missing = Object.entries(fleet).filter(([id, count]) => (ships[id] ?? 0) < count).map(([id, count]) => `${count - (ships[id] ?? 0)} ${EXPEDITION_SHIPS.find(([sid]) => String(sid) === id)?.[1] ?? id}`);
          if (missing.length) { stop = `Vaisseaux insuffisants sur ${planetLabel(planet)} : il manque ${missing.join(", ")}.`; break; }
          const result = await sendExpeditionFleet({ planetId: planet.id, token, galaxy: target.galaxy, system: target.system, ships: fleet, speed: config.speed, holdingTime: config.holdingTime });
          if (!result.ok) { stop = `OGame a refus\xE9 l’exp\xE9dition : ${result.message}`; this.logExpedition(stop, false); break; }
          this.logExpedition(`Exp\xE9dition envoy\xE9e vers [${target.galaxy}:${target.system}:16] depuis ${planetLabel(planet)}.`);
          for (const [id, count] of Object.entries(fleet)) ships[id] = (ships[id] ?? 0) - count;
          sent += 1; free -= 1;
          if (!result.newToken) break;
          token = result.newToken;
          await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1500));
        }
        const movements = await fetchExpeditionMovements();
        const expeditionCount = snapshot.expeditionCount + sent, fleetCount = snapshot.fleetCount + sent;
        const why = stop || (send && !sent ? (expeditionCount >= limit ? "Toutes les exp\xE9ditions autoris\xE9es sont en cours." : "Pas de slot de flotte libre (r\xE9serve comprise).") : "");
        const now = Date.now();
        this.setExpeditionState({
          lastCheckAt: now, nextCheckAt: send ? nextExpeditionCheck(movements, now) : this.expeditionState().nextCheckAt,
          counts: { expeditionCount, maxExpeditionCount: snapshot.maxExpeditionCount, fleetCount, maxFleetCount: snapshot.maxFleetCount, reserved, limit },
          shipsByPlanet: { ...this.expeditionState().shipsByPlanet, [planet.id]: { at: now, available: ships } }, movements, error: null,
          message: sent ? `${sent} exp\xE9dition(s) envoy\xE9e(s).${why ? ` ${why}` : ""}` : why || "Contr\xF4le termin\xE9."
        });
        if (stop && !stop.startsWith("OGame")) this.logExpedition(stop, false);
        // A manual check refreshes the "Disponible" hints next to the ship fields.
        if (!send && this.activeTab === "Exp\xE9ditions") this.render();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setExpeditionState({ lastCheckAt: Date.now(), nextCheckAt: send ? Date.now() + 10 * 6e4 : this.expeditionState().nextCheckAt, error: message, message: `Erreur : ${message}` });
        if (send) this.logExpedition(message, false);
      } finally {
        this.expeditionBusy = false;
        const leaseKey = `${this.store.key}:expedition-lease`;
        if (readJSON(leaseKey).owner === this.campaignTabId) localStorage.removeItem(leaseKey);
      }
    }
    // « Disponible » hints for one planet: last reading if known, « inconnu » otherwise; a missing or
    // old reading is fetched in the background, then the hints refresh if that planet is still selected.
    showExpeditionShips(planetId, hints, selected = () => planetId) {
      const nodes = Object.entries(hints);
      const paint = (text, title = "", warn = false) => { for (const [, node] of nodes) { node.textContent = text; node.title = title; node.classList.toggle("warn", warn); } };
      if (!planetId) return paint("Disponible : choisissez une plan\xE8te de d\xE9part");
      const entry = this.expeditionState().shipsByPlanet?.[planetId];
      if (entry) for (const [id, node] of nodes) {
        node.textContent = `Disponible : ${fmt(entry.available?.[id] ?? 0)}`;
        node.title = `Relev\xE9 le ${new Date(entry.at).toLocaleString("fr-FR")}`;
        node.classList.remove("warn");
      }
      else paint("Disponible : inconnu");
      if (entry && Date.now() - entry.at < EXPEDITION_SHIPS_MAX_AGE) return;
      if (this.expeditionShipsLoading?.has(planetId)) { if (!entry) paint("Disponible : inconnu \xB7 lecture en cours…"); return; }
      if (Date.now() - (this.expeditionShipsFailures?.[planetId]?.at ?? 0) < 6e4) {
        if (!entry) paint("Disponible : inconnu \xB7 lecture impossible", this.expeditionShipsFailures[planetId].message, true);
        return;
      }
      if (!entry) paint("Disponible : inconnu \xB7 lecture en cours…");
      const refresh = () => { if (nodes[0]?.[1].isConnected && selected() === planetId) this.showExpeditionShips(planetId, hints, selected); };
      void this.readExpeditionShips(planetId).then(refresh, refresh);
    }
    async readExpeditionShips(planetId) {
      (this.expeditionShipsLoading ??= new Set()).add(planetId);
      try {
        const planet = ownedPlanets().find((p) => p.id === planetId);
        const snapshot = await fetchFleetSnapshot(planetId), p = snapshot.planet;
        if (planet && (p.galaxy !== planet.coords.galaxy || p.system !== planet.coords.system || p.position !== planet.coords.position || (p.type === 3) !== (planet.coords.type === "moon")))
          throw new Error(`OGame a ouvert ${p.name ?? "une autre plan\xE8te"} au lieu de ${planetLabel(planet)}.`);
        this.setExpeditionState({ shipsByPlanet: { ...this.expeditionState().shipsByPlanet, [planetId]: { at: Date.now(), available: snapshot.ships } } });
        if (this.expeditionShipsFailures) delete this.expeditionShipsFailures[planetId];
      } catch (error) {
        (this.expeditionShipsFailures ??= {})[planetId] = { at: Date.now(), message: error instanceof Error ? error.message : String(error) };
        throw error;
      } finally {
        this.expeditionShipsLoading.delete(planetId);
        // Reading another planet's fleet page makes it OGame's active planet: switch back to the one on screen.
        if (this.context?.planetId && planetId !== this.context.planetId) await fetch(gameURL({ page: "componentOnly", component: "eventList", ajax: 1, cp: this.context.planetId }), { credentials: "include", cache: "no-store" }).catch(() => {});
      }
    }
    expeditions() {
      const config = this.expeditionConfig();
      const planets = ownedPlanets();
      const card = this.card("Exp\xE9ditions automatiques");
      card.append(element("p", "Les exp\xE9ditions partent en position 16 du syst\xE8me choisi, avec la flotte d\xE9finie ci-dessous. D\xE8s qu’une exp\xE9dition revient et lib\xE8re un slot, une nouvelle est relanc\xE9e. Le contr\xF4le n’a lieu qu’au retour pr\xE9vu des flottes (au plus une fois par heure sinon). Les slots r\xE9serv\xE9s des Param\xE8tres restent libres."));
      const form = element("form"), grid = element("div");
      grid.className = "grid";
      const enabled = this.select(grid, "Automatique", "enabled", [["off", "D\xE9sactiv\xE9e"], ["on", "Activ\xE9e"]], config.enabled ? "on" : "off");
      const origin = this.select(grid, "Plan\xE8te de d\xE9part", "planetId", [["", "— Choisir —"], ...planets.map((planet) => [planet.id, planetLabel(planet)])], config.planetId);
      const target = this.field(grid, "Syst\xE8me cible (galaxie:syst\xE8me)", "target", config.target ?? "");
      target.placeholder = "Celui de la plan\xE8te de d\xE9part";
      const holding = this.select(grid, "Dur\xE9e sur place", "holdingTime", Array.from({ length: 16 }, (_, i) => [String(i + 1), `${i + 1} h`]), String(config.holdingTime));
      const speed = this.select(grid, "Vitesse", "speed", Array.from({ length: 10 }, (_, i) => [String(100 - i * 10), `${100 - i * 10} %`]), String(config.speed));
      const concurrent = this.select(grid, "Exp\xE9ditions simultan\xE9es", "maxConcurrent", [["0", "Maximum autoris\xE9 par OGame"], ...Array.from({ length: 12 }, (_, i) => [String(i + 1), String(i + 1)])], String(config.maxConcurrent ?? 0));
      const autoSwitch = this.select(grid, "Syst\xE8me \xE9puis\xE9", "autoSwitch", [["on", `Changer (\xB1${EXPEDITION_SWITCH_STEP})`], ["off", "Ne pas changer"]], config.autoSwitch === false ? "off" : "on");
      autoSwitch.title = `Sur ${EXPEDITION_STATS_DAYS} jours glissants : si au moins ${EXPEDITION_SWITCH_MIN} exp\xE9ditions vers ce syst\xE8me sont connues et qu’au moins la moiti\xE9 n’a rien rapport\xE9, la cible passe au syst\xE8me voisin \xE0 \xB1${EXPEDITION_SWITCH_STEP} le moins \xE9puis\xE9.`;
      form.append(grid);
      form.append(element("h2", "Flotte envoy\xE9e \xE0 chaque exp\xE9dition"));
      const shipsGrid = element("div");
      shipsGrid.className = "grid ships";
      const inputs = {}, hints = {};
      for (const [id, name] of EXPEDITION_SHIPS) {
        const input = this.field(shipsGrid, name, `am${id}`, String(config.ships?.[id] ?? ""), "number");
        input.min = "0"; input.step = "1"; input.placeholder = "0";
        hints[id] = element("small");
        input.parentElement.append(hints[id]);
        inputs[id] = input;
      }
      form.append(shipsGrid);
      // « Disponible » always follows the departure planet selected in the form (saved or not).
      const showAvailability = () => this.showExpeditionShips(origin.value, hints, () => origin.value);
      origin.addEventListener("change", showAvailability);
      showAvailability();
      const actions = element("div");
      actions.className = "btns";
      // Reads and validates the form as it is on screen (saved or not).
      const readForm = ({ needShips }) => {
        const ships = {};
        for (const [id, input] of Object.entries(inputs)) { const count = Math.floor(Number(input.value) || 0); if (count < 0) throw new Error("Les quantit\xE9s de vaisseaux doivent \xEAtre positives."); if (count) ships[id] = count; }
        const targetText = target.value.trim();
        if (targetText) parseSystem(targetText);
        const next = { enabled: enabled.value === "on", planetId: origin.value, target: targetText, holdingTime: Number(holding.value), speed: Number(speed.value), maxConcurrent: Number(concurrent.value), ships, autoSwitch: autoSwitch.value === "on" };
        if ((next.enabled || needShips) && !next.planetId) throw new Error("Choisissez une plan\xE8te de d\xE9part.");
        if ((next.enabled || needShips) && !Object.keys(ships).length) throw new Error("Indiquez au moins un vaisseau \xE0 envoyer.");
        return next;
      };
      const persist = (next) => {
        const wasEnabled = config.enabled;
        localStorage.setItem(`${this.store.key}:expedition-config`, JSON.stringify(next));
        if (next.enabled) this.setExpeditionState({ nextCheckAt: Date.now() + 3e3, message: wasEnabled ? "Configuration mise \xE0 jour \xB7 contr\xF4le imm\xE9diat." : "Exp\xE9ditions automatiques activ\xE9es \xB7 premier contr\xF4le dans quelques secondes." });
        else this.setExpeditionState({ nextCheckAt: null, message: "Exp\xE9ditions automatiques d\xE9sactiv\xE9es." });
      };
      const save = element("button", "Enregistrer");
      save.type = "submit";
      save.className = "plain";
      // Two-step confirmation inside the panel: native confirm() dialogs can be blocked or auto-dismissed.
      const launch = this.button("Envoyer maintenant", () => {
        if (launch.dataset.armed !== "1") {
          readForm({ needShips: true });
          launch.dataset.armed = "1";
          launch.textContent = "Confirmer l’envoi";
          launch.classList.add("danger");
          clearTimeout(this.expeditionArmTimer);
          this.expeditionArmTimer = setTimeout(() => { if (launch.isConnected) { launch.dataset.armed = ""; launch.textContent = "Envoyer maintenant"; launch.classList.remove("danger"); } }, 6e3);
          return;
        }
        clearTimeout(this.expeditionArmTimer);
        const next = readForm({ needShips: true });
        persist(next);
        this.message(next.enabled ? "Configuration enregistr\xE9e \xB7 envoi en cours…" : "Envoi ponctuel en cours (automatique d\xE9sactiv\xE9)…");
        this.render();
        return this.runExpeditionCycle({ send: true });
      });
      launch.title = "Envoie tout de suite les exp\xE9ditions possibles avec les valeurs affich\xE9es (elles sont enregistr\xE9es).";
      launch.className = "launch";
      const refresh = this.button("Actualiser l’\xE9tat", () => this.runExpeditionCycle({ send: false }));
      refresh.title = "Relit les slots, les vaisseaux disponibles et les retours pr\xE9vus dans OGame. N’envoie rien.";
      actions.append(save, refresh);
      form.append(actions, launch);
      form.append(element("small", "Enregistrer : garde la configuration (et d\xE9marre l’automatique si \xAB Activ\xE9e \xBB). Actualiser l’\xE9tat : relit les slots, les vaisseaux et les retours, sans rien envoyer. Envoyer maintenant : envoi imm\xE9diat, m\xEAme si l’automatique est d\xE9sactiv\xE9e."));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.guarded(() => {
          persist(readForm({ needShips: false }));
          this.message("Configuration des exp\xE9ditions enregistr\xE9e.");
          this.render();
        });
      });
      card.append(form);
      const status = this.card("\xC9tat des exp\xE9ditions");
      this.expeditionStatusHost = element("div");
      status.append(this.expeditionStatusHost);
      this.updateExpeditionStatus();
    }
    updateExpeditionStatus() {
      const host = this.expeditionStatusHost;
      if (!host?.isConnected) return;
      const state = this.expeditionState(), config = this.expeditionConfig(), counts = state.counts;
      const rows = [
        ["Automatique", config.enabled ? "Activ\xE9e" : "D\xE9sactiv\xE9e"],
        ["Exp\xE9ditions", counts ? `${counts.expeditionCount} / ${counts.maxExpeditionCount}${counts.limit < counts.maxExpeditionCount ? ` (limite ${counts.limit})` : ""}` : "—"],
        ["Flottes", counts ? `${counts.fleetCount} / ${counts.maxFleetCount} \xB7 ${counts.reserved} r\xE9serv\xE9(s)` : "—"],
        ["Dernier contr\xF4le", state.lastCheckAt ? new Date(state.lastCheckAt).toLocaleString("fr-FR") : "—"],
        ["Prochain contr\xF4le", config.enabled && state.nextCheckAt ? (state.nextCheckAt <= Date.now() ? "imminent" : timeFR(state.nextCheckAt)) : "—"]
      ];
      const list = element("div");
      list.className = "stats";
      for (const [label, value] of rows) { const item = element("div"); item.append(element("small", label), element("strong", value)); list.append(item); }
      const nodes = [list];
      if (state.message) { const p = element("p", state.message); if (state.error) p.className = "warn"; nodes.push(p); }
      // Results of the last 7 days per system, current target first.
      const results = this.expeditionResults();
      const planet = ownedPlanets().find((p) => p.id === config.planetId);
      let current = null;
      try { current = config.target ? parseSystem(config.target) : planet ? { galaxy: planet.coords.galaxy, system: planet.coords.system } : null; } catch { current = null; }
      const currentKey = current ? `${current.galaxy}:${current.system}` : null;
      if (currentKey) { const item = element("div"); item.append(element("small", "Syst\xE8me cible"), element("strong", `[${currentKey}:16]`)); list.prepend(item); }
      const systems = [...new Set([currentKey, ...results.map((r) => r.system)].filter(Boolean))].slice(0, 8);
      if (systems.length) {
        const table = element("table"), head = element("tr");
        table.className = "exp-stats";
        for (const label of ["Syst\xE8me", "Exp\xE9d.", "Sans gain", "Taux", "\xC9puisement OGame"]) head.append(element("th", label));
        const thead = element("thead"); thead.append(head);
        const tbody = element("tbody");
        for (const key of systems) {
          const [g, s] = key.split(":").map(Number), stat = systemStats(results, g, s);
          const row = element("tr");
          if (key === currentKey) row.className = "current";
          const exhausted = stat.count >= EXPEDITION_SWITCH_MIN && stat.ratio >= EXPEDITION_SWITCH_RATIO;
          const rate = element("td", stat.count ? `${Math.round(stat.ratio * 100)} %` : "—");
          if (exhausted) rate.className = "warn";
          row.append(element("td", `[${key}]${key === currentKey ? " \xB7 cible" : ""}`), element("td", String(stat.count)), element("td", String(stat.empty)), rate, element("td", stat.depletion ? `niveau ${stat.depletion}` : "—"));
          tbody.append(row);
        }
        table.append(thead, tbody);
        nodes.push(element("h2", `R\xE9sultats sur ${EXPEDITION_STATS_DAYS} jours`), table, element("small", `Changement de syst\xE8me si ≥ ${EXPEDITION_SWITCH_MIN} exp\xE9ditions et ≥ ${Math.round(EXPEDITION_SWITCH_RATIO * 100)} % sans gain${config.autoSwitch === false ? " (d\xE9sactiv\xE9)" : ""}.`));
      }
      const flying = (state.movements ?? []).filter((fleet) => fleet.arrival > Date.now());
      if (flying.length) {
        const ul = element("ul");
        ul.className = "timeline";
        for (const fleet of flying) ul.append(element("li", `${fleet.returning ? "Retour" : "Arriv\xE9e"} \xE0 ${timeFR(fleet.arrival)}`));
        nodes.push(element("h2", "En vol"), ul);
      }
      if (state.log?.length) {
        const ul = element("ul");
        ul.className = "timeline";
        for (const entry of state.log.slice(0, 10)) { const li = element("li", `${timeFR(entry.at)} \xB7 ${entry.text}`); if (!entry.ok) li.className = "warn"; ul.append(li); }
        nodes.push(element("h2", "Journal"), ul);
      }
      host.replaceChildren(...nodes);
    }
    constructions() {
      const card = this.card("File de construction");
      if (!this.context) { card.append(element("p", "Ouvrez OGame pour gérer les files par planète.")); return; }
      const planets = new Map(ownedPlanets().map((planet) => [planet.id, planetLabel(planet)]));
      for (const item of this.data.constructionQueue ?? []) if (!planets.has(item.planetId)) planets.set(item.planetId, `Planète ${item.planetId}`);
      if (!planets.has(this.context.planetId)) planets.set(this.context.planetId, `Planète courante (${this.context.planetId})`);
      const planetId = this.constructionPlanetId ?? this.context.planetId;
      const selector = this.select(card, "File de la planète / lune", "constructionPlanet", [...planets], planetId);
      selector.addEventListener("change", () => { this.constructionPlanetId = selector.value; this.render(); });
      const state = this.constructionState(planetId), queue = planetQueue(this.data.constructionQueue ?? [], planetId);
      card.append(element("p", "Surveillance permanente : l’ajout suffit pour programmer une construction. Après deux minutes sans clic ni saisie, le script visite les planètes à tour de rôle, vérifie leurs ressources et lance ce qui est disponible. Aucun démarrage manuel n’est nécessaire."));
      card.append(element("p", state.message ?? "Contrôle automatique au prochain passage."));
      const economy = readJSON(`${this.store.key}:economies`)[planetId];
      if (economy) card.append(element("p", `Production / heure : métal ${economy.production?.metal ?? "inconnue"}, cristal ${economy.production?.crystal ?? "inconnue"}, deutérium ${economy.production?.deuterium ?? "inconnue"}. Données relevées le ${new Date(economy.at).toLocaleString("fr-FR")}.`));
      this.renderConstructionBars(card);
      if (!queue.length) card.append(element("p", "Aucune construction programmée."));
    }
    resumeCampaignAfterConstruction() {
      if (!this.campaign?.constructionPauseUntil || this.campaign.pending || this.campaign.runnerId !== this.campaignTabId) return;
      if (this.campaignTimer) clearTimeout(this.campaignTimer);
      this.campaignTimer = void 0;
      this.persistCampaign({ ...this.campaign, constructionPauseUntil: null });
      this.continueAutoAttacks();
    }
    homePlanetId() {
      return this.data.settings.homePlanetId || ownedPlanets().find((planet) => planet.coords.type !== "moon")?.id || this.campaign?.sourcePlanetId || this.context.planetId;
    }
    async monitorSlotCampaign() {
      if (!this.backgroundCoordinator || this.slotMonitorBusy) return;
      if (this.discoveryStarting || this.discoveryActive()) { document.getElementById("sephi-slots-worker")?.remove(); return; }
      const now = Date.now(), settings = this.data.settings;
      let frame = document.getElementById("sephi-slots-worker");
      if (settings.autoAttackMode !== "slots") { frame?.remove(); return; }
      const current = readJSON(this.campaignKey, this.campaign);
      if (current?.pending || current?.status === "running" && current.phase !== "wait") { frame?.remove(); return; }
      if (now < (current?.slotNextRunAt ?? 0)) return;
      const idle = () => Date.now() - Number(localStorage.getItem(`${this.store.key}:last-activity`) ?? Date.now()) >= (settings.attackIdleSeconds ?? 60) * 1000;
      if (!idle()) { frame?.remove(); return; }
      const home = this.homePlanetId();
      if (!ownedPlanets().some((planet) => planet.id === home && planet.coords.type !== "moon")) return;
      const eject = readJSON(`${this.store.key}:eject-job`);
      if (["preparing", "pending"].includes(eject.status)) return;
      const build = document.getElementById("sephi-construction-worker");
      if (build && this.constructionState(build.dataset.sephiPlanet).busy) return;
      const leaseKey = `${this.store.key}:slot-coordinator`, lease = readJSON(leaseKey);
      if (lease.owner && lease.owner !== this.campaignTabId && now - lease.at < 20000) return;
      localStorage.setItem(leaseKey, JSON.stringify({ owner: this.campaignTabId, at: now }));
      const snapshot = readJSON(`${this.store.key}:slot-snapshot`);
      const returningHome = readJSON(`${this.store.key}:slot-home`, null);
      const ownsSnapshot = frame ? snapshot.token === frame.dataset.sephiWorker : returningHome?.owner === this.campaignTabId && returningHome.expiresAt >= now && returningHome.token === snapshot.token;
      if (ownsSnapshot && snapshot.planetId === home && now - snapshot.at < 30000) {
        frame?.remove(); frame = null;
        const free = snapshot.maxFleetCount - snapshot.fleetCount - (settings.reservedFleetSlots ?? 1);
        if (!Number.isSafeInteger(snapshot.fleetCount) || snapshot.fleetCount < 0 || !Number.isSafeInteger(snapshot.maxFleetCount) || !Number.isSafeInteger(free) || free < (settings.freeSlotsTrigger ?? 3) || !idle()) {
          localStorage.removeItem(`${this.store.key}:slot-home`);
          return;
        }
        this.campaign = readJSON(this.campaignKey, this.campaign);
        if (this.campaign?.pending || this.campaign?.status === "running" && this.campaign.phase !== "wait") return;
        if (!this.data.targets.some((target) => target.enabled && !target.ignore)) return;
        if (this.context.planetId !== home) {
          localStorage.setItem(`${this.store.key}:slot-home`, JSON.stringify({ owner: this.campaignTabId, planetId: home, token: snapshot.token, expiresAt: now + 30000 }));
          showPreparation("Retour sur la planète mère avant le lancement de la campagne.");
          const url = new URL("/game/index.php", location.href);
          url.searchParams.set("page", "ingame"); url.searchParams.set("component", "overview"); url.searchParams.set("cp", home);
          location.href = url.href;
          return;
        }
        localStorage.removeItem(`${this.store.key}:slot-home`);
        this.slotMonitorBusy = true;
        try {
          campaignLog("Lancement par slots libres et inactivité", { home, free, idleSeconds: settings.attackIdleSeconds });
          if (this.campaign?.status === "running" && this.campaign.phase === "wait") await this.beginNextAutoAttackRound();
          else await this.startAutoAttacks(true);
        } finally { this.slotMonitorBusy = false; }
        return;
      }
      if (frame) {
        if (now - Number(frame.dataset.startedAt) < 15000) return;
        frame.remove();
      }
      if (now - (this.lastSlotCheck ?? 0) < 15000) return;
      this.lastSlotCheck = now;
      frame = document.createElement("iframe");
      const token = crypto.randomUUID?.() ?? `${now}-${Math.random()}`;
      frame.id = "sephi-slots-worker"; frame.hidden = true; frame.dataset.sephiWorker = token; frame.dataset.startedAt = String(now);
      frame.title = "Surveillance des slots de flotte";
      const url = new URL("/game/index.php", location.href);
      url.searchParams.set("page", "ingame"); url.searchParams.set("component", "fleetdispatch"); url.searchParams.set("cp", home); url.searchParams.set("sephiSlotsWorker", token);
      frame.src = url.href;
      document.body.append(frame);
    }
    syncConstructionWorker() {
      if (this.discoveryStarting || this.discoveryActive()) { this.lastConstructionCheck = Date.now(); return; }
      if (document.getElementById("sephi-slots-worker")) return;
      const now = Date.now(), lastActivity = Number(localStorage.getItem(`${this.store.key}:last-activity`) ?? now);
      const campaign = readJSON(this.campaignKey ?? `${this.store.key}:auto-attack`, this.campaign);
      if (campaign?.status === "running" && campaign.phase !== "wait" || campaign?.pending) {
        this.lastConstructionCheck = now;
        this.constructionVisitReady = false;
        const frame = document.getElementById("sephi-construction-worker");
        if (frame) {
          const state = this.constructionState(frame.dataset.sephiPlanet);
          if (!state.pending) {
            frame.remove();
            this.setConstructionState({ ...state, busy: false, message: "Campagne active · contrôle reporté." }, frame.dataset.sephiPlanet);
          }
        }
        if (!this.constructionSuspendedForCampaign) showPreparation("Rotation des planètes suspendue pendant le cycle d’auto-attaque.");
        this.constructionSuspendedForCampaign = true;
        return;
      }
      this.constructionSuspendedForCampaign = false;
      const leaseKey = `${this.store.key}:construction-coordinator`, lease = readJSON(leaseKey);
      if (lease.owner && lease.owner !== this.campaignTabId && now - lease.at < 15000) return;
      localStorage.setItem(leaseKey, JSON.stringify({ owner: this.campaignTabId, at: now }));
      const existing = document.getElementById("sephi-construction-worker");
      if (existing) {
        const active = this.constructionState(existing.dataset.sephiPlanet);
        if (active.busy && now - (active.busySince ?? active.checkedAt ?? now) < 45000) return;
      }
      const ejectJob = readJSON(`${this.store.key}:eject-job`);
      if (["preparing", "pending"].includes(ejectJob.status) || this.campaign?.pending) return;
      const queue = this.store.load().constructionQueue;
      const candidates = [...new Set([...ownedPlanets().map((planet) => planet.id), ...queue.map((item) => item.planetId), this.context.planetId])].filter(Boolean)
        .sort((a, b) => (this.constructionState(a).checkedAt ?? 0) - (this.constructionState(b).checkedAt ?? 0));
      if (!candidates.length) return;
      const planetId = this.constructionVisitReady && candidates.includes(this.context.planetId) ? this.context.planetId : candidates[0], state = this.constructionState(planetId);
      const lastCheck = this.constructionVisitReady ? now - 120000 : this.lastConstructionCheck ?? now;
      const remaining = Math.ceil(Math.max(0, 120000 - (now - lastActivity), 120000 - (now - lastCheck)) / 1000);
      showPreparation(`Contrôle de la file de la planète ${planetLabelById(planetId)} dans ${remaining} s sans activité. Un clic reporte le changement de deux minutes.`);
      if (!idleCheckAllowed(lastActivity, lastCheck, now)) return;
      if (planetId !== this.context.planetId) {
        showPreparation(`Changement vers la planète ${planetLabelById(planetId)} pour vérifier sa file et ses ressources.`);
        sessionStorage.setItem(`${this.store.key}:construction-visit`, JSON.stringify({ planetId, owner: this.campaignTabId, expiresAt: now + 60000 }));
        const url = new URL("/game/index.php", location.href);
        url.searchParams.set("page", "ingame");
        url.searchParams.set("component", "overview");
        url.searchParams.set("cp", planetId);
        location.href = url.href;
        return;
      }
      this.constructionVisitReady = false;
      existing?.remove();
      const item = planetQueue(queue, planetId)[0];
      this.lastConstructionCheck = now;
      const token = crypto.randomUUID?.() ?? `${now}-${Math.random()}`;
      this.setConstructionState({ ...state, running: true, owner: this.campaignTabId, token, busy: Boolean(item), busySince: now, checkedAt: now, message: item ? "Contrôle automatique des ressources et du chantier." : "Planète vérifiée · aucune construction programmée." }, planetId);
      if (!item) { capturePlanetEconomy(this.store.key, this.context); this.resumeCampaignAfterConstruction(); return; }
      showPreparation(`Vérification de la file et des ressources de la planète ${planetLabelById(planetId)}.`);
      const frame = document.createElement("iframe");
      frame.id = "sephi-construction-worker";
      frame.dataset.sephiWorker = token;
      frame.dataset.sephiPlanet = planetId;
      frame.hidden = true;
      frame.title = "File de construction SephiOGame";
      frame.addEventListener("load", () => {
        try {
          const url = new URL(frame.contentWindow.location.href);
          // Native building launches can navigate to a URL without our marker.
          if (url.origin === location.origin && url.pathname === "/game/index.php" && !url.searchParams.has("sephiBuildWorker") && this.constructionState(planetId).running && this.constructionState(planetId).pending) {
            url.searchParams.set("sephiBuildWorker", token);
            frame.src = url.href;
          }
        } catch { /* Startup watchdog reports unavailable native frames. */ }
      });
      frame.src = constructionURL(item, token);
      document.body.append(frame);
      setTimeout(() => {
        const current = this.constructionState(planetId);
        if (frame.isConnected && !frame.dataset.sephiReady && current.token === token) this.setConstructionState({ ...current, running: true, busy: false, message: "Moteur de construction indisponible · nouvel essai au prochain passage." }, planetId);
      }, 20000);
    }
    installNativeEnhancements() {
      const activityKey = `${this.store.key}:last-activity`;
      let visit;
      try { visit = JSON.parse(sessionStorage.getItem(`${this.store.key}:construction-visit`)); } catch { /* A manual visit starts a new idle minute. */ }
      sessionStorage.removeItem(`${this.store.key}:construction-visit`);
      this.constructionVisitReady = visit?.owner === this.campaignTabId && visit.planetId === this.context.planetId && visit.expiresAt >= Date.now();
      const slotHome = readJSON(`${this.store.key}:slot-home`);
      const returningHome = slotHome.owner === this.campaignTabId && slotHome.planetId === this.context.planetId && slotHome.expiresAt >= Date.now();
      if (!this.constructionVisitReady && !returningHome) localStorage.setItem(activityKey, String(Date.now()));
      this.lastConstructionCheck = Date.now();
      const noteActivity = () => localStorage.setItem(activityKey, String(Date.now()));
      document.addEventListener("click", noteActivity, true);
      document.addEventListener("keydown", noteActivity, true);
      document.addEventListener("input", noteActivity, true);
      const release = () => {
        const lease = readJSON(`${this.store.key}:construction-coordinator`);
        if (lease.owner === this.campaignTabId) localStorage.removeItem(`${this.store.key}:construction-coordinator`);
      };
      window.addEventListener("pagehide", release, { once: true });
      // Migrate the old shared runner to the planet owning its first item.
      const legacy = readJSON(`${this.store.key}:construction-state`), first = this.data.constructionQueue[0];
      if (first && (legacy.running || legacy.pending)) {
        const targetKey = constructionStateKey(this.store.key, first.planetId);
        if (!localStorage.getItem(targetKey)) localStorage.setItem(targetKey, JSON.stringify({ ...legacy, running: true, busy: false, message: "Ancienne file importée · suivi automatique." }));
        localStorage.removeItem(`${this.store.key}:construction-state`);
      }
      const updateCountdown = () => {
        const text = nextAttackText(this.campaign);
        const counter = this.shadow.querySelector("[data-sephi-countdown]");
        if (counter && counter.textContent !== text) counter.textContent = text;
        if (this.context.page !== "overview") return;
        let host = document.getElementById("sephi-next-attack");
        if (!host) {
          host = element("div");
          host.id = "sephi-next-attack";
          host.dataset.sephiToolbar = "";
          host.style.cssText = "padding:10px;margin:10px 0;border:1px solid #42617c;background:#142638;color:#bfe3ee;font:14px system-ui";
          (document.querySelector("#overviewcomponent, #pageContent #middle, #content") ?? document.body).prepend(host);
        }
        if (host.textContent !== text) host.textContent = text;
      };
      updateCountdown();
      const clock = setInterval(() => {
        for (const task of [updateCountdown, () => { void this.monitorDiscovery().catch((error) => { const scan = this.discoveryState(); if (scan?.status === "running") this.saveDiscovery({ ...scan, status: "paused", message: String(error) }); }); }, () => { void this.monitorSlotCampaign().catch((error) => campaignLog("Surveillance des slots interrompue", { error: String(error) })); }, () => this.syncConstructionWorker(), () => this.monitorExpeditions(), () => this.monitorAutoEject(), () => this.updateConstructionEstimates()]) {
          try { task(); }
          catch (error) {
            if (Date.now() - (this.lastAutomationError ?? 0) >= 30000) {
              this.lastAutomationError = Date.now();
              campaignLog("Contrôle automatique interrompu; nouvel essai au prochain passage", { error: String(error) });
            }
          }
        }
      }, 1000);
      window.addEventListener("pagehide", () => clearInterval(clock), { once: true });
      window.addEventListener("storage", (event) => {
        if (!event.key?.startsWith(`${this.store.key}:construction-state:`)) return;
        const state = readJSON(event.key);
        if (!state.busy) this.resumeCampaignAfterConstruction();
        if (this.activeTab === "Constructions") this.render();
        this.scanNativeEnhancements();
      });
      capturePlanetEconomy(this.store.key, this.context);
    }
    updateConstructionEstimates() {
      const economies = readJSON(`${this.store.key}:economies`), estimates = new Map();
      const queue = this.data.constructionQueue ?? [];
      for (const planetId of new Set(queue.map((item) => item.planetId))) {
        const costs = { metal: 0, crystal: 0, deuterium: 0 };
        let known = true;
        for (const item of planetQueue(queue, planetId)) {
          if (!item.costs) known = false;
          else for (const key of resourceKeys) costs[key] += item.costs[key];
          estimates.set(item.id, constructionEstimate(known ? costs : undefined, economies[planetId]));
        }
      }
      for (const node of [...document.querySelectorAll("[data-sephi-estimate]"), ...this.shadow.querySelectorAll("[data-sephi-estimate]")]) {
        const estimate = estimates.get(node.dataset.sephiEstimate);
        if (!estimate) continue;
        if (node.textContent !== estimate.text) node.textContent = estimate.text;
        node.title = resourceKeys.map((key) => `${key} manquant : ${estimate.missing[key] ?? "?"}`).join(" · ") + " · Délai de ressources, sous réserve du chantier et des éléments précédents.";
      }
    }
    scanNativeEnhancements() {
      renderReturningResources();
      if (["overview", "supplies", "facilities", "research", "shipyard", "defenses"].includes(this.context.page)) {
        const queue = planetQueue(this.data.constructionQueue ?? [], this.context.planetId), state = this.constructionState(this.context.planetId);
        let host = document.getElementById("sephi-construction-summary");
        const signature = JSON.stringify([queue, state.message, state.running, state.pending?.id]);
        if (!host) {
          host = element("section");
          host.id = "sephi-construction-summary";
          host.dataset.sephiToolbar = "";
          host.style.cssText = "box-sizing:border-box;clear:both;width:680px;max-width:100%;margin:3px auto 10px;color:#6f9fc8;font:12px Verdana,Arial,sans-serif";
        }
        // The old script used these same native visual blocks. Place the file
        // in normal flow after the image/grid, rather than above the page.
        const anchor = this.context.page === "supplies" ? document.getElementById("supplies") : this.context.page === "facilities" ? document.getElementById("facilities") : this.context.page === "overview" ? document.getElementById("planet") : document.getElementById("detailWrapper");
        const fallback = document.querySelector("#technologies, #planet, #technologydetails, #detail");
        const researchAnchor = this.context.page === "research" ? document.getElementById("planet") ?? document.getElementById("research") ?? document.getElementById("technologies") ?? anchor ?? fallback : null;
        const target = researchAnchor ?? anchor ?? fallback;
        if (researchAnchor) {
          if (researchAnchor.previousElementSibling !== host) researchAnchor.insertAdjacentElement("beforebegin", host);
        }
        else if (target && target.nextElementSibling !== host) target.insertAdjacentElement("afterend", host);
        else if (!host.isConnected) (document.querySelector("#pageContent #middle, #content") ?? document.body).append(host);
        if (host.dataset.signature !== signature) {
          host.dataset.signature = signature;
          host.replaceChildren();
          this.renderConstructionBars(host, this.context.planetId);
          const controls = element("div");
          controls.style.cssText = "display:flex;align-items:center;gap:10px;padding:4px 10px;font:11px Verdana,Arial,sans-serif";
          controls.append(element("span", `${queue.length} construction(s) programmée(s)`));
          const manage = this.button("File automatique · détails", () => { this.constructionPlanetId = this.context.planetId; this.open("Constructions"); });
          manage.style.cssText = "padding:0;border:0;background:none;color:#9cbed7;font:11px Verdana,Arial,sans-serif;text-decoration:underline;cursor:pointer";
          controls.append(manage);
          host.append(controls);
        }
      }
      if (!["supplies", "facilities", "research", "shipyard", "defenses"].includes(this.context.page)) return;
      if (this.context.page === "research") {
        const host = document.getElementById("sephi-construction-summary");
        const choices = new Map();
        for (const tile of document.querySelectorAll("[data-technology]")) {
          const technology = Number(tile.getAttribute("data-technology"));
          if (!Number.isSafeInteger(technology) || technology < 100 || technology >= 200) continue;
          const name = tile.querySelector(".technologyName, .name")?.textContent?.trim() || tile.getAttribute("title") || `Recherche ${technology}`;
          choices.set(technology, name);
        }
        if (host && choices.size) {
          document.querySelector("[data-sephi-program]")?.remove();
          let controls = host.querySelector("[data-sephi-research-program]");
          const signature = JSON.stringify([...choices]);
          if (!controls || controls.dataset.signature !== signature) {
            const previous = controls?.querySelector("select")?.value;
            controls?.remove();
            controls = element("div");
            controls.dataset.sephiResearchProgram = "";
            controls.dataset.signature = signature;
            controls.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px;background:#142638;border:1px solid #42617c";
            const select = this.select(controls, "Recherche à programmer sur cette planète", "researchTechnology", [...choices], previous ?? String(choices.keys().next().value));
            const button = this.button("Programmer la recherche", () => {
              const technology = Number(select.value), info = constructionDetail();
              this.addConstruction(info?.technology === technology ? info : { technology, name: choices.get(technology), detail: null });
            });
            button.className = "sephi-program-button";
            button.style.cssText = "position:static!important;display:block!important;visibility:visible!important;opacity:1!important;padding:8px 12px;background:#244359;color:#d2e6ef;border:1px solid #5b778b;cursor:pointer";
            controls.append(button);
            host.append(controls);
          }
          return;
        }
      }
      const info = constructionDetail();
      if (!info) { document.querySelector("[data-sephi-program]")?.remove(); return; }
      const existing = document.querySelector("[data-sephi-program]");
      if (existing?.dataset.sephiTechnology === String(info.technology) && existing.isConnected) return;
      existing?.remove();
      const button = this.button("Programmer", () => this.addConstruction(constructionDetail() ?? info));
      button.dataset.sephiProgram = "";
      button.dataset.sephiTechnology = String(info.technology);
      button.className = "sephi-program-button";
      button.textContent = `Programmer : ${info.name}`;
      button.style.cssText = "display:block!important;visibility:visible!important;opacity:1!important;position:static!important;box-sizing:border-box;width:100%;margin:4px 0;padding:8px 12px;background:#244359;color:#d2e6ef;border:1px solid #5b778b;border-radius:3px;text-align:left;font:bold 12px Verdana,Arial,sans-serif;cursor:pointer";
      const host = document.getElementById("sephi-construction-summary");
      if (host) host.append(button);
      else info.detail.insertAdjacentElement("afterend", button);
    }
    download(filename, text) {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" })), a = element("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    }
    backups() {
      const card = this.card("Sauvegardes locales");
      card.append(element("p", "Import fusionn\xE9 : les cibles d\xE9j\xE0 pr\xE9sentes sont conserv\xE9es. Les listes de programmation, productions et r\xE9glages d\u2019\xE9jection des fichiers historiques sont archiv\xE9s pour une migration ult\xE9rieure. Aucune donn\xE9e n\u2019est envoy\xE9e \xE0 un serveur."));
      card.append(this.button("Exporter JSON", () => this.download("SephiOGame-local.json", this.store.export(this.data))));
      const input = this.field(card, "Importer .json ou .sephiOGame", "import", "", "file");
      input.accept = ".json,.sephiOGame,text/plain,application/json";
      input.addEventListener("change", () => this.guarded(async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) throw new Error("Fichier sup\xE9rieur \xE0 10 Mo.");
        this.data = this.store.import(this.data, await file.text(), file.name);
        this.render();
        this.onChange();
        this.message("Import termin\xE9. Les cibles existantes ont \xE9t\xE9 conserv\xE9es.");
      }));
      const keys = this.store.legacyKeys();
      if (keys.length) {
        card.append(element("p", "Sauvegardes historiques trouv\xE9es sur cette origine. Choisissez la plan\xE8te \xE0 importer ; les cl\xE9s historiques restent intactes."));
        const select = this.select(card, "Cl\xE9 historique", "legacy", keys.map((k) => [k, k]), keys[0]);
        card.append(this.button("Importer cette plan\xE8te", () => {
          this.data = this.store.importLegacyKey(this.data, select.value);
          this.render();
          this.onChange();
          this.message("Sauvegarde historique import\xE9e.");
        }));
      } else card.append(element("p", "Aucune cl\xE9 historique sur cette origine. Utilisez un ancien export, ou ouvrez ce panneau dans OGame pour retrouver son localStorage."));
      card.append(element("p", `${this.data.legacyArchives.length} archives historiques conserv\xE9es dans les exports.`));
    }
    diagnostics() {
      const updates = this.card("Mises \xE0 jour");
      const info = element("p"), known = readJSON(UPDATE_KEY, {});
      const describe = (result) => {
        if (!result?.latest) return `Version install\xE9e : ${VERSION}. Aucune v\xE9rification pour l’instant.`;
        const cmp = compareVersions(result.latest, VERSION);
        return `Version install\xE9e : ${VERSION} \xB7 publi\xE9e : ${result.latest} (${cmp > 0 ? "mise \xE0 jour disponible" : cmp < 0 ? "version locale plus r\xE9cente" : "\xE0 jour"}) \xB7 v\xE9rifi\xE9 le ${new Date(result.checkedAt).toLocaleString("fr-FR")}.`;
      };
      info.textContent = describe(known);
      const link = element("a", "Ouvrir le fichier publi\xE9");
      link.className = "button";
      link.href = UPDATE_SOURCE; link.target = "_blank"; link.rel = "noopener noreferrer";
      const row = element("div");
      row.className = "btns";
      row.append(this.button("V\xE9rifier les mises \xE0 jour", async () => {
        info.textContent = "V\xE9rification…";
        const result = await this.refreshUpdate(true);
        info.textContent = describe(result);
      }), link);
      updates.append(info, row);
      const fleet = dispatcher();
      const gameWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const campaign = this.campaign;
      const diagnostic = {
        version: VERSION,
        mode: this.context ? "userscript" : "local",
        context: this.context ?? null,
        storageKey: this.store.key,
        schemaVersion: this.data.schemaVersion,
        targets: this.data.targets.length,
        archives: this.data.legacyArchives.length,
        capabilities: { localStorage: true, mutationObserver: typeof MutationObserver !== "undefined" },
        liveDOMVerified: false,
        discovery: this.discoveryDiagnostic(),
        campaign: campaign ? {
          status: campaign.status, phase: campaign.phase, message: campaign.message,
          index: campaign.index, targets: campaign.targetIds.length,
          attackIndex: campaign.attackIndex, attacks: campaign.attackIds?.length ?? 0,
          receivedReports: Object.keys(campaign.reports ?? {}).length,
          reportsLastProgressAt: campaign.reportsLastProgressAt ?? null,
          slotSnapshot: campaign.slotSnapshot ?? null, waiting: campaign.waiting ?? null,
          deferredIds: campaign.deferredIds ?? [],
          skippedTargets: campaign.skippedTargets ?? {},
          pending: campaign.pending ?? null, sourcePlanetId: campaign.sourcePlanetId,
          ownedByThisTab: campaign.runnerId === this.campaignTabId
        } : null,
        ogame: {
          dispatcherPresent: Boolean(fleet), currentFleetPage: fleet?.currentPage ?? null,
          fleetCount: fleet?.fleetCount ?? null, maxFleetCount: fleet?.maxFleetCount ?? null,
          shipsOnPlanet: fleet?.shipsOnPlanet?.map((ship) => ({ id: ship.id, number: ship.number })) ?? [],
          miniFleetTokenPresent: Boolean(gameWindow.miniFleetToken),
          nativeSpyFunctionPresent: typeof gameWindow.sendShipsWithPopup === "function",
          messageElements: document.querySelectorAll(selectors.reports).length
        },
        campaignLog: readCampaignLog(),
        campaignFailures: this.campaignFailureHistory(),
        automation: {
          reservedFleetSlots: this.data.settings.reservedFleetSlots,
          constructionStates: Object.fromEntries([...new Set(this.data.constructionQueue.map((item) => item.planetId))].map((id) => [id, { running: this.constructionState(id).running ?? false, pending: this.constructionState(id).pending ?? null, checkedAt: this.constructionState(id).checkedAt ?? null, message: this.constructionState(id).message ?? null }])),
          economies: readJSON(`${this.store.key}:economies`),
          autoEject: this.data.settings.autoEject,
          eject: (() => { const job = readJSON(`${this.store.key}:eject-job`); return { status: job.status ?? null, planetId: job.planetId ?? null, message: job.message ?? null, remaining: job.remaining ?? null }; })()
        }
      };
      const card = this.card("Diagnostic");
      card.append(element("pre", JSON.stringify(diagnostic, null, 2)), this.button("Exporter diagnostic", () => this.download("SephiOGame-diagnostic.json", JSON.stringify(diagnostic, null, 2))));
      card.append(element("p", "Le bouton SephiOGame et les donn\xE9es sont propres \xE0 ce compte. Les liens Raid PT/GT et Sonder pr\xE9parent les vaisseaux sur la page flotte ; l\u2019envoi se confirme dans OGame. Si un rapport n\u2019est pas reconnu, ouvrez sa version d\xE9taill\xE9e."));
    }
  };

  // src/main.ts
  function start() {
    if (document.getElementById("sephi-root")) return;
    const isOGame = /^s[^.]+\.ogame\.gameforge\.com$/.test(location.hostname);
    const context = getPlayerContext();
    if (isOGame && !context) {
      showPreparation("Compte non d\xE9tect\xE9. Ouvrez une page de votre univers apr\xE8s connexion.");
      return;
    }
    document.getElementById("sephi-fleet-notice")?.remove();
    const key = context ? `sephiogame:v4:${context.universe}:${context.playerId}` : "sephiogame:v4:local";
    if (isDiscoveryWorker()) {
      void runDiscoveryWorker();
      return { open() {} };
    }
    if (isSlotWorker()) {
      void runSlotWorker();
      return { open() {} };
    }
    if (isConstructionWorker()) {
      void runConstructionWorker();
      return { open() {} };
    }
    if (isEjectWorker()) {
      void runEjectWorker();
      return { open() {} };
    }
    let panel;
    try {
      panel = new Panel(new Storage(localStorage, key), context);
    } catch (error) {
      showPreparation(`${String(error)}. Sauvegarde ${key} conserv\xE9e ; le panneau ne peut pas \xEAtre ouvert.`);
      return;
    }
    if (!context) return panel;
    if (isCampaignWorker()) {
      window.frameElement.dataset.sephiReady = "1";
      campaignLog("Moteur en arrière-plan prêt", { page: context.page, phase: panel.campaign?.phase });
      if (panel.campaign?.status === "running" && panel.campaign.runnerId === panel.campaignTabId) {
        // Only the explicitly created same-origin coordinator frame may run.
        panel.handleAutoAttackNavigation().catch((error) => panel.campaign?.pending ? panel.recoverUncertainDispatch(String(error)) : panel.scheduleCampaignRetry(String(error)));
      }
      return panel;
    }
    panel.purgeUnavailableFuelTargets();
    try {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("Ouvrir SephiOGame", () => panel.open());
        GM_registerMenuCommand("Sauvegardes SephiOGame", () => panel.open("Sauvegardes"));
      }
    } catch (error) {
      console.warn("[SephiOGame] Menu Tampermonkey indisponible", error);
    }
    const reportSignatures = /* @__PURE__ */ new WeakMap(), galaxySignatures = /* @__PURE__ */ new WeakMap();
    const toolbar = (root) => {
      const old = root.querySelector(":scope > [data-sephi-toolbar]");
      if (old) {
        old.replaceChildren();
        return old;
      }
      const bar = document.createElement("div");
      bar.dataset.sephiToolbar = "";
      bar.style.cssText = "padding:8px;background:#173345;color:#dff;font:13px/1.5 system-ui;display:flex;gap:8px;flex-wrap:wrap;position:relative;z-index:2";
      root.append(bar);
      return bar;
    };
    const button = (text, action) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.cssText = "cursor:pointer;color:#e7ffff;background:#25516a;border:1px solid #77aaaa;border-radius:4px;padding:5px 8px;font:12px system-ui";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          action();
        } catch (error) {
          panel.error(error);
        }
      });
      return b;
    };
    const link = (text, href) => {
      const a = document.createElement("a");
      a.textContent = text;
      a.href = href;
      a.style.cssText = "color:#a4ffe4;text-decoration:underline;padding:4px;font:13px system-ui";
      a.addEventListener("click", (e) => e.stopPropagation());
      return a;
    };
    const scan = () => {
      panel.scanNativeEnhancements();
      const combatSim = [...document.querySelectorAll("a.menubutton")].find((anchor) =>
        anchor.getAttribute("href")?.includes("component=combatsim") ||
        anchor.querySelector(".textlabel")?.textContent?.trim().toLocaleLowerCase() === "simulation de combat"
      );
      let menuEntry = document.getElementById("sephi-menu-entry");
      let menuItem = document.getElementById("sephi-menu-item");
      const launcher = document.getElementById("sephi-root")?.shadowRoot?.querySelector(".launcher");
      if (combatSim) {
        if (!menuEntry) {
          menuEntry = document.createElement("a");
          menuEntry.id = "sephi-menu-entry";
          menuEntry.className = "menubutton ipiHintable";
          menuEntry.href = "#sephi-root";
          menuEntry.title = "Ouvrir SephiOGame";
          menuEntry.dataset.ipiHint = "ipiToolbarEmpire";
          const label = document.createElement("span");
          label.className = "textlabel";
          label.textContent = "SephiOGame";
          menuEntry.append(label);
          menuEntry.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            panel.open();
          });
        }
        if (!menuItem) {
          menuItem = combatSim.parentElement?.cloneNode(false) ?? document.createElement("li");
          menuItem.id = "sephi-menu-item";
          const menuIcon = combatSim.parentElement?.querySelector(":scope > .menu_icon");
          if (menuIcon) menuItem.append(menuIcon.cloneNode(true));
          menuItem.append(menuEntry);
        }
        if (combatSim.parentElement?.nextElementSibling !== menuItem) combatSim.parentElement?.insertAdjacentElement("afterend", menuItem);
        if (launcher) launcher.hidden = true;
      } else {
        menuItem?.remove();
        if (launcher) launcher.hidden = false;
      }
      for (const root of document.querySelectorAll(selectors.reports)) {
        if (root.querySelector(selectors.reports)) continue;
        try {
          const target = parseSpyTarget(root);
          if (root.querySelector(selectors.rawReport)?.getAttribute("data-raw-targetplayerid") === context.playerId) continue;
          const id = targetId(target.coords), saved = panel.data.targets.find((t) => t.id === id);
          let report;
          try {
            report = parseEspionageReport(root);
          } catch {
          }
          const signature = JSON.stringify([target, report ? { ...report, observedAt: 0 } : null, !!saved, panel.data.settings]);
          if (reportSignatures.get(root) === signature && root.querySelector("[data-sephi-toolbar]")) continue;
          reportSignatures.set(root, signature);
          const bar = toolbar(root), info = document.createElement("span");
          if (report) {
            const loot = calculateLoot(report.resources, report.lootFactor ?? panel.data.settings.lootFactor);
            const pt = calculateRequiredCargo(loot, panel.data.settings.smallCargo), gt = calculateRequiredCargo(loot, panel.data.settings.largeCargo);
            info.textContent = `SephiOGame \xB7 Butin \u2248 ${loot.toLocaleString("fr-FR")} \xB7 ${pt} PT / ${gt} GT`;
            bar.append(info);
            if (loot > 0) bar.append(link(`Pr\xE9parer ${pt} PT`, fleetURL(target.coords, "attack", context, 202, pt, loot)), link(`Pr\xE9parer ${gt} GT`, fleetURL(target.coords, "attack", context, 203, gt, loot)));
            bar.append(button(saved ? "Actualiser le frigo" : "Ajouter aux frigos", () => panel.ingest(parseEspionageReport(root))));
          } else {
            info.textContent = "SephiOGame \xB7 Ressources indisponibles : ouvrir le rapport d\xE9taill\xE9";
            bar.append(info);
            if (!saved) bar.append(button("Ajouter aux frigos", () => panel.addTarget(target.coords, target.name)));
          }
          bar.append(link("Galaxie", actionURL(target.coords, "galaxy", context.planetId)), link("Pr\xE9parer sondes", fleetURL(target.coords, "spy", context, 210, saved?.probeCount ?? panel.data.settings.defaultProbes)));
          if (saved) bar.append(button("Retirer des frigos", () => panel.removeTarget(id)));
        } catch {
          root.querySelector(":scope > [data-sephi-toolbar]")?.remove();
          reportSignatures.delete(root);
        }
      }
      for (const row of document.querySelectorAll(selectors.galaxyRows)) {
        const target = galaxyTarget(row);
        if (!target) {
          row.querySelector("[data-sephi-toolbar]")?.remove();
          continue;
        }
        const targets = [target];
        if (row.querySelector(selectors.galaxyMoon)) targets.push({ ...target, coords: { ...target.coords, type: "moon" } });
        const signature = JSON.stringify(targets.map((t) => [t, panel.data.targets.some((s) => s.id === targetId(t.coords))]));
        if (galaxySignatures.get(row) === signature && row.querySelector("[data-sephi-toolbar]")) continue;
        galaxySignatures.set(row, signature);
        const host = row.querySelector(selectors.galaxyActions) ?? (row.tagName === "TR" ? row.lastElementChild ?? row : row);
        const bar = toolbar(host);
        for (const t of targets) {
          const id = targetId(t.coords), saved = panel.data.targets.some((s) => s.id === id), moon = t.coords.type === "moon";
          bar.append(button(`${saved ? "\u2605 Retirer" : "\u2606 Frigo"} ${moon ? "lune" : "plan\xE8te"}`, () => saved ? panel.removeTarget(id) : panel.addTarget(t.coords, t.name)));
        }
      }
    };
    panel.onChange = scan;
    panel.installNativeEnhancements();
    observeDOM(scan);
    if (context.page === "fleetdispatch" && location.hash.includes("sephiShip=")) {
      let attempts = 0;
      const prepare = () => {
        try {
          if (prepareFleet(context) === "waiting") {
            if (++attempts < 20) setTimeout(prepare, 500);
            else showPreparation("La page flotte ne fournit pas encore ses donn\xE9es. Rechargez la page pour r\xE9essayer.");
          }
        } catch (e) {
          panel.error(e);
        }
      };
      prepare();
    }
    if (panel.campaign?.status === "running" && panel.campaign.runnerId === panel.campaignTabId) {
      panel.consumeCampaignContinuation();
      if (panel.campaign.pending) panel.recoverUncertainDispatch("Navigation pendant un envoi non confirmé.");
      else panel.continueAutoAttacks();
    }
    try {
      if (!localStorage.getItem(`${key}:installed`)) {
        panel.open();
        panel.message("SephiOGame est actif sur ce compte. G\xE9rez vos frigos ici, ou ajoutez-les depuis les rapports et la galaxie.");
        localStorage.setItem(`${key}:installed`, "1");
      }
    } catch {
    }
    return panel;
  }

  // src/userscript.ts
  function boot() {
    if (!/^s[^.]+\.ogame\.gameforge\.com$/.test(location.hostname)) return;
    if (window.top !== window.self && !isCampaignWorker() && !isConstructionWorker() && !isEjectWorker() && !isSlotWorker() && !isDiscoveryWorker() || document.getElementById("sephi-boot-status")) return;
    const badge = document.createElement("button");
    badge.id = "sephi-boot-status";
    badge.type = "button";
    badge.style.cssText = "all:initial!important;display:block!important;position:fixed!important;top:8px!important;left:8px!important;z-index:2147483647!important;padding:9px 13px!important;border:1px solid #8de5ce!important;border-radius:6px!important;background:#16394a!important;color:#fff!important;font:13px/1.5 sans-serif!important;cursor:pointer!important;max-width:420px!important;white-space:normal!important;visibility:visible!important;opacity:1!important";
    document.documentElement.append(badge);
    let panel;
    let state = "Chargement";
    let detail = "";
    const status = (next, message = "") => {
      state = next;
      detail = message;
      badge.textContent = `SephiOGame ${VERSION} \xB7 ${next}`;
      badge.title = message || "Cliquer pour ouvrir SephiOGame";
      badge.dataset.state = next;
    };
    const diagnostic = () => window.alert(`SephiOGame ${VERSION}
\xC9tat : ${state}
Univers : ${location.host}
Compte d\xE9tect\xE9 : ${getPlayerContext() ? "oui" : "non"}
${detail}`);
    badge.addEventListener("click", () => {
      if (panel) panel.open();
      else {
        const launcher = document.getElementById("sephi-root")?.shadowRoot?.querySelector(".launcher");
        if (launcher) launcher.click();
        else diagnostic();
      }
    });
    status("Chargement");
    console.info(`[SephiOGame ${VERSION}] Userscript inject\xE9 sur ${location.host}${location.pathname}`);
    try {
      if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand("Diagnostic de d\xE9marrage SephiOGame", diagnostic);
    } catch (error) {
      console.warn("[SephiOGame] Menu Tampermonkey indisponible", error);
    }
    const launch = () => {
      try {
        panel = start();
        if (panel) {
          status("Actif");
          badge.remove();
          return true;
        }
        if (document.getElementById("sephi-root")?.shadowRoot?.querySelector(".launcher")) {
          status("Panneau d\xE9j\xE0 pr\xE9sent", "V\xE9rifier qu\u2019une seule version de SephiOGame est activ\xE9e.");
          return true;
        }
        if (!getPlayerContext()) {
          status("Compte non d\xE9tect\xE9", "Les m\xE9tadonn\xE9es du joueur sont absentes. Le d\xE9marrage reprendra lorsqu\u2019elles seront pr\xE9sentes.");
          return false;
        }
        const error = document.getElementById("sephi-fleet-notice")?.textContent;
        status("Erreur de d\xE9marrage", error || "Initialisation interrompue. Cliquer pour afficher ce diagnostic.");
        return true;
      } catch (error) {
        const message = error instanceof Error ? `${error.name} : ${error.message}` : String(error);
        console.error("[SephiOGame] \xC9chec du d\xE9marrage", error);
        status("Erreur de d\xE9marrage", message);
        return true;
      }
    };
    if (!launch()) {
      const observer = new MutationObserver(() => {
        if (getPlayerContext() && launch()) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["content"] });
    }
  }
  var started = false;
  function ready() {
    if (started || !document.body) return;
    started = true;
    boot();
  }
  if (document.body) ready();
  else {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        ready();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
