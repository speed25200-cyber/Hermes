#!/usr/bin/env node
"use strict";

const path = require("path");
const { readLiveGate } = require(path.join(__dirname, "..", "modules", "live_safety.js"));

const root = path.join(__dirname, "..");
const status = readLiveGate(root);
console.log(JSON.stringify(status, null, 2));
process.exitCode = status.allowed ? 0 : 2;
