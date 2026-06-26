/**
 * start.js — single entry point for Railway
 *
 * Replaces `npm start` + concurrently with a plain node script
 * that spawns the three services as child processes.
 * Railway runs: node start.js
 */

const { spawn } = require("child_process");

const services = [
  { name: "SARDINE",    cmd: "node", args: ["mock-sardine/server.js"],   color: "\x1b[34m" },
  { name: "CONNECTOR",  cmd: "node", args: ["connector/index.js"],       color: "\x1b[33m" },
  { name: "SALESFORCE", cmd: "node", args: ["mock-salesforce/server.js"], color: "\x1b[32m" },
];

const reset = "\x1b[0m";

services.forEach(({ name, cmd, args, color }) => {
  const proc = spawn(cmd, args, { cwd: __dirname });

  proc.stdout.on("data", (data) => {
    data.toString().trim().split("\n").forEach(line => {
      console.log(`${color}[${name}]${reset} ${line}`);
    });
  });

  proc.stderr.on("data", (data) => {
    data.toString().trim().split("\n").forEach(line => {
      console.error(`${color}[${name}]${reset} ${line}`);
    });
  });

  proc.on("exit", (code) => {
    console.error(`[${name}] process exited with code ${code} — restarting in 2s`);
    setTimeout(() => {
      const r = spawn(cmd, args, { cwd: __dirname });
      console.log(`[${name}] restarted`);
    }, 2000);
  });
});

console.log("All services started");
