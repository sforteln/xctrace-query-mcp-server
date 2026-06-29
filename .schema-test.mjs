import { openTrace, getTable, getSchemaModel } from "./dist/engine/session.js";
import { findOne, summariseSchemas } from "./dist/engine/schemaModel.js";

const TRACE = process.env.HOME + "/Documents/modelAndTime.trace";

console.log("=== openTrace (builds schemaModel from TOC) ===");
const { sessionId, runs } = await openTrace(TRACE);
console.log(`runs: ${runs.length}, run 3 schemas: ${runs[2].schemas.slice(0,5).join(", ")}…`);

const model = getSchemaModel(sessionId);
console.log(`schemaModel entries: ${model.length}`);

// TOC metadata available immediately — no table fetch needed
const timeSample = findOne(model, 3, "time-sample");
console.log("\n--- time-sample TOC meta (run 3) ---");
console.log(`  documentation: ${timeSample?.toc.documentation}`);
console.log(`  callstack: ${timeSample?.toc.callstack}`);
console.log(`  sampleRateMicros: ${timeSample?.toc.sampleRateMicros}`);
console.log(`  cols before fetch: ${timeSample?.cols} (expected null)`);

const fmInference = findOne(model, 1, "ModelInferenceTable");
console.log("\n--- ModelInferenceTable TOC meta (run 1) ---");
console.log(`  swiftTable: ${fmInference?.toc.swiftTable}`);
console.log(`  cols before fetch: ${fmInference?.cols} (expected null)`);

const osSignpost = findOne(model, 1, "os-signpost");
console.log("\n--- os-signpost TOC meta (run 1) ---");
console.log(`  subsystem: ${osSignpost?.toc.subsystem}`);
console.log(`  category: ${osSignpost?.toc.category}`);
console.log(`  documentation: ${osSignpost?.toc.documentation}`);

// Now fetch a table and verify cols are populated
console.log("\n=== getTable populates cols lazily ===");
await getTable(sessionId, 3, "time-sample");
const afterFetch = findOne(model, 3, "time-sample");
console.log(`cols after fetch: ${afterFetch?.cols?.map(c => `${c.mnemonic}(${c.engineeringType})`).join(", ")}`);
console.log(`cols populated: ${afterFetch?.cols !== null ? "PASS ✓" : "FAIL ✗"}`);

// FM table still null (not fetched)
const fmAfter = findOne(model, 1, "ModelInferenceTable");
console.log(`ModelInferenceTable cols still null: ${fmAfter?.cols === null ? "PASS ✓" : "FAIL ✗"}`);

// summariseSchemas
console.log("\n=== summariseSchemas (unique schemas) ===");
const summary = summariseSchemas(model);
console.log(`unique schemas: ${summary.length}`);
const tsSummary = summary.find(s => s.schema === "time-sample");
console.log(`time-sample: runs=${JSON.stringify(tsSummary?.runs)}, hasCallstack=${tsSummary?.hasCallstack}, colCount=${tsSummary?.colCount}`);
const fmSummary = summary.find(s => s.schema === "ModelInferenceTable");
console.log(`ModelInferenceTable: isFoundationModels=${fmSummary?.isFoundationModels}, colCount=${fmSummary?.colCount} (null until fetched)`);
