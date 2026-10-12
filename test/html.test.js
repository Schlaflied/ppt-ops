import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildHtml } from "../src/adapters/html.js";
import { readProject } from "../src/core/project.js";

test("buildHtml creates a deterministic self-contained semantic deck", async () => {
  const project = await readProject(path.resolve("examples/demo-project"));
  const first = await buildHtml(project);
  const second = await buildHtml(project);

  assert.equal(first, second);
  assert.match(first, /^<!doctype html>/);
  assert.match(first, /width:1920px;height:1080px/);
  assert.match(first, /<main class="stage"/);
  assert.equal((first.match(/<section class="slide /g) ?? []).length, project.pages.length);
  assert.match(first, /<progress value="1" max="2"/);
  assert.match(first, /ArrowRight/);
  assert.match(first, /data-nav="fullscreen"/);
  assert.match(first, /requestFullscreen\|\|document\.documentElement\.webkitRequestFullscreen/);
  assert.match(first, /lower === "f"\) return "fullscreen"/);
  assert.match(first, /prefers-reduced-motion:reduce/);
  assert.match(first, /data:image\/svg\+xml;base64,/);
  assert.match(first, /data-asset-id="workflow-mark"/);
  assert.doesNotMatch(first, /(?:src|href)="(?:\.\/|assets\/)/);
  // First and final pages are ordinary pages: no forced image-dominant, title-only layout.
  assert.doesNotMatch(first, /boundary-image-dominant|boundary-slide|boundary-active/);
  const slides = [...first.matchAll(/<section class="slide [\s\S]*?<\/section>/g)].map((match) => match[0]);
  assert.match(slides.at(-1), /HTML：预览与分享/);
  assert.match(slides.at(-1), /slide-footer/);
});

test("buildHtml escapes shared text and asset labels", async () => {
  const project = await readProject(path.resolve("examples/demo-project"));
  project.project.title = '<unsafe & "title">';
  project.pages[0].screen_text.title = "<script>alert('x')</script>";
  project.assets[0].alt = 'mark "quoted"';
  const html = await buildHtml(project);

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(html, /mark &quot;quoted&quot;/);
});

test("buildHtml rejects assets outside the project root", async () => {
  const project = await readProject(path.resolve("examples/demo-project"));
  project.assets[0].file = "../outside.svg";
  await assert.rejects(buildHtml(project), /asset escapes project root/);
});
