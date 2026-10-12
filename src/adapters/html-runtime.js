/**
 * Browser runtime for the self-contained HTML deck: navigation, live hotkeys,
 * blackout, slide overview, and the synced `?view=presenter` window.
 *
 * The helpers below are plain functions so Node tests can exercise them
 * directly; the HTML adapter inlines their source into the deck, so they must
 * stay self-contained (no references to module scope or imports).
 */

/** Presenter sync wire format identifiers (also inlined in the helpers). */
export const SYNC_PROTOCOL = "pptops-presenter";
export const SYNC_VERSION = 1;
export const SYNC_ACTIONS = Object.freeze(["hello", "state", "go", "blackout", "timer"]);

/** Human-readable keymap rendered into the `?` help dialog. */
export const DECK_KEYMAP = Object.freeze([
  ["→ / Space / PageDown", "Next slide"],
  ["← / PageUp", "Previous slide"],
  ["Home / End", "First / last slide"],
  ["1–9 … Enter", "Jump to slide number"],
  ["B", "Blackout / restore screen"],
  ["I / G", "Slide overview"],
  ["N", "Open presenter view"],
  ["F", "Fullscreen"],
  ["?", "Show / hide this help"],
  ["Esc", "Close overlay / clear jump"]
]);

/** Build one sync message. Every transport carries this exact object. */
export function createSyncMessage(deckId, sender, seq, action, payload) {
  return Object.assign({ protocol: "pptops-presenter", version: 1, deck: deckId, sender: sender, seq: seq, action: action }, payload || {}, { sent_at: Date.now() });
}

/** Validate an incoming sync message (object or JSON string); returns it or null. */
export function parseSyncMessage(data, deckId, self) {
  let message = data;
  if (typeof message === "string") { try { message = JSON.parse(message); } catch (error) { return null; } }
  if (!message || typeof message !== "object") return null;
  if (message.protocol !== "pptops-presenter" || message.version !== 1 || message.deck !== deckId) return null;
  if (typeof message.sender !== "string" || !message.sender || message.sender === self || !Number.isInteger(message.seq) || message.seq < 1) return null;
  const validTimer = (timer) => Boolean(timer) && typeof timer.running === "boolean" && Number.isFinite(timer.accumulated_ms) && (timer.running ? Number.isFinite(timer.started_at) : true);
  switch (message.action) {
    case "hello": return message;
    case "go": return Number.isInteger(message.index) ? message : null;
    case "blackout": return typeof message.value === "boolean" ? message : null;
    case "timer": return ["pause", "resume", "reset"].includes(message.command) ? message : null;
    case "state": return Number.isInteger(message.index) && Number.isInteger(message.count) && typeof message.blackout === "boolean" && validTimer(message.timer) ? message : null;
    default: return null;
  }
}

/**
 * Map a keydown to a deck action. Returns null for keys the deck ignores,
 * while typing in form fields, or when Ctrl/Meta/Alt is held (browser shortcuts).
 */
export function deckKeyAction(key, modifiers, typing) {
  if (typing || !key) return null;
  if (modifiers && (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey)) return null;
  if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(key)) return "next";
  if (["ArrowLeft", "ArrowUp", "PageUp"].includes(key)) return "previous";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (key === "Enter") return "enter";
  if (key === "Escape") return "escape";
  if (key === "Backspace") return "backspace";
  if (key === "?") return "help";
  if (/^[0-9]$/.test(key)) return "digit";
  const lower = key.toLowerCase();
  if (lower === "f") return "fullscreen";
  if (lower === "b") return "blackout";
  if (lower === "i" || lower === "g") return "overview";
  if (lower === "n") return "presenter";
  return null;
}

/** Elapsed milliseconds for a timer state at `now`. */
export function timerElapsed(timer, now) {
  return Math.max(0, timer.accumulated_ms + (timer.running ? now - timer.started_at : 0));
}

/** Apply start/pause/resume/reset to a timer state. Navigation never calls this. */
export function timerCommand(timer, command, now) {
  if (command === "reset") return { running: true, started_at: now, accumulated_ms: 0 };
  if (command === "pause") return timer.running ? { running: false, started_at: null, accumulated_ms: timerElapsed(timer, now) } : timer;
  if (command === "resume" || command === "start") return timer.running ? timer : { running: true, started_at: now, accumulated_ms: timer.accumulated_ms };
  return timer;
}

