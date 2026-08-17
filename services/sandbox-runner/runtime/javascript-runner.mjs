import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";

const entrypoint = process.argv[2];
if (!entrypoint?.startsWith("/workspace/")) throw new Error("Invalid JavaScript entrypoint");

const stderrConsole = (...values) => {
  process.stderr.write(`${values.map((value) => typeof value === "string" ? value : inspect(value)).join(" ")}\n`);
};
console.log = stderrConsole;
console.info = stderrConsole;
console.debug = stderrConsole;
console.warn = stderrConsole;

const input = JSON.parse(readFileSync(0, "utf8"));
const skillModule = await import(pathToFileURL(entrypoint).href);
const main = typeof skillModule.default === "function" ? skillModule.default : skillModule.main;
if (typeof main !== "function") throw new Error("JavaScript Skill must export default or main function");
const output = await main(input);
process.stdout.write(JSON.stringify(output ?? null));
