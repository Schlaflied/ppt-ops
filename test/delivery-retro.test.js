import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHtml } from "../src/adapters/html.js";
import { buildDeliveryRecord, createDeliveryRecord, createSyncMessage, deckKeyAction, parseSyncMessage, presenterKeyAction, recordNavigate, recordToggleMark, timerCommand, timerElapsed } from "../src/adapters/html-runtime.js";
import { readProject } from "../src/core/project.js";
import { validatePage, validateProject } from "../src/core/validate.js";
import { analyzeDeliveryRecord, inspectDeliveryFeedback, latestRehearsedDuration, rehearsedDurations, resolvePageDuration, validateDeliveryRecord } from "../src/delivery/retro.js";
import { writeMigratedProject } from "../src/migrations/foundation-to-v1.js";
import { findBrowser, withHtmlPage } from "../src/qa/html.js";

const CLI = path.resolve("src/cli.js");
const DECK = { deck_id: "deck1", project: "demo-presentation", title: "Demo", pages: [{ page: 1, title: "Intro" }, { page: 2, title: "Body" }, { page: 3, title: "End" }], estimates: [60, 30, null] };

async function tempDemo(prefix = "pptops-retro-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(directory, "demo-project");
  await fs.cp(path.resolve("examples/demo-project"), root, { recursive: true });
  return root;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : JSON.parse(result.stderr || "null") };
}

/** Simulate a delivery with the same pure helpers the presenter window uses. */
function simulatedRecord({ project = "demo-presentation", pages, date = "2026-10-01", venue = "offline", stayOnSecond = 75, marks = [] } = {}) {
  const deck = { ...DECK, project, ...(pages ? { pages } : {}) };
  deck.pages = deck.pages.slice(0, 2);
  deck.estimates = [60, 30];
  let now = Date.UTC(2026, 9, 1, 9, 0, 0);
  let timer = timerCommand({ running: false, started_at: null, accumulated_ms: 0 }, "start", now);
  let record = { ...createDeliveryRecord(0, 0, now), date, venue };
  now += 40000;
  record = recordNavigate(record, 1, timerElapsed(timer, now), now);
  for (const kind of marks) record = recordToggleMark(record, 1, kind, timerElapsed(timer, now), now);
  now += stayOnSecond * 1000;
  return buildDeliveryRecord(record, deck, timerElapsed(timer, now), now);
}

test("record helpers time pages on the talk clock, excluding paused time", () => {
  let now = 1_000_000;
  let timer = timerCommand({ running: false, started_at: null, accumulated_ms: 0 }, "start", now);
  let record = createDeliveryRecord(0, 0, now);
  assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(record.venue, "offline");
  now += 30000;
  record = recordNavigate(record, 1, timerElapsed(timer, now), now);
  assert.equal(recordNavigate(record, 1, timerElapsed(timer, now), now), record, "re-showing the same slide is a no-op");
  now += 10000;
  timer = timerCommand(timer, "pause", now);
  now += 600000; // a ten-minute pause must not count
  timer = timerCommand(timer, "resume", now);
  now += 20000;
  record = recordToggleMark(record, 1, "question", timerElapsed(timer, now), now);
  record = recordToggleMark(record, 1, "stumble", timerElapsed(timer, now), now);
  record = recordToggleMark(record, 1, "stumble", timerElapsed(timer, now), now);
  assert.deepEqual(record.marks.map((mark) => mark.kind), ["question"], "pressing a mark key twice undoes it");
  record = recordNavigate(record, 0, timerElapsed(timer, now), now);
  now += 5000;
  const exported = buildDeliveryRecord(record, DECK, timerElapsed(timer, now), now);
  assert.deepEqual(validateDeliveryRecord(exported), []);
  assert.equal(exported.delivery.total_seconds, 65);
  assert.deepEqual(exported.pages.map((page) => page.actual_seconds), [35, 30, 0]);
  assert.equal(exported.pages[0].visits.length, 2);
  assert.equal(exported.pages[0].estimated_seconds, 60);
  assert.equal(exported.pages[2].estimated_seconds, undefined);
  assert.deepEqual(exported.marks, [{ page: 2, kind: "question", at_seconds: 60, marked_at: new Date(now - 5000).toISOString() }]);
  assert.equal(exported.delivery.timing_basis, "talk_clock_excluding_pauses");
});

