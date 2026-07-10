#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};

// src/bin/make-it-rain.ts
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var import_child_process = require("child_process");
var electronBinary;
try {
  electronBinary = require("electron");
} catch {
  console.error("Could not load Electron. Try: npm install -g @gceico/claude-make-it-rain");
  process.exit(1);
}
var scriptPath = fs.realpathSync(process.argv[1]);
var appPath = path.resolve(path.dirname(scriptPath), "..");
var foreground = process.argv.includes("--foreground");
var child = import_child_process.spawn(electronBinary, [appPath], {
  detached: !foreground,
  stdio: foreground ? "inherit" : "ignore",
  windowsHide: true
});
child.on("error", (err) => {
  console.error("Failed to start make-it-rain:", err.message);
  process.exit(1);
});
if (!foreground) {
  child.unref();
} else {
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}
