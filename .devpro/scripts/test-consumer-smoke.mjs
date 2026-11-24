#!/usr/bin/env node
import { runDoctor, formatReport } from "./devpro-doctor.mjs";

const report = await runDoctor({ consumerSmoke: true });
console.log(formatReport(report));
if (!report.ok) process.exitCode = 1;