test("presenter keys add marks without changing the main deck keymap", () => {
  assert.equal(presenterKeyAction("!", {}, false), "mark-stumble");
  assert.equal(presenterKeyAction("?", { shiftKey: true }, false), "mark-question");
  assert.equal(presenterKeyAction("x", {}, false), "mark-skipped");
  assert.equal(presenterKeyAction("X", {}, false), "mark-skipped");
  assert.equal(presenterKeyAction("e", {}, false), "export");
  assert.equal(presenterKeyAction("h", {}, false), "help");
  assert.equal(presenterKeyAction("ArrowRight", {}, false), "next");
  assert.equal(presenterKeyAction("b", {}, false), "blackout");
  assert.equal(presenterKeyAction("?", {}, true), null, "typing in the label field is ignored");
  assert.equal(presenterKeyAction("e", { metaKey: true }, false), null);
  assert.equal(deckKeyAction("?", {}, false), "help", "main deck keeps ? for help");
  assert.equal(deckKeyAction("x", {}, false), null);
});

test("record sync messages are validated", () => {
  assert.ok(parseSyncMessage(createSyncMessage("d", "p", 1, "record", { command: "mark", index: 2, kind: "question" }), "d", "x"));
  assert.equal(parseSyncMessage(createSyncMessage("d", "p", 1, "record", { command: "mark", index: 2, kind: "boo" }), "d", "x"), null);
  assert.ok(parseSyncMessage(createSyncMessage("d", "p", 1, "record", { command: "meta", venue: "online", date: "2026-10-12", label: "cohort 3" }), "d", "x"));
  assert.equal(parseSyncMessage(createSyncMessage("d", "p", 1, "record", { command: "meta", venue: "moon", date: "2026-10-12" }), "d", "x"), null);
  assert.equal(parseSyncMessage(createSyncMessage("d", "p", 1, "record", { command: "wipe" }), "d", "x"), null);
  const timer = { running: true, started_at: 1, accumulated_ms: 0 };
  assert.ok(parseSyncMessage(createSyncMessage("d", "p", 1, "state", { index: 0, count: 2, blackout: false, timer, record: null }), "d", "x"));
  assert.equal(parseSyncMessage(createSyncMessage("d", "p", 1, "state", { index: 0, count: 2, blackout: false, timer, record: { visits: "x" } }), "d", "x"), null);
});

