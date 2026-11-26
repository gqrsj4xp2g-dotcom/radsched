const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const site = path.resolve(process.env.RAD_PACKAGE_DIR || root);
const read = name => fs.readFileSync(path.join(site, name), "utf8");
const index = read("index.html");
const manifest = JSON.parse(read("manifest.webmanifest"));
const worker = vm.createContext({ self: { addEventListener() {} } });
vm.runInContext(read("sw.js"), worker);
const shell = vm.runInContext("SHELL", worker);
const workerPath = index.match(/function _serviceWorkerScriptUrl\(\)\s*\{[^}]+\}/)[0];
const edgePaths = index.match(/const _EDGE_FN_SOURCE_PATHS = \{([\s\S]*?)\};/)[1];
const setup = Array.from(edgePaths.matchAll(/'([^']+)':\s*'([^']+)'/g));

test("the release includes the app, recovery page, offline assets and admin setup sources at both mount points", () => {
  assert.deepEqual(setup.map(match => match[1]).sort(), ["admin-ops", "create-user", "send-notification"]);
  const linked = Array.from(index.matchAll(/(?:src|href)="((?:icons\/|vendor\/)[^"]+|manifest\.webmanifest|reset\.html)"/g), m => m[1]);
  // SheetJS is loaded on first use by _rsLoadXLSX, not by a <head> tag. Its
  // same-origin path must stay page-relative and be the file sw.js precaches.
  const lazyXlsx = index.match(/_rsXlsxLoading = add\('([^']+)'\)/)[1];
  assert.ok(shell.includes("./" + lazyXlsx), lazyXlsx + " is not precached by sw.js");
  linked.push(lazyXlsx);
  for (const base of ["https://radsched.org/", "https://example.github.io/radsched/"]) {
    for (const entry of ["", "index.html", "#/dr-cal"]) {
      const location = new URL(entry, base);
      const url = vm.runInNewContext(workerPath + "\n_serviceWorkerScriptUrl()", { URL, location });
      assert.equal(url, new URL("sw.js", base).href);
      assert.equal(new URL(".", url).href, base);
    }
    assert.equal(new URL(manifest.start_url, base).href, base);
    assert.equal(new URL(manifest.scope, base).href, base);
    for (const shortcut of manifest.shortcuts) {
      const url = new URL(shortcut.url, base);
      assert.equal(url.pathname, new URL(base).pathname);
      assert.match(url.hash, /^#\/[\w-]+$/);
      assert.ok(index.includes('id="page-' + url.hash.slice(2) + '"'), shortcut.name);
    }
    const assets = new Set(["index.html", "reset.html", "404.html", "sw.js", "robots.txt", "_headers", ...linked, ...shell,
      ...manifest.icons.map(icon => icon.src), ...setup.map(match => match[2])]);
    for (const asset of assets) {
      const url = new URL(asset, base);
      assert.ok(url.href.startsWith(base), asset + " escapes the project mount");
      const file = url.href.slice(base.length) || "index.html";
      assert.ok(fs.statSync(path.join(site, file)).size > 0, file);
      if (site !== root) assert.deepEqual(fs.readFileSync(path.join(site, file)), fs.readFileSync(path.join(root, file)), file);
    }
  }
});

test("404 recovery points back to the project and Vercel clean URLs target the public shell", () => {
  const script = read("404.html").match(/<script>([\s\S]*?)<\/script\s*>/i)[1];
  for (const [url, expected] of [["https://radsched.org/old/path", "/"], ["https://example.github.io/radsched/old/path", "/radsched/"]]) {
    const link = {};
    vm.runInNewContext(script, { location: new URL(url), document: { getElementById: () => link }, setTimeout() {} });
    assert.equal(link.href, expected);
  }
  const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal(vercel.cleanUrls, true);
  assert.ok(vercel.rewrites.some(rule => rule.destination === "/"));
  assert.equal(vercel.outputDirectory, "_site");
});