/** Format milliseconds as m:ss or h:mm:ss (negative values get a leading minus). */
export function formatClock(ms) {
  const total = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return (ms < 0 && total > 0 ? "-" : "") + (hours ? hours + ":" + pad(minutes) : String(minutes)) + ":" + pad(seconds);
}

/* Deck runtime; runs in the browser with the helpers above in scope. */
function deckRuntime(config) {
  const params = new URLSearchParams(location.search);
  const view = params.get("view");
  const notesTemplate = document.getElementById("speaker-notes-data");
  if (view === "notes" && notesTemplate) {
    document.body.classList.add("notes-view");
    document.body.appendChild(notesTemplate.content.cloneNode(true));
    return;
  }
  const presenterMode = view === "presenter";
  const slides = [...document.querySelectorAll(".stage > .slide")];
  const stage = document.querySelector(".stage"), progress = document.querySelector(".controls progress"), output = document.querySelector(".controls output");
  const fullscreen = document.querySelector('[data-nav="fullscreen"]');
  const blackoutLayer = document.querySelector(".blackout"), keymap = document.querySelector(".keymap"), overview = document.querySelector(".overview"), jump = document.querySelector(".jump-indicator");
  const self = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const storageKey = "pptops-presenter:" + config.deck_id, timerKey = storageKey + ":timer";
  const seen = new Map();
  let seq = 0, digits = "", digitTimeout = 0, peerWindow = null, channel = null, connected = false;
  const state = { index: 0, blackout: false, timer: { running: false, started_at: null, accumulated_ms: 0 } };
  if (presenterMode) state.timer = timerCommand(state.timer, "start", Date.now());
  else { try { const saved = JSON.parse(sessionStorage.getItem(timerKey) || "null"); if (saved && typeof saved.running === "boolean" && Number.isFinite(saved.accumulated_ms)) state.timer = saved; } catch (error) {} }
  const clamp = (index) => Math.max(0, Math.min(slides.length - 1, index));
  const neverStarted = (timer) => !timer.running && timer.accumulated_ms === 0;
  let renderPresenter = () => {};

  function send(action, payload) {
    const message = createSyncMessage(config.deck_id, self, ++seq, action, payload);
    try { if (channel) channel.postMessage(message); } catch (error) {}
    const target = presenterMode ? window.opener : peerWindow;
    try { if (target && !target.closed) target.postMessage(message, "*"); } catch (error) {}
    try { localStorage.setItem(storageKey, JSON.stringify(message)); } catch (error) {}
  }
  function broadcast() {
    if (!presenterMode) { try { sessionStorage.setItem(timerKey, JSON.stringify(state.timer)); } catch (error) {} }
    send("state", { index: state.index, count: slides.length, blackout: state.blackout, timer: state.timer });
  }
  function receive(data) {
    const message = parseSyncMessage(data, config.deck_id, self);
    if (!message || (seen.get(message.sender) || 0) >= message.seq) return;
    const firstContact = !seen.has(message.sender);
    seen.set(message.sender, message.seq);
    if (presenterMode) {
      if (message.action !== "state") return;
      connected = true;
      state.index = clamp(message.index); state.blackout = message.blackout; state.timer = message.timer;
      renderPresenter();
      if (firstContact && neverStarted(message.timer)) send("hello");
      return;
    }
    if (message.action === "hello") { if (neverStarted(state.timer)) state.timer = timerCommand(state.timer, "start", Date.now()); broadcast(); }
    else if (message.action === "go") show(message.index);
    else if (message.action === "blackout") setBlackout(message.value);
    else if (message.action === "timer") { state.timer = timerCommand(state.timer, message.command, Date.now()); broadcast(); }
  }
  try { if (typeof BroadcastChannel === "function") { channel = new BroadcastChannel(storageKey); channel.onmessage = (event) => receive(event.data); } } catch (error) { channel = null; }
  addEventListener("storage", (event) => { if (event.key === storageKey && event.newValue) receive(event.newValue); });
  addEventListener("message", (event) => {
    let trusted = false;
    try { trusted = Boolean(event.source) && (event.source === peerWindow || event.source === window.opener || event.source.opener === window); } catch (error) { trusted = false; }
    if (!trusted) return;
    if (!presenterMode && event.source !== window.opener) peerWindow = event.source;
    receive(event.data);
  });

  function fitThumbs(container) {
    container.querySelectorAll(".thumb-frame").forEach((frame) => {
      const inner = frame.firstElementChild;
      if (inner && frame.clientWidth) inner.style.transform = "scale(" + frame.clientWidth / 1920 + ")";
    });
  }
  function thumbnail(index) {
    const frame = document.createElement("div");
    frame.className = "thumb-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.inert = true;
    const inner = document.createElement("div");
    inner.className = "thumb-stage";
    const clone = slides[index].cloneNode(true);
    [clone, ...clone.querySelectorAll("*")].forEach((element) => ["id", "aria-labelledby", "aria-describedby", "data-qa-id", "inert"].forEach((name) => element.removeAttribute(name)));
    clone.setAttribute("aria-hidden", "true");
    clone.querySelectorAll("video").forEach((video) => { video.removeAttribute("controls"); video.preload = "none"; });
    inner.appendChild(clone);
    frame.appendChild(inner);
    return frame;
  }
  function slideTitle(index) { const heading = slides[index].querySelector("h1"); return heading ? heading.textContent.trim() : "Slide " + (index + 1); }
  function setOverlay(element, open) {
    if (!element) return;
    element.hidden = !open;
    if (open) { const focusTarget = element.querySelector('[aria-current="true"]') || element.querySelector("button"); if (focusTarget) focusTarget.focus(); }
  }
  function toggleHelp(force) { setOverlay(keymap, typeof force === "boolean" ? force : keymap.hidden); }
  function clearDigits() { digits = ""; clearTimeout(digitTimeout); if (jump) jump.hidden = true; }
  function pushDigit(value) {
    digits = (digits + value).replace(/^0+/, "").slice(0, 4);
    clearTimeout(digitTimeout);
    digitTimeout = setTimeout(clearDigits, 4000);
    if (jump) { jump.hidden = !digits; jump.textContent = "Go to slide " + digits + " ⏎"; }
  }
  function commitDigits(goTo) {
    const target = Number(digits);
    clearDigits();
    if (target >= 1 && target <= slides.length) goTo(target - 1);
  }
  function handleCommon(action, event, goTo) {
    if (action === "next") goTo(state.index + 1);
    else if (action === "previous") goTo(state.index - 1);
    else if (action === "first") goTo(0);
    else if (action === "last") goTo(slides.length - 1);
    else if (action === "digit") pushDigit(event.key);
    else if (action === "backspace" && digits) { digits = digits.slice(0, -1); if (digits) pushDigit(""); else clearDigits(); }
    else if (action === "enter" && digits) commitDigits(goTo);
    else if (action === "help") toggleHelp();
    else if (action === "escape") { clearDigits(); toggleHelp(false); setOverlay(overview, false); }
    else return false;
    return true;
  }
  function isTyping(target) { return Boolean(target) && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable); }
  function onButtonActivation(event) { return [" ", "Enter"].includes(event.key) && event.target && event.target.closest && event.target.closest("button,a,summary,[role=button]"); }
  if (keymap) keymap.querySelector("[data-close]").addEventListener("click", () => toggleHelp(false));
  document.querySelectorAll('[data-nav="help"]').forEach((button) => button.addEventListener("click", () => toggleHelp()));

  if (presenterMode) return presenter();

  function scale() { stage.style.transform = "translate(-50%,-50%) scale(" + Math.min(innerWidth / 1920, innerHeight / 1080) + ")"; if (overview && !overview.hidden) fitThumbs(overview); }
  function show(index) {
    state.index = clamp(index);
    slides.forEach((slide, i) => { const active = i === state.index; slide.setAttribute("aria-hidden", String(!active)); slide.toggleAttribute("inert", !active); });
    progress.value = state.index + 1;
    output.value = (state.index + 1) + " / " + slides.length;
    location.hash = "slide-" + slides[state.index].dataset.page;
    broadcast();
  }
  function setBlackout(value) {
    state.blackout = value;
    blackoutLayer.hidden = !value;
    broadcast();
  }
  function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
  async function toggleFullscreen() {
    if (fullscreenElement()) { const exit = document.exitFullscreen || document.webkitExitFullscreen; await exit.call(document); }
    else { const enter = document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen; if (!enter) throw new Error("Fullscreen API unavailable"); await enter.call(document.documentElement); }
  }
  function syncFullscreen() { const active = Boolean(fullscreenElement()); fullscreen.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen"); fullscreen.textContent = active ? "×" : "⛶"; scale(); }
  function openPresenter() {
    if (peerWindow && !peerWindow.closed) { peerWindow.focus(); broadcast(); return; }
    const url = new URL(location.href);
    url.search = "?view=presenter";
    url.hash = "";
    peerWindow = window.open(url.href, "pptops-presenter-" + config.deck_id, "popup,width=1280,height=800") || null;
  }
  function toggleOverview(force) {
    const open = typeof force === "boolean" ? force : overview.hidden;
    if (open) {
      const grid = overview.querySelector(".overview-grid");
      if (!grid.childElementCount) slides.forEach((slide, index) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "overview-tile";
        tile.dataset.index = String(index);
        tile.setAttribute("aria-label", "Go to slide " + (index + 1) + ": " + slideTitle(index));
        const label = document.createElement("span");
        label.textContent = (index + 1) + ". " + slideTitle(index);
        tile.append(thumbnail(index), label);
        tile.addEventListener("click", () => { toggleOverview(false); show(index); });
        grid.appendChild(tile);
      });
      grid.querySelectorAll(".overview-tile").forEach((tile) => tile.setAttribute("aria-current", String(Number(tile.dataset.index) === state.index)));
    }
    setOverlay(overview, open);
    if (open) fitThumbs(overview);
  }
  addEventListener("resize", scale);
  addEventListener("keydown", (event) => {
    if (onButtonActivation(event)) return;
    const action = deckKeyAction(event.key, event, isTyping(event.target));
    if (!action) return;
    if (action === "enter" && !digits) return;
    event.preventDefault();
    if (handleCommon(action, event, show)) return;
    if (action === "fullscreen") toggleFullscreen();
    else if (action === "blackout") setBlackout(!state.blackout);
    else if (action === "overview") toggleOverview();
    else if (action === "presenter") openPresenter();
  });
  blackoutLayer.addEventListener("click", () => setBlackout(false));
  overview.querySelector("[data-close]").addEventListener("click", () => toggleOverview(false));
  document.addEventListener("fullscreenchange", syncFullscreen);
  document.addEventListener("webkitfullscreenchange", syncFullscreen);
  document.querySelector('[data-nav="previous"]').addEventListener("click", () => show(state.index - 1));
  document.querySelector('[data-nav="next"]').addEventListener("click", () => show(state.index + 1));
  document.querySelector('[data-nav="overview"]').addEventListener("click", () => toggleOverview());
  document.querySelector('[data-nav="presenter"]').addEventListener("click", openPresenter);
  fullscreen.addEventListener("click", toggleFullscreen);
  const requested = slides.findIndex((slide) => "slide-" + slide.dataset.page === location.hash.slice(1));
  scale();
  show(requested < 0 ? 0 : requested);
  syncFullscreen();

  function presenter() {
    document.body.classList.add("presenter-view");
    document.title = "Presenter — " + document.title;
    const root = document.createElement("div");
    root.className = "presenter";
    root.setAttribute("lang", "en");
    root.innerHTML = '<header class="presenter-bar"><strong class="presenter-title"></strong><span class="presenter-status" data-p="status" role="status"></span><span class="presenter-clock">Elapsed <b data-p="elapsed">0:00</b></span><span class="presenter-clock" data-p="remaining-wrap">Remaining <b data-p="remaining"></b> <small data-p="budget"></small></span><button type="button" data-p="pause">Pause</button><button type="button" data-p="reset">Reset timer</button><button type="button" data-nav="help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button></header>'
      + '<div class="presenter-main"><section class="presenter-current" aria-label="Current slide"><h2>Current <span data-p="position"></span> <span class="presenter-blackout" data-p="blackout" hidden>Screen blacked out</span></h2><div data-p="current"></div></section>'
      + '<section class="presenter-side"><h2>Next</h2><div data-p="next"></div><h2>Speaker notes</h2><p class="presenter-estimate" data-p="estimate"></p><div class="presenter-notes" data-p="notes" tabindex="0"></div></section></div>'
      + '<nav class="presenter-nav" aria-label="Presenter navigation"><button type="button" data-p="previous" aria-label="Previous slide">&#8592;</button><button type="button" data-p="next-button" aria-label="Next slide">&#8594;</button><button type="button" data-p="blackout-button">Blackout (B)</button><span class="presenter-jump-hint">Digits + Enter jump · ? help</span></nav>';
    document.body.insertBefore(root, document.body.firstChild);
    const part = (name) => root.querySelector('[data-p="' + name + '"]');
    root.querySelector(".presenter-title").textContent = config.title;
    let rendered = -1;
    function notesFor(index) {
      const page = slides[index].dataset.page;
      const article = notesTemplate && notesTemplate.content.querySelector('article[data-page="' + page + '"] .notes-copy');
      return article ? article.textContent : "";
    }
    function tick() {
      const elapsed = timerElapsed(state.timer, Date.now());
      part("elapsed").textContent = formatClock(elapsed);
      part("pause").textContent = state.timer.running ? "Pause" : "Resume";
      const wrap = part("remaining-wrap");
      if (!config.budget) { wrap.hidden = true; return; }
      const remaining = config.budget.seconds * 1000 - elapsed;
      part("remaining").textContent = remaining < 0 ? "+" + formatClock(-remaining) + " over" : formatClock(remaining);
      wrap.classList.toggle("over", remaining < 0);
    }
    renderPresenter = function () {
      part("blackout").hidden = !state.blackout;
      part("blackout-button").setAttribute("aria-pressed", String(state.blackout));
      part("status").textContent = connected ? "Synced with main deck" : "Waiting for main deck — press N in the deck window";
      tick();
      if (rendered === state.index) return;
      rendered = state.index;
      part("position").textContent = (state.index + 1) + " / " + slides.length + " · " + slideTitle(state.index);
      part("current").replaceChildren(thumbnail(state.index));
      const nextIndex = state.index + 1;
      if (nextIndex < slides.length) part("next").replaceChildren(thumbnail(nextIndex));
      else { const end = document.createElement("p"); end.className = "presenter-end"; end.textContent = "End of deck"; part("next").replaceChildren(end); }
      const estimate = config.estimates[state.index];
      part("estimate").textContent = estimate ? "Estimated " + formatClock(estimate * 1000) + " for this slide (planning estimate, unrehearsed)" : "No duration estimate for this slide";
      const notes = notesFor(state.index);
      part("notes").textContent = notes || "No authored notes for this slide.";
      part("notes").classList.toggle("empty", !notes);
      fitThumbs(root);
    };
    if (config.budget) part("budget").textContent = "of " + formatClock(config.budget.seconds * 1000) + (config.budget.source === "talk_budget" ? " talk budget" : " summed page estimates (unrehearsed)");
    function go(index) { state.index = clamp(index); renderPresenter(); send("go", { index: state.index }); }
    function toggleBlackout() { state.blackout = !state.blackout; renderPresenter(); send("blackout", { value: state.blackout }); }
    function timer(command) { state.timer = timerCommand(state.timer, command, Date.now()); tick(); send("timer", { command: command }); }
    part("previous").addEventListener("click", () => go(state.index - 1));
    part("next-button").addEventListener("click", () => go(state.index + 1));
    part("blackout-button").addEventListener("click", toggleBlackout);
    part("pause").addEventListener("click", () => timer(state.timer.running ? "pause" : "resume"));
    part("reset").addEventListener("click", () => timer("reset"));
    root.querySelector('[data-nav="help"]').addEventListener("click", () => toggleHelp());
    addEventListener("keydown", (event) => {
      if (onButtonActivation(event)) return;
      const action = deckKeyAction(event.key, event, isTyping(event.target));
      if (!action || (action === "enter" && !digits)) return;
      if (handleCommon(action, event, go)) { event.preventDefault(); return; }
      if (action === "blackout") { event.preventDefault(); toggleBlackout(); }
    });
    addEventListener("resize", () => fitThumbs(root));
    const requested = slides.findIndex((slide) => "slide-" + slide.dataset.page === location.hash.slice(1));
    state.index = requested < 0 ? 0 : requested;
    renderPresenter();
    setInterval(tick, 500);
    send("hello");
    const retry = setInterval(() => { if (connected) clearInterval(retry); else send("hello"); }, 1500);
  }
}

/** Inline `<script>` body for the deck. `config` is read from the JSON config element. */
export function deckRuntimeScript() {
  const helpers = [createSyncMessage, parseSyncMessage, deckKeyAction, timerElapsed, timerCommand, formatClock].map(String).join("\n");
  return `(()=>{${helpers}\n(${deckRuntime})(JSON.parse(document.getElementById('deck-runtime-config').textContent))})();`;
}