test("delivery record schema rejects malformed records", async () => {
  const valid = simulatedRecord();
  assert.deepEqual(validateDeliveryRecord(valid), []);
  const broken = structuredClone(valid);
  broken.kind = "rehearsal";
  broken.delivery.venue = "hybrid";
  broken.delivery.date = "12/10/2026";
  broken.pages[0].actual_seconds = 999;
  broken.marks.push({ page: 9, kind: "boo", at_seconds: -1, marked_at: "yesterday" });
  broken.extra = true;
  const errors = validateDeliveryRecord(broken);
  for (const pattern of [/kind must be/, /venue must be/, /date must be/, /sum of its visits/, /marks\[0\]\.page/, /marks\[0\]\.kind/, /record\.extra is not allowed/]) assert.ok(errors.some((error) => pattern.test(error)), pattern.source);
  const schema = JSON.parse(await fs.readFile("schemas/delivery-record.schema.json", "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.required, ["kind", "schema_version", "deck", "delivery", "pages", "marks"]);
});

test("delivery_feedback is a validated optional PageSpec field", async () => {
  const project = await readProject(path.resolve("examples/demo-project"));
  const assets = new Set(project.assets.map((asset) => asset.id));
  const page = structuredClone(project.pages[1]);
  page.delivery_feedback = [{ delivery_id: "2026-10-01-offline-abcd1234", date: "2026-10-01", venue: "offline", actual_seconds: 75, estimated_seconds: 30, visit_count: 1, skipped: false, overtime: true, marks: ["question"], report: "deliveries/x.md" }];
  assert.deepEqual(validatePage(page, assets), []);
  page.delivery_feedback.push({ ...page.delivery_feedback[0], venue: "moon", marks: ["question", "question"], report: "../escape.md", surprise: 1 });
  const errors = validatePage(page, assets);
  for (const pattern of [/duplicated/, /venue is invalid/, /marks must be unique/, /report must be a project-relative path/, /surprise is not allowed/]) assert.ok(errors.some((error) => pattern.test(error)), pattern.source);
  for (const file of ["schemas/delivery-feedback.schema.json", "schemas/page-spec.schema.json", "schemas/v1/page-spec.schema.json"]) {
    const text = await fs.readFile(file, "utf8");
    assert.match(text, /delivery-feedback|stumble/, file);
  }
});

test("rehearsed timing replaces the planning estimate once a delivery is recorded", () => {
  const page = { page: 2, id: "p2", estimated_duration_seconds: 30 };
  assert.deepEqual(resolvePageDuration(page), { seconds: 30, source: "estimated" });
  page.delivery_feedback = [
    { delivery_id: "b", date: "2026-10-05", venue: "online", actual_seconds: 50.4, visit_count: 1, skipped: false, overtime: true, marks: [] },
    { delivery_id: "a", date: "2026-10-01", venue: "offline", actual_seconds: 80, visit_count: 1, skipped: false, overtime: true, marks: [] },
    { delivery_id: "c", date: "2026-10-09", venue: "offline", actual_seconds: 0, visit_count: 0, skipped: true, overtime: false, marks: [] }
  ];
  assert.deepEqual(latestRehearsedDuration(page), { seconds: 50, date: "2026-10-05", delivery_id: "b" }, "latest by date; skipped deliveries are ignored");
  assert.deepEqual(resolvePageDuration(page), { seconds: 50, source: "rehearsed", date: "2026-10-05", delivery_id: "b", estimated_seconds: 30 });
  assert.deepEqual(rehearsedDurations([page, { page: 3 }]).map((item) => item.duration?.source ?? null), ["rehearsed", null]);
});

test("delivery-retro imports a record, writes the Markdown retro and PageSpec feedback", async () => {
  const root = await tempDemo();
  const recordFile = path.join(path.dirname(root), "first.json");
  await fs.writeFile(recordFile, JSON.stringify(simulatedRecord({ marks: ["stumble", "question"] })));
  const first = runCli("delivery-retro", root, "--record", recordFile);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.command, "delivery-retro");
  assert.match(first.json.delivery_id, /^2026-10-01-offline-[0-9a-f]{8}$/);
  assert.equal(first.json.pages_updated, 2);
  assert.deepEqual(first.json.overtime_pages, [2]);
  assert.deepEqual(first.json.skipped_pages, []);
  assert.deepEqual(first.json.mark_counts, { stumble: 1, question: 1, skipped: 0 });
  const report = await fs.readFile(first.json.report_file, "utf8");
  assert.match(report, /^# 演讲复盘：/);
  assert.match(report, /\| 2 \| 一份页面定义，两种交付载体 \| 0:30 \| 1:15 \| \+0:45 \| 1 \| 讲不顺（!）、观众有疑问（\?）、超时 \|/);
  assert.match(report, /## 超时的页\n[\s\S]*第 2 页/);
  assert.equal(path.relative(root, first.json.report_file), `deliveries/${first.json.delivery_id}.md`);
  assert.deepEqual(JSON.parse(await fs.readFile(first.json.record_file, "utf8")).kind, "delivery_record");
  const pages = JSON.parse(await fs.readFile(path.join(root, "pages.json"), "utf8"));
  assert.deepEqual(pages[1].delivery_feedback, [{ delivery_id: first.json.delivery_id, date: "2026-10-01", venue: "offline", actual_seconds: 75, estimated_seconds: 30, visit_count: 1, skipped: false, overtime: true, marks: ["stumble", "question"], report: `deliveries/${first.json.delivery_id}.md` }]);
  assert.equal(pages[0].delivery_feedback[0].estimated_seconds, 60, "record estimate is used when the project has none");
  assert.deepEqual(validateProject(await readProject(root)), []);
  assert.equal(runCli("validate", root).status, 0);

  const again = runCli("delivery-retro", root, "--record", recordFile);
  assert.equal(again.status, 1);
  assert.equal(again.json.error.code, "DELIVERY_ALREADY_IMPORTED");

  let project = await readProject(root);
  const single = inspectDeliveryFeedback(project);
  assert.equal(single.status, "passed");
  assert.equal(single.required, false);

  const secondFile = path.join(path.dirname(root), "second.json");
  await fs.writeFile(secondFile, JSON.stringify(simulatedRecord({ date: "2026-10-08", venue: "online", stayOnSecond: 20, marks: ["question"] })));
  const second = runCli("delivery-retro", root, "--record", secondFile);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.repeated_marks.length, 1);
  assert.equal(second.json.repeated_marks[0].page, 2);
  assert.deepEqual(second.json.repeated_marks[0].deliveries.map((entry) => entry.signals), [["stumble", "question", "overtime"], ["question"]]);
  assert.match(await fs.readFile(second.json.report_file, "utf8"), /## 连续两场被标记的页\n\n- 第 2 页「一份页面定义，两种交付载体」[\s\S]*建议：观众有疑问/);
  project = await readProject(root);
  const hint = inspectDeliveryFeedback(project);
  assert.equal(hint.status, "pending");
  assert.equal(hint.required, false, "repeated marks are advisory and never block review");
  assert.deepEqual(hint.evidence.repeated_pages.map((page) => page.page), [2]);
  assert.equal(latestRehearsedDuration(project.pages[1]).seconds, 20);
  const html = await buildHtml(project);
  const config = JSON.parse(html.match(/<script type="application\/json" id="deck-runtime-config">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(config.rehearsed, [{ seconds: 40, date: "2026-10-08" }, { seconds: 20, date: "2026-10-08" }]);
});

test("delivery-retro rejects invalid records and records from another project", async () => {
  const root = await tempDemo();
  const bad = path.join(path.dirname(root), "bad.json");
  await fs.writeFile(bad, JSON.stringify({ kind: "delivery_record" }));
  const invalid = runCli("delivery-retro", root, "--record", bad);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.json.error.code, "DELIVERY_RECORD_INVALID");
  assert.ok(invalid.json.error.details.errors.length > 3);
  const other = path.join(path.dirname(root), "other.json");
  await fs.writeFile(other, JSON.stringify(simulatedRecord({ project: "someone-else" })));
  const mismatch = runCli("delivery-retro", root, "--record", other);
  assert.equal(mismatch.json.error.code, "DELIVERY_RECORD_PROJECT_MISMATCH");
  assert.equal(runCli("delivery-retro", root).json.error.code, "OPTION_REQUIRED");
  const pages = JSON.parse(await fs.readFile(path.join(root, "pages.json"), "utf8"));
  assert.ok(pages.every((page) => page.delivery_feedback === undefined), "failed imports never touch pages.json");
});

test("V1 projects match delivered pages by PageSpec id", async () => {
  const source = await tempDemo("pptops-retro-v1-");
  const destination = path.join(path.dirname(source), "v1");
  await writeMigratedProject(source, destination);
  const project = await readProject(destination);
  assert.equal(project.contractModel, "v1");
  const ids = project.pages.map((page) => page.id);
  // Delivered when the pages were in the opposite order: ids, not numbers, decide the match.
  const record = simulatedRecord({ project: project.project.name, pages: [{ page: 1, id: ids[1], title: project.pages[1].screen_text.title }, { page: 2, id: ids[0], title: project.pages[0].screen_text.title }], marks: ["skipped"] });
  const analysis = analyzeDeliveryRecord(project, record);
  assert.deepEqual(analysis.rows.map((row) => [row.page, row.id]), [[2, ids[1]], [1, ids[0]]]);
  assert.deepEqual(analysis.skipped_pages, [1]);
  const file = path.join(path.dirname(source), "v1-record.json");
  await fs.writeFile(file, JSON.stringify(record));
  const result = runCli("delivery-retro", destination, "--record", file);
  assert.equal(result.status, 0, result.stderr);
  const pages = JSON.parse(await fs.readFile(path.join(destination, "pages.json"), "utf8"));
  assert.deepEqual(pages[0].delivery_feedback[0].marks, ["skipped"]);
  assert.equal(pages[0].delivery_feedback[0].skipped, true);
  assert.equal(pages[0].delivery_feedback[0].overtime, false, "skipped pages are never overtime");
  assert.equal(pages[1].delivery_feedback[0].actual_seconds, 40);
  assert.deepEqual(validateProject(await readProject(destination)), []);
});

test("presenter window records, marks and exports a valid record in a real browser", async (t) => {
  if (!await findBrowser()) return t.skip("Google Chrome or Chromium is unavailable");
  const project = await readProject(path.resolve("examples/demo-project"));
  project.pages.forEach((page, index) => { page.speaker_notes = `Notes ${index + 1}`; page.estimated_duration_seconds = 30; });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-retro-browser-"));
  const htmlFile = path.join(directory, "slides.html");
  await fs.writeFile(htmlFile, await buildHtml(project));
  const deckId = JSON.parse((await fs.readFile(htmlFile, "utf8")).match(/id="deck-runtime-config">([\s\S]*?)<\/script>/)[1]).deck_id;
  const evaluate = async (client, expression) => {
    const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await withHtmlPage({ htmlFile }, async (client) => {
    // Phase 1: the main deck owns the record. A BroadcastChannel peer plays the presenter window.
    await evaluate(client, `(() => {
      window.__states = []; window.__seq = 0;
      window.__peer = new BroadcastChannel("pptops-presenter:${deckId}");
      window.__peer.onmessage = (event) => { if (event.data.action === "state") window.__states.push(event.data); };
      window.__send = (action, payload) => window.__peer.postMessage(Object.assign({ protocol: "pptops-presenter", version: 1, deck: "${deckId}", sender: "test-presenter", seq: ++window.__seq, action }, payload || {}));
      window.__send("hello");
    })()`);
    await sleep(300);
    await evaluate(client, `window.__send("go", { index: 1 })`);
    await sleep(700);
    await evaluate(client, `window.__send("record", { command: "mark", index: 1, kind: "question" })`);
    await evaluate(client, `window.__send("record", { command: "meta", venue: "online", date: "2026-10-12", label: "cohort 3" })`);
    await evaluate(client, `window.__send("timer", { command: "pause" })`);
    await sleep(800); // paused: must not count
    await evaluate(client, `window.__send("timer", { command: "resume" })`);
    await sleep(300);
    await evaluate(client, `window.__send("go", { index: 0 })`);
    await sleep(200);
    const state = await evaluate(client, "window.__states.at(-1)");
    assert.ok(state.record, "deck broadcasts its record");
    assert.equal(state.record.venue, "online");
    assert.deepEqual(state.record.marks.map((mark) => [mark.index, mark.kind]), [[1, "question"]]);
    assert.deepEqual(state.record.visits.map((visit) => visit.index), [0, 1, 0]);
    const second = state.record.visits[1];
    const secondSeconds = (second.leave_ms - second.enter_ms) / 1000;
    assert.ok(secondSeconds > 0.8 && secondSeconds < 1.6, `page 2 talk time excludes the pause (${secondSeconds}s)`);
    const persisted = await evaluate(client, `JSON.parse(sessionStorage.getItem("pptops-presenter:${deckId}:record")).marks.length`);
    assert.equal(persisted, 1, "record survives a deck refresh via sessionStorage");

    // Phase 2: the presenter window marks with keys and exports a downloadable JSON record.
    const url = `${(await evaluate(client, "location.href")).split("?")[0]}?view=presenter`;
    await client.send("Page.navigate", { url });
    await sleep(500);
    await evaluate(client, `(() => {
      window.__blobs = []; const create = URL.createObjectURL.bind(URL); URL.createObjectURL = (blob) => { window.__blobs.push(blob); return create(blob); };
      window.__received = []; window.__seq = 0;
      window.__deck = new BroadcastChannel("pptops-presenter:${deckId}");
      window.__deck.onmessage = (event) => window.__received.push(event.data);
      window.__deck.postMessage({ protocol: "pptops-presenter", version: 1, deck: "${deckId}", sender: "test-deck", seq: ++window.__seq, action: "state", index: 1, count: 2, blackout: false, timer: ${JSON.stringify({ running: true, started_at: Date.now() - 5000, accumulated_ms: 0 })}, record: ${JSON.stringify(state.record)} });
    })()`);
    await sleep(200);
    assert.match(await evaluate(client, `document.querySelector('[data-p="marks"]').textContent`), /This slide: \? audience question/);
    assert.equal(await evaluate(client, `document.querySelector('[data-p="venue"]').value`), "online");
    for (const key of ["!", "x"]) {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key });
    }
    await sleep(200);
    const marks = await evaluate(client, `window.__received.filter((message) => message.action === "record").map((message) => [message.command, message.index, message.kind])`);
    assert.deepEqual(marks, [["mark", 1, "stumble"], ["mark", 1, "skipped"]]);
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "e", text: "e" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "e" });
    await sleep(200);
    const exported = JSON.parse(await evaluate(client, "window.__blobs.length ? window.__blobs[0].text() : null"));
    assert.deepEqual(validateDeliveryRecord(exported), []);
    assert.equal(exported.deck.project, "demo-presentation");
    assert.equal(exported.delivery.venue, "online");
    assert.equal(exported.delivery.label, "cohort 3");
    assert.deepEqual(exported.marks.map((mark) => [mark.page, mark.kind]), [[2, "question"]]);
    assert.match(await evaluate(client, `document.querySelector('[data-p="marks"]').textContent`), /Exported delivery-2026-10-12-online\.json/);
  });
});
